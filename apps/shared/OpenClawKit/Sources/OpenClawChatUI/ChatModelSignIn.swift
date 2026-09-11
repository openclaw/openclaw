import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import SwiftUI

/// Requests stay bound to the agent and physical connection captured when the sheet opens.
public struct OpenClawChatModelSignInContext: Sendable {
    public let agentID: String
    public let request: @MainActor @Sendable (String, [String: AnyCodable]) async throws -> Data
    public let closeWizard: @MainActor @Sendable (String) async throws -> Data
    public let isCurrent: @MainActor @Sendable () async -> Bool

    public init(
        agentID: String,
        request: @escaping @MainActor @Sendable (String, [String: AnyCodable]) async throws -> Data,
        closeWizard: @escaping @MainActor @Sendable (String) async throws -> Data,
        isCurrent: @escaping @MainActor @Sendable () async -> Bool)
    {
        self.agentID = agentID
        self.request = request
        self.closeWizard = closeWizard
        self.isCurrent = isCurrent
    }
}

struct ChatModelAuthStatus: Decodable {
    struct Capability: Decodable {
        let loginOptions: [LoginOption]?
    }

    struct LoginOption: Decodable, Identifiable {
        let id: String
        let label: String
        let hint: String?
    }

    struct Provider: Decodable, Identifiable {
        let provider: String
        let displayName: String
        let status: String
        var id: String {
            self.provider
        }

        var statusLabel: String {
            switch self.status {
            case "ok", "static": String(localized: "Connected")
            case "expiring": String(localized: "Sign-in expires soon")
            case "expired": String(localized: "Sign-in expired")
            case "missing": String(localized: "Sign-in needed")
            default: String(localized: "Status unavailable")
            }
        }
    }

    let providers: [Provider]
    let providerCapabilities: [Capability]?
    let unavailable: [String: AnyCodable]?

    var loginOptions: [LoginOption] {
        var seen = Set<String>()
        return (self.providerCapabilities ?? []).flatMap { $0.loginOptions ?? [] }
            .filter { seen.insert($0.id).inserted }
    }
}

@MainActor
@Observable
final class ChatModelSignInModel {
    private(set) var authStatus: ChatModelAuthStatus?
    private(set) var step: WizardStep?
    private(set) var sessionID: String?
    private(set) var busy = false
    private(set) var cancelling = false
    private(set) var message: String?
    var text = ""
    var selection = 0
    var confirmation = false
    private let context: OpenClawChatModelSignInContext
    private let onAuthChanged: @MainActor () async -> Void
    private var closed = false
    private var cancelRequested = false

    init(context: OpenClawChatModelSignInContext, onAuthChanged: @escaping @MainActor () async -> Void) {
        self.context = context
        self.onAuthChanged = onAuthChanged
    }

    func refresh() async {
        guard !self.busy, self.sessionID == nil, !self.closed else { return }
        self.busy = true
        defer { self.busy = false }
        do {
            try await self.readStatus()
        } catch {
            self
                .message =
                String(
                    localized: "Could not load sign-in options. Check the connection or update your Gateway.")
        }
    }

    func start(_ option: ChatModelAuthStatus.LoginOption) async {
        guard !self.busy, !self.closed, self.sessionID == nil,
              self.authStatus?.loginOptions.contains(where: { $0.id == option.id }) == true
        else { return }
        let id = UUID().uuidString
        self.sessionID = id
        self.cancelRequested = false
        self.message = nil
        self.step = nil
        await self.run(id) {
            let data: Data
            do {
                guard await self.context.isCurrent(), !self.closed else { throw CancellationError() }
                data = try await self.context.request("models.authLogin", [
                    "sessionId": AnyCodable(id), "agentId": AnyCodable(self.context.agentID),
                    "authChoice": AnyCodable(option.id),
                ])
            } catch let error as GatewayResponseError {
                if error.detailsReason == "EXPECTED_PROFILE_MISMATCH",
                   error.details["execution"]?.stringValue == "may_have_executed"
                {
                    // Response fencing can hide an admitted wizard. Retain its
                    // captured id until cleanup succeeds, without publishing auth state.
                    _ = try await self.context.closeWizard(id)
                }
                if self.sessionID == id { self.sessionID = nil }
                self
                    .message =
                    String(localized: "Sign-in could not start. Refresh the options or use Models in the Dashboard.")
                throw error
            } catch let error as GatewayNodeSessionRequestError {
                if self.sessionID == id { self.sessionID = nil }
                self.message = String(localized: "The connection changed. Close sign-in and open it again.")
                throw error
            }
            let result = try JSONDecoder().decode(WizardStartResult.self, from: data)
            if self.closed || self.cancelRequested {
                try await self.closeSession(id)
            } else {
                guard await self.context.isCurrent(), !self.closed else { throw CancellationError() }
                try await self.advance(id, result: WizardNextResult(
                    done: result.done, step: result.step, status: result.status, error: result.error))
            }
        }
    }

