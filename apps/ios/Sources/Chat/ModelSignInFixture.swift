import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// A local stand-in for the server's provider sign-in, for screenshots and UI tests. Launch with
/// `--openclaw-model-sign-in-fixture <scenario>`:
/// - `ordinary`, `read-only`, `empty`: five providers, one in each state, and a login of each step kind.
/// - `signed-in`: the same five, all signed in.
/// - `no-accounts`: nothing to sign in to. `old-server`: no native sign-in. `load-failed`: status fails.
/// - `refresh-failed`: the first reload fails after status has loaded.
/// - `refresh-not-ready`: the first reload receives the Gateway's not-ready status.
/// - `post-login-check-failed`: the first status check after sign-in fails.
/// - `loading`: status never answers. `connection-changed`: the connection goes away once a login starts.
/// No credential leaves the app; nothing here talks to a provider.
@MainActor
final class ModelSignInFixture {
    static let shared = ModelSignInFixture()

    private enum Login: String {
        case xaiKey = "xai-api-key"
        case googleBrowser = "google-oauth"
        case anthropicBrowser = "anthropic-oauth"
        case openRouterDevice = "openrouter-device"
        case openRouterKey = "openrouter-api-key"
    }

    private var signedIn: Set<String> = ScreenshotFixtureMode.modelSignInScenario == "signed-in"
        ? ["openai", "anthropic", "google", "xai", "openrouter"] : ["openai", "anthropic"]
    private var expired: Set<String> = ScreenshotFixtureMode.modelSignInScenario == "signed-in" ? [] : ["google"]
    private var sessions: [String: (login: Login, stage: Int)] = [:]
    private var current = true
    private var statusRequests = 0
    private let scenario = ScreenshotFixtureMode.modelSignInScenario ?? ""

    var supportsSignIn: Bool {
        self.scenario != "old-server"
    }

    /// Providers whose models wait on a sign-in, for the model catalog.
    var providersNeedingSignIn: [String] {
        ["xai"].filter { !self.signedIn.contains($0) }
    }

    func context(agentID: String) -> OpenClawChatModelSignInContext {
        OpenClawChatModelSignInContext(
            agentID: agentID,
            request: { method, params in try await self.request(method, params) },
            isCurrent: { self.current })
    }

