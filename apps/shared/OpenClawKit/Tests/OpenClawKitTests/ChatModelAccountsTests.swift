import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatModelAccountsTests {
    private func status(_ json: String) throws -> ChatModelAuthStatus {
        try JSONDecoder().decode(ChatModelAuthStatus.self, from: Data(json.utf8))
    }

    @Test func `signed-in providers come first and say nothing unless something needs attention`() throws {
        let groups = try ChatModelAccountGroups(status: self.status(#"""
        {"providers":[
          {"provider":"openai","displayName":"OpenAI","status":"ok"},
          {"provider":"zai","displayName":"Z.AI","status":"static","apiKey":{"source":"env"}},
          {"provider":"anthropic","displayName":"Anthropic","status":"expiring","expiry":{"at":1900000000000}},
          {"provider":"google","displayName":"Google","status":"expired"},
          {"provider":"xai","displayName":"xAI","status":"missing"}
        ],
        "providerCapabilities":[
          {"provider":"xai","loginOptions":[{"id":"xai-key","label":"API key"}]},
          {"provider":"openrouter","loginOptions":[{"id":"or-device","label":"OpenRouter account","groupLabel":"OpenRouter"}]}
        ]}
        """#))

        #expect(groups.signedIn.map(\.id) == ["anthropic", "google", "openai", "zai"])
        #expect(groups.notSignedIn.map(\.id) == ["openrouter", "xai"])
        #expect(groups.signedIn.first { $0.id == "openai" }?.notice == nil)
        #expect(groups.signedIn.first { $0.id == "zai" }?.notice == nil)
        #expect(groups.signedIn.first { $0.id == "zai" }?.source == .environmentKey)
        #expect(groups.signedIn.first { $0.id == "anthropic" }?.notice
            == .expiresSoon(Date(timeIntervalSince1970: 1_900_000_000)))
        #expect(groups.signedIn.first { $0.id == "google" }?.notice == .expired)
        #expect(groups.notSignedIn.first { $0.id == "xai" }?.options.map(\.id) == ["xai-key"])
        // A provider the server only offers a sign-in for takes its options' brand name.
        #expect(groups.notSignedIn.first { $0.id == "openrouter" }?.name == "OpenRouter")
    }

    @Test func `an expiry at or before now reads as expired`() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(ChatModelAccount.Notice.expiring(at: now.addingTimeInterval(-5), now: now) == .expired)
        #expect(ChatModelAccount.Notice.expiring(at: now, now: now) == .expired)
        #expect(ChatModelAccount.Notice.expiring(at: now.addingTimeInterval(60), now: now)
            == .expiresSoon(now.addingTimeInterval(60)))
        #expect(ChatModelAccount.Notice.expiring(at: nil, now: now) == .expiresSoon(nil))
        // The server still says "expiring" for a sign-in whose time already passed.
        let groups = try ChatModelAccountGroups(status: self.status(#"""
        {"providers":[{"provider":"anthropic","displayName":"Anthropic","status":"expiring","expiry":{"at":1000}}]}
        """#))
        #expect(groups.signedIn.first?.notice == .expired)
    }

    @Test func `a provider every model reports as failed shows sign-in failed`() throws {
        let groups = try ChatModelAccountGroups(
            status: self.status(#"{"providers":[{"provider":"openai","displayName":"OpenAI","status":"ok"}]}"#),
            failedProviders: ["OpenAI"])
        #expect(groups.signedIn.first?.notice == .failed)
    }

    @Test func `options follow the credential owner and the account answers to either id`() throws {
        let groups = try ChatModelAccountGroups(status: self.status(#"""
        {"providers":[{"provider":"claude-cli","authProvider":"anthropic","displayName":"Claude","status":"missing"}],
         "providerCapabilities":[{"provider":"anthropic","loginOptions":[{"id":"a","label":"Claude subscription"}]}]}
        """#))
        #expect(groups.notSignedIn.count == 1)
        #expect(groups.notSignedIn.first?.options.map(\.id) == ["a"])
        #expect(groups.account("anthropic")?.id == "claude-cli")
        #expect(groups.account("claude-cli")?.id == "claude-cli")
        #expect(groups.account("openai") == nil)
    }

    @Test func `an exact provider id takes priority over an earlier credential alias`() throws {
        let groups = try ChatModelAccountGroups(status: self.status(#"""
        {"providers":[
          {"provider":"minimax-cn","authProvider":"minimax","displayName":"MiniMax China","status":"ok"},
          {"provider":"minimax","displayName":"MiniMax Global","status":"missing"}
        ]}
        """#))
        #expect(groups.account("minimax")?.id == "minimax")
        #expect(groups.account("minimax-cn")?.id == "minimax-cn")
    }

    @Test func `only sign-ins the server can remove can be signed out`() throws {
        let groups = try ChatModelAccountGroups(status: self.status(#"""
        {"providers":[{"provider":"openai","displayName":"OpenAI","status":"ok","profiles":[
          {"profileId":"saved","type":"oauth","status":"ok","logoutSupported":true},
          {"profileId":"cli","type":"oauth","status":"ok"}
        ]}]}
        """#))
        #expect(groups.signedIn.first?.removableProfileIDs == ["saved"])
    }

    @Test func `a provider the server names by its id takes the app's brand name`() throws {
        let groups = try ChatModelAccountGroups(status: self.status(
            #"{"providers":[{"provider":"openai","displayName":"openai","status":"static"}]}"#))
        #expect(groups.signedIn.first?.name == "OpenAI")
    }

    @Test func `providers the server can't sign in to are not listed`() throws {
        let groups = try ChatModelAccountGroups(status: self.status(#"""
        {"providers":[],"providerCapabilities":[{"provider":"groq","loginOptions":[]},{"provider":"zai"}]}
        """#))
        #expect(groups.isEmpty)
    }

    @Test func `an empty status has no accounts`() throws {
        #expect(try ChatModelAccountGroups(status: self.status(#"{"providers":[]}"#)).isEmpty)
    }

    @Test func `a provider needs sign-in only when none of its models can be used without one`() throws {
        func section(_ models: [(Bool?, String?)]) throws -> ChatModelProviderSection {
            let entries: [[String: Any]] = models.enumerated().map { index, model in
                var entry: [String: Any] = ["id": "m\(index)", "name": "M\(index)", "provider": "p"]
                if let available = model.0 { entry["available"] = available }
                if let reason = model.1 { entry["unavailableReason"] = reason }
                return entry
            }
            let data = try JSONSerialization.data(withJSONObject: ["models": entries])
            let choices = try OpenClawChatGatewayPayloadCodec.decodeModelChoices(data)
            return ChatModelProviderSection(id: "p", displayName: "P", models: choices, isDefaultProvider: false)
        }
        #expect(try section([(false, "missing-auth"), (false, "missing-auth")]).signInNeed == .missingAuth)
        #expect(try section([(false, "missing-auth"), (false, "auth-failed")]).signInNeed == .authFailed)
        #expect(try section([(false, "missing-auth"), (true, nil)]).signInNeed == nil)
        #expect(try section([(false, "missing-auth"), (false, "cooldown")]).signInNeed == nil)
        #expect(try section([]).signInNeed == nil)
    }
}

@MainActor
struct ChatModelSignOutTests {
    @Test func `sign-out removes the saved sign-ins and reads status again`() async {
        var signedIn = true
        var logoutParams: [String: AnyCodable]?
        var catalogRefreshes = 0
        let context = OpenClawChatModelSignInContext(
            agentID: "main",
            request: { method, params in
                switch method {
                case "models.authStatus":
                    let status = signedIn ? "ok" : "missing"
                    return Data(#"{"providers":[{"provider":"openai","displayName":"OpenAI","status":"\#(status)"}]}"#
                        .utf8)
                case "models.authLogout":
                    logoutParams = params
                    signedIn = false
                    return Data(#"{"provider":"openai","removedProfiles":["openai:work"],"abortedRunIds":[]}"#.utf8)
                default:
                    Issue.record("Unexpected request: \(method)")
                    throw CancellationError()
                }
            },
            isCurrent: { true })
        let model = ChatModelSignInModel(context: context, onAuthChanged: { catalogRefreshes += 1 })
        await model.refresh()
        await model.signOut(provider: "openai", profileIDs: ["openai:work"])

        #expect(logoutParams?["provider"]?.stringValue == "openai")
        #expect(logoutParams?["agentId"]?.stringValue == "main")
        #expect((logoutParams?["profileIds"]?.value as? [AnyCodable])?.map(\.stringValue) == ["openai:work"])
        #expect(model.authStatus?.providers.first?.status == "missing")
        #expect(model.outcome == nil)
        #expect(model.signingOut == nil)
        #expect(catalogRefreshes == 1)
    }

    @Test func `a failed sign-out says so and keeps the account`() async {
        let context = OpenClawChatModelSignInContext(
            agentID: "main",
            request: { method, _ in
                if method == "models.authStatus" {
                    return Data(#"{"providers":[{"provider":"openai","displayName":"OpenAI","status":"ok"}]}"#.utf8)
                }
                throw GatewayResponseError(method: method, code: "FORBIDDEN", message: "No", details: nil)
            },
            isCurrent: { true })
        let model = ChatModelSignInModel(context: context, onAuthChanged: {})
        await model.refresh()
        await model.signOut(provider: "openai", profileIDs: ["openai:work"])
        #expect(model.outcome == .signOutFailed)
        #expect(model.authStatus?.providers.first?.status == "ok")
        #expect(!model.busy)
    }
}