    func answer() async {
        guard let id = self.sessionID, !self.busy, !self.cancelling, !self.closed else { return }
        var params = ["sessionId": AnyCodable(id)]
        if let step = self.step, wizardStepExecutor(step) != "gateway" {
            let value: AnyCodable? = switch wizardStepType(step) {
            case "text": AnyCodable(self.text)
            case "confirm": AnyCodable(self.confirmation)
            case "select": parseWizardOptions(step.options).indices.contains(self.selection)
                ? parseWizardOptions(step.options)[self.selection].value : nil
            default: nil
            }
            var answer = ["stepId": AnyCodable(step.id)]
            if let value { answer["value"] = value }
            params["answer"] = AnyCodable(answer)
        }
        await self.run(id) {
            let data = try await self.request("wizard.next", params)
            try await self.advance(id, result: JSONDecoder().decode(WizardNextResult.self, from: data))
        }
    }

    func cancel() async {
        guard let id = self.sessionID, !self.cancelling else { return }
        self.cancelRequested = true
        self.cancelling = true
        defer { self.cancelling = false }
        do {
            try await self.closeSession(id)
        } catch let error as GatewayResponseError
            where error.details["code"]?.stringValue == "WIZARD_NOT_FOUND" && !self.busy
        {
            if await self.retireIfContextLost(id) { return }
            await self.finish(id, status: nil, error: nil)
        } catch {
            if await self.retireIfContextLost(id) { return }
            if self.sessionID == id, !self.closed {
                self
                    .message =
                    String(localized: "Cancellation is not confirmed. Check the connection and try Cancel again.")
            }
        }
    }

    func close() async {
        self.closed = true
        await self.cancel()
    }

    private func run(_ id: String, operation: () async throws -> Void) async {
        self.busy = true
        defer { self.busy = false }
        do {
            try await operation()
        } catch {
            let cancellationAlreadyRequested = self.cancelRequested
            if await self.retireIfContextLost(id) {
                if !cancellationAlreadyRequested { try? await self.closeSession(id) }
            } else if !self.closed, self.sessionID == id, !self.cancelRequested {
                self
                    .message =
                    String(
                        localized: "Sign-in stopped. Check the connection, then cancel this attempt and retry.")
            }
        }
    }

    private func retireIfContextLost(_ id: String) async -> Bool {
        guard await !(self.context.isCurrent()) else { return false }
        guard self.sessionID == id else { return true }
        // Pending admission retains its captured id and still closes any late server session.
        self.cancelRequested = true
        self.sessionID = nil
        self.step = nil
        self.authStatus = nil
        self.message = String(localized: "The connection changed. Close sign-in and open it again.")
        return true
    }

    private func advance(_ id: String, result first: WizardNextResult) async throws {
        var result = first
        while !self.closed, self.sessionID == id, !self.cancelRequested {
            if result.done {
                await self.finish(id, status: wizardStatusString(result.status), error: result.error)
                return
            }
            let preservesInput = self.step?.id == result.step?.id && result.error != nil
            self.step = result.step
            self.message = result.error
            if !preservesInput {
                self.text = anyCodableString(result.step?.initialvalue)
                self.confirmation = anyCodableBool(result.step?.initialvalue)
                self.selection = parseWizardOptions(result.step?.options).firstIndex {
                    anyCodableEqual($0.value, result.step?.initialvalue)
                } ?? 0
            }
            if let step = result.step, wizardStepExecutor(step) != "gateway" { return }
            let data = try await self.request("wizard.next", ["sessionId": AnyCodable(id)])
            result = try JSONDecoder().decode(WizardNextResult.self, from: data)
        }
    }

    private func closeSession(_ id: String) async throws {
        let data = try await self.context.closeWizard(id)
        let result = try JSONDecoder().decode(WizardStatusResult.self, from: data)
        await self.finish(id, status: wizardStatusString(result.status), error: result.error)
    }

    private func finish(_ id: String, status: String?, error: String?) async {
        guard self.sessionID == id else { return }
        self.sessionID = nil
        self.step = nil
        guard await self.context.isCurrent(), !self.closed else { return }
        self.message = error == nil && status == "done"
            ? String(localized: "Sign-in finished.")
            : String(localized: "Sign-in ended. Review the account status before trying again.")
        // Native login publishes credentials before settling, including writes followed by errors.
        do {
            try await self.readStatus()
        } catch {
            self
                .message =
                String(localized: "Sign-in ended, but account status could not be loaded. Refresh to check it.")
        }
        if await self.context.isCurrent(), !self.closed { await self.onAuthChanged() }
    }

    private func readStatus() async throws {
        let data = try await self.request("models.authStatus", ["agentId": AnyCodable(self.context.agentID)])
        let status = try JSONDecoder().decode(ChatModelAuthStatus.self, from: data)
        self.authStatus = status
        if status.unavailable != nil {
            self.message = String(localized: "Account status is not ready. Refresh after setup finishes.")
        }
    }