    private func request(_ method: String, _ params: [String: AnyCodable]) async throws -> Data {
        switch method {
        case "models.authStatus":
            self.statusRequests += 1
            let failsOnce = self.scenario == "refresh-failed" || self.scenario == "post-login-check-failed"
            if self.scenario == "load-failed" || (failsOnce && self.statusRequests == 2) {
                throw GatewayResponseError(
                    method: method, code: "UNAVAILABLE", message: "Fixture status failure", details: [:])
            }
            if self.scenario == "refresh-not-ready", self.statusRequests == 2 {
                return Data(#"{"providers":[],"unavailable":{"code":"PREPARED_MODEL_AUTH_UNAVAILABLE"}}"#.utf8)
            }
            if self.scenario == "loading" {
                try await Task.sleep(for: .seconds(600))
            }
            return try JSONSerialization.data(withJSONObject: self.status())
        case "models.authLogin":
            guard let id = params["sessionId"]?.stringValue,
                  let login = Login(rawValue: params["authChoice"]?.stringValue ?? "")
            else { throw CancellationError() }
            try await Task.sleep(for: .milliseconds(600))
            if login == .openRouterKey {
                throw GatewayResponseError(
                    method: method, code: "UNAVAILABLE", message: "Fixture start failure", details: [:])
            }
            if self.scenario == "connection-changed" { self.current = false }
            self.sessions[id] = (login, 0)
            return try JSONEncoder().encode(WizardStartResult(sessionid: id, done: false, step: self.step(login, 0)))
        case "wizard.next":
            return try await self.next(params)
        case "wizard.cancel":
            if let id = params["sessionId"]?.stringValue { self.sessions[id] = nil }
            return Data(#"{"status":"cancelled"}"#.utf8)
        case "models.authLogout":
            try await Task.sleep(for: .milliseconds(ScreenshotFixtureMode.modelSignInAnswerMilliseconds + 300))
            if let provider = params["provider"]?.stringValue {
                self.signedIn.remove(provider)
                self.signedOut.insert(provider)
            }
            return Data(#"{"provider":"openai","removedProfiles":[],"abortedRunIds":[]}"#.utf8)
        default:
            throw CancellationError()
        }
    }

    private func next(_ params: [String: AnyCodable]) async throws -> Data {
        guard let id = params["sessionId"]?.stringValue, let session = self.sessions[id] else {
            throw GatewayResponseError(
                method: "wizard.next",
                code: "WIZARD_NOT_FOUND",
                message: "Gone",
                details: ["code": AnyCodable("WIZARD_NOT_FOUND")])
        }
        let answer = params["answer"]?.dictionaryValue?["value"]
        try await Task.sleep(for: .milliseconds(ScreenshotFixtureMode.modelSignInAnswerMilliseconds))
        let stage = session.stage + 1
        switch (session.login, session.stage) {
        case (.xaiKey, 0):
            let key = answer?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
            if key.isEmpty {
                return try self.encode(WizardNextResult(
                    done: false, step: self.step(.xaiKey, 0), error: "Paste a key to continue."))
            }
            self.sessions[id] = nil
            if key == "bad-key" {
                return try self.encode(WizardNextResult(
                    done: true, status: AnyCodable("error"), error: "xAI didn’t accept this key."))
            }
            return try self.finish(id, provider: "xai")
        case (.googleBrowser, 0), (.anthropicBrowser, 0):
            self.sessions[id] = (session.login, stage)
            return try self.encode(WizardNextResult(done: false, step: self.step(session.login, stage)))
        case (.googleBrowser, 1), (.anthropicBrowser, 1):
            // The person finishes in the browser; the server answers when the provider calls back.
            guard try await self.waitForProvider(id) else { return try self.cancelled() }
            return try self.finish(id, provider: session.login == .googleBrowser ? "google" : "anthropic")
        case (.openRouterDevice, 0):
            guard try await self.waitForProvider(id) else { return try self.cancelled() }
            self.sessions[id] = (session.login, stage)
            return try self.encode(WizardNextResult(done: false, step: self.step(.openRouterDevice, stage)))
        case (.openRouterDevice, 1):
            self.sessions[id] = (session.login, stage)
            return try self.encode(WizardNextResult(done: false, step: self.step(.openRouterDevice, stage)))
        case (.openRouterDevice, _):
            return try self.finish(id, provider: "openrouter")
        default:
            return try self.finish(id, provider: "")
        }
    }

    /// Waits as the server does for the provider, and stops early when the sign-in is cancelled.
    private func waitForProvider(_ id: String) async throws -> Bool {
        for _ in 0..<(ScreenshotFixtureMode.modelSignInWaitSeconds * 4) {
            try await Task.sleep(for: .milliseconds(250))
            if self.sessions[id] == nil { return false }
        }
        return true
    }

    private func cancelled() throws -> Data {
        try self.encode(WizardNextResult(done: true, status: AnyCodable("cancelled")))
    }

    private func finish(_ id: String, provider: String) throws -> Data {
        self.sessions[id] = nil
        self.signedIn.insert(provider)
        self.expired.remove(provider)
        self.renewed.insert(provider)
        self.signedOut.remove(provider)
        return try self.encode(WizardNextResult(done: true, status: AnyCodable("done")))
    }

    private func encode(_ result: WizardNextResult) throws -> Data {
        try JSONEncoder().encode(result)
    }

    private func step(_ login: Login, _ stage: Int) -> WizardStep {
        switch (login, stage) {
        case (.xaiKey, _), (.openRouterKey, _):
            WizardStep(
                id: "xai-key",
                type: AnyCodable("text"),
                title: "xAI API key",
                message: "Create a key in the xAI console, then paste it here.",
                placeholder: "xai-…",
                sensitive: true,
                executor: AnyCodable("client"))
        case (.googleBrowser, 0), (.anthropicBrowser, 0):
            WizardStep(
                id: "\(login.rawValue)-open",
                type: AnyCodable("note"),
                message: "Sign in on the provider’s page, then come back here.",
                executor: AnyCodable("client"),
                externalurl: login == .googleBrowser ? "https://accounts.google.com/" : "https://claude.ai/login")
        case (.googleBrowser, _), (.anthropicBrowser, _):
            WizardStep(
                id: "\(login.rawValue)-wait",
                type: AnyCodable("progress"),
                message: "Waiting for you to finish in the browser…",
                executor: AnyCodable("gateway"))
        case (.openRouterDevice, 0):
            WizardStep(
                id: "openrouter-code",
                type: AnyCodable("progress"),
                executor: AnyCodable("gateway"),
                externalurl: "https://openrouter.ai/device",
                devicecode: [
                    "code": AnyCodable("WXYZ-2345"),
                    "message": AnyCodable("Enter this code on the OpenRouter page. It expires in 15 minutes."),
                ])
        case (.openRouterDevice, 1):
            WizardStep(
                id: "openrouter-confirm",
                type: AnyCodable("confirm"),
                message: "Use this OpenRouter account for OpenClaw?",
                initialvalue: AnyCodable(true),
                executor: AnyCodable("client"))
        case (.openRouterDevice, _):
            WizardStep(
                id: "openrouter-route",
                type: AnyCodable("select"),
                message: "Which models should OpenClaw reach through OpenRouter?",
                options: [
                    ["value": AnyCodable("all"), "label": AnyCodable("All models")],
                    ["value": AnyCodable("free"), "label": AnyCodable("Free models only")],
                ],
                initialvalue: AnyCodable("all"),
                executor: AnyCodable("client"))
        }
    }

    private func status() -> [String: Any] {
        if self.scenario == "no-accounts" {
            return ["ts": 1, "providers": [], "providerCapabilities": []]
        }
        let now = Date().timeIntervalSince1970 * 1000
        let soon = now + 2 * 86_400_000
        let past = now - 86_400_000
        func expiry(_ at: Double) -> [String: Any] {
            ["at": at, "remainingMs": at - now, "label": "2d"]
        }
        func profile(_ id: String, _ type: String, _ status: String, at: Double? = nil) -> [String: Any] {
            var entry: [String: Any] = ["profileId": id, "type": type, "status": status, "logoutSupported": true]
            if let at { entry["expiry"] = expiry(at) }
            return entry
        }
        func provider(
            _ id: String,
            _ name: String,
            _ status: String,
            _ profiles: [[String: Any]] = []) -> [String: Any]
        {
            var entry: [String: Any] = ["provider": id, "displayName": name, "status": status, "profiles": profiles]
            if status == "expiring" { entry["expiry"] = expiry(soon) }
            if status == "expired" { entry["expiry"] = expiry(past) }
            return entry
        }
        var openAI = profile("openai:work", "oauth", "ok")
        openAI["email"] = "work@example.com"
        var providers = [
            self.signedIn.contains("openai")
                ? provider("openai", "OpenAI", "ok", [openAI])
                : provider("openai", "OpenAI", "missing"),
            self.renewed.contains("anthropic")
                ? provider("anthropic", "Anthropic", "ok", [profile("anthropic:default", "token", "ok")])
                : provider("anthropic", "Anthropic", "expiring", [
                    profile("anthropic:default", "token", "expiring", at: soon),
                ]),
            self.expired.contains("google")
                ? provider("google", "Google", "expired", [profile("google:default", "oauth", "expired", at: past)])
                : provider("google", "Google", "ok", [profile("google:default", "oauth", "ok")]),
            self.signedIn.contains("xai")
                ? provider("xai", "xAI", "ok", [profile("xai:default", "api_key", "ok")])
                : provider("xai", "xAI", "missing"),
        ]
        providers = providers.map { entry in
            guard let id = entry["provider"] as? String, self.signedOut.contains(id) else { return entry }
            return provider(id, entry["displayName"] as? String ?? id, "missing")
        }
        if self.signedIn.contains("openrouter") {
            providers.append(provider("openrouter", "OpenRouter", "ok", [profile("openrouter:default", "oauth", "ok")]))
        }
        func option(_ login: Login, _ label: String, _ hint: String?) -> [String: Any] {
            var entry: [String: Any] = ["id": login.rawValue, "brandId": login.rawValue, "label": label]
            if let hint { entry["hint"] = hint }
            return entry
        }
        func capability(_ provider: String, _ options: [[String: Any]]) -> [String: Any] {
            ["provider": provider, "apiKeySupported": true, "quickApiKeySetup": false, "loginOptions": options]
        }
        var anthropicOptions = [option(.anthropicBrowser, "Claude subscription", "Sign in with your Claude account")]
        if self.scenario == "refresh-failed" || self.scenario == "refresh-not-ready" {
            // Give the simulator an actual scroll surface so the gesture tests the list, not the sheet detent.
            anthropicOptions += (1...12).map { ["id": "fixture-anthropic-\($0)", "label": "Fixture option \($0)"] }
        }
        let capabilities = [
            capability("anthropic", anthropicOptions),
            capability("google", [option(.googleBrowser, "Google account", "Sign in in your browser")]),
            capability("xai", [option(.xaiKey, "API key", "Paste a key from the xAI console")]),
            capability("openrouter", [
                option(.openRouterDevice, "OpenRouter account", "Sign in with a one-time code"),
                option(.openRouterKey, "API key", nil),
            ]),
        ]
        return ["ts": now, "providers": providers, "providerCapabilities": capabilities]
    }

    /// Providers signed in again here: Anthropic stops expiring once renewed.
    private var renewed: Set<String> = ScreenshotFixtureMode.modelSignInScenario == "signed-in" ? ["anthropic"] : []
    private var signedOut: Set<String> = []
}