    private func request(_ method: String, _ params: [String: AnyCodable]) async throws -> Data {
        guard await self.context.isCurrent(), !self.closed else { throw CancellationError() }
        let data = try await self.context.request(method, params)
        guard await self.context.isCurrent(), !self.closed else { throw CancellationError() }
        return data
    }
}

@MainActor
struct OpenClawChatModelSignInSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: ChatModelSignInModel

    init(context: OpenClawChatModelSignInContext, onAuthChanged: @escaping @MainActor () async -> Void) {
        self._model = State(initialValue: ChatModelSignInModel(context: context, onAuthChanged: onAuthChanged))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Model sign-in").font(OpenClawChatTypography.heading(level: 2))
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let step = self.model.step {
                        self.wizardStep(step)
                    } else if self.model.sessionID == nil {
                        self.accounts
                    }
                    if self.model.busy || self.model.cancelling { ProgressView() }
                    if let message = self.model.message {
                        Text(message).font(OpenClawChatTypography.callout).textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Button { self.dismiss() } label: {
                    Text("Close").font(OpenClawChatTypography.body)
                }
                if self.model.sessionID != nil {
                    Button { Task { await self.model.cancel() } } label: {
                        Text("Cancel sign-in").font(OpenClawChatTypography.body)
                    }.disabled(self.model.cancelling)
                } else {
                    Button { Task { await self.model.refresh() } } label: {
                        Text("Refresh").font(OpenClawChatTypography.body)
                    }.disabled(self.model.busy)
                }
            }
        }
        .padding(24)
        .frame(idealWidth: 460, idealHeight: 480)
        .task { await self.model.refresh() }
        .onDisappear { Task { await self.model.close() } }
    }

    private var accounts: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(self.model.authStatus?.providers ?? []) { provider in
                HStack {
                    Text(provider.displayName).font(OpenClawChatTypography.body)
                    Spacer()
                    Text(provider.statusLabel).font(OpenClawChatTypography.caption)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("model-auth-provider-\(provider.id)")
            }
            ForEach(self.model.authStatus?.loginOptions ?? []) { option in
                Button { Task { await self.model.start(option) } } label: {
                    VStack(alignment: .leading) {
                        Text(option.label).font(OpenClawChatTypography.body)
                        if let hint = option.hint { Text(hint).font(OpenClawChatTypography.caption) }
                    }
                }.disabled(self.model.busy)
            }
            if self.model.authStatus?.loginOptions.isEmpty == true {
                Text("No native sign-in options are available. Open Models in the Dashboard, or update the Gateway.")
                    .font(OpenClawChatTypography.callout)
            }
        }
    }

    @ViewBuilder
    private func wizardStep(_ step: WizardStep) -> some View {
        @Bindable var model = self.model
        if let title = step.title { Text(title).font(OpenClawChatTypography.headline) }
        if let message = step.message {
            Text(message).font(OpenClawChatTypography.callout).textSelection(.enabled)
        }
        if let code = parseWizardDeviceCode(step.devicecode) {
            Text(code.code).font(OpenClawChatTypography.mono(size: 24, weight: .semibold, relativeTo: .title2))
                .textSelection(.enabled)
            if let message = code.message { Text(message).font(OpenClawChatTypography.callout) }
        }
        if let rawURL = step.externalurl, let url = URL(string: rawURL),
           url.scheme == "https" || url.scheme == "http", url.host != nil
        {
            Link(destination: url) {
                Text("Open sign-in page").font(OpenClawChatTypography.body)
            }
            .accessibilityIdentifier("model-auth-external-url")
        }
        if wizardStepExecutor(step) != "gateway" {
            switch wizardStepType(step) {
            case "text":
                if step.sensitive == true {
                    SecureField(text: $model.text) {
                        Text(step.placeholder ?? String(localized: "Value")).font(OpenClawChatTypography.body)
                    }.font(OpenClawChatTypography.body)
                } else {
                    TextField(text: $model.text) {
                        Text(step.placeholder ?? String(localized: "Value")).font(OpenClawChatTypography.body)
                    }.font(OpenClawChatTypography.body)
                }
            case "confirm":
                Toggle(isOn: $model.confirmation) {
                    Text("Confirm").font(OpenClawChatTypography.body)
                }
            case "select":
                Picker(selection: $model.selection) {
                    ForEach(Array(parseWizardOptions(step.options).enumerated()), id: \.offset) { index, option in
                        Text(option.label).font(OpenClawChatTypography.body).tag(index)
                    }
                } label: {
                    Text("Option").font(OpenClawChatTypography.body)
                }
            default: EmptyView()
            }
            Button { Task { await self.model.answer() } } label: {
                Text("Continue").font(OpenClawChatTypography.body)
            }.disabled(self.model.busy || self.model.cancelling)
        }
    }
}
