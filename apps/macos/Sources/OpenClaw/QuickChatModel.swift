import Foundation
import Observation
import OpenClawIPC

struct QuickChatAgentDisplay: Equatable {
    static let placeholder = QuickChatAgentDisplay(name: "Agent", emoji: nil)

    let name: String
    let emoji: String?
    let avatarSymbolFallback: String

    init(name: String, emoji: String?, avatarSymbolFallback: String = "sparkles") {
        self.name = name
        self.emoji = emoji
        self.avatarSymbolFallback = avatarSymbolFallback
    }
}

enum QuickChatConnectionGate: Equatable {
    case available
    case unconfigured
    case paused
    case disconnected
}

enum QuickChatSendState: Equatable {
    case idle
    case sending
    case sent
    case failed(String)
}

@MainActor
@Observable
final class QuickChatModel {
    private struct RetryIdentity {
        let draft: String
        let sessionKey: String
        let idempotencyKey: String
    }

    typealias SessionKeyProvider = @MainActor () async -> String
    typealias AgentIdentityProvider = @MainActor (String) async throws -> QuickChatAgentDisplay
    typealias SendProvider = @MainActor (String, String, String) async throws -> String
    typealias PermissionStatusProvider = @MainActor ([Capability]) async -> [Capability: Bool]
    typealias PermissionGrantProvider = @MainActor ([Capability]) async -> [Capability: Bool]
    typealias ConnectionGateProvider = @MainActor () -> QuickChatConnectionGate

    static let trackedPermissions: [Capability] = [.notifications, .accessibility, .screenRecording]

    var text = "" {
        didSet {
            if !self.text.isEmpty, self.sendState == .sent {
                self.sendState = .idle
            }
            if self.sendTask == nil, let retryIdentity = self.retryIdentity, retryIdentity.draft != self.text {
                self.retryIdentity = nil
            }
        }
    }

    private(set) var sessionKey = ""
    private(set) var agentDisplay = QuickChatAgentDisplay.placeholder
    private(set) var missingPermissions: [Capability] = []
    private(set) var permissionsDismissedThisSession = false
    private(set) var isGrantingPermissions = false
    private(set) var sendState: QuickChatSendState = .idle
    private(set) var isPresentationActive = false

    @ObservationIgnored private let sessionKeyProvider: SessionKeyProvider
    @ObservationIgnored private let agentIdentityProvider: AgentIdentityProvider
    @ObservationIgnored private let sendProvider: SendProvider
    @ObservationIgnored private let permissionStatusProvider: PermissionStatusProvider
    @ObservationIgnored private let permissionGrantProvider: PermissionGrantProvider
    @ObservationIgnored private let connectionGateProvider: ConnectionGateProvider
    @ObservationIgnored private var presentationID = UUID()
    @ObservationIgnored private var agentDisplaySessionKey: String?
    @ObservationIgnored private var sendTask: Task<String, Error>?
    @ObservationIgnored private var permissionTask: Task<Void, Never>?
    @ObservationIgnored private var permissionPollTask: Task<Void, Never>?
    @ObservationIgnored private var retryIdentity: RetryIdentity?

    init(
        sessionKeyProvider: @escaping SessionKeyProvider = {
            await GatewayConnection.shared.mainSessionKey()
        },
        agentIdentityProvider: @escaping AgentIdentityProvider = { sessionKey in
            let identity = try await GatewayConnection.shared.agentIdentity(sessionKey: sessionKey)
            let name = identity.name?.trimmingCharacters(in: .whitespacesAndNewlines)
            let emoji = identity.emoji?.trimmingCharacters(in: .whitespacesAndNewlines)
            return QuickChatAgentDisplay(
                name: name.flatMap { $0.isEmpty ? nil : $0 } ?? "Agent",
                emoji: emoji?.isEmpty == false ? emoji : nil)
        },
        sendProvider: @escaping SendProvider = { sessionKey, message, idempotencyKey in
            let response = try await GatewayConnection.shared.chatSend(
                sessionKey: sessionKey,
                message: message,
                thinking: nil,
                idempotencyKey: idempotencyKey,
                attachments: [])
            return response.status
        },
        permissionStatusProvider: @escaping PermissionStatusProvider = { capabilities in
            await PermissionManager.status(capabilities)
        },
        permissionGrantProvider: @escaping PermissionGrantProvider = { capabilities in
            await PermissionManager.ensure(capabilities, interactive: true)
        },
        connectionGateProvider: @escaping ConnectionGateProvider = {
            let appState = AppStateStore.shared
            if appState.connectionMode == .unconfigured { return .unconfigured }
            if appState.isPaused { return .paused }
            if ControlChannel.shared.state != .connected { return .disconnected }
            return .available
        })
    {
        self.sessionKeyProvider = sessionKeyProvider
        self.agentIdentityProvider = agentIdentityProvider
        self.sendProvider = sendProvider
        self.permissionStatusProvider = permissionStatusProvider
        self.permissionGrantProvider = permissionGrantProvider
        self.connectionGateProvider = connectionGateProvider
    }

    var connectionGate: QuickChatConnectionGate {
        self.connectionGateProvider()
    }

    var connectionStatusMessage: String? {
        switch self.connectionGate {
        case .available: nil
        case .unconfigured: "Not configured"
        case .paused: "OpenClaw is paused"
        case .disconnected: "Gateway disconnected"
        }
    }

    var shouldShowPermissionStrip: Bool {
        !self.permissionsDismissedThisSession && !self.missingPermissions.isEmpty
    }

    var canSend: Bool {
        !self.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !self.sessionKey.isEmpty &&
            self.connectionGate == .available &&
            self.sendState != .sending
    }

    var activePresentationID: UUID? {
        self.isPresentationActive ? self.presentationID : nil
    }

    func beginPresentation() -> UUID {
        self.presentationID = UUID()
        self.isPresentationActive = true
        // Keep the cached agent display so re-opening does not flash the placeholder;
        // the session key must stay empty until refreshed because routing may have changed.
        self.sessionKey = ""
        if self.sendTask == nil { self.sendState = .idle }
        self.startPermissionPolling(id: self.presentationID)
        return self.presentationID
    }

    func refreshForPresentation(id: UUID) async {
        guard self.isCurrentPresentation(id) else { return }
        async let sessionKey = self.sessionKeyProvider()
        // A targeted one-shot avoids PermissionMonitor's unrelated Terminal AppleScript probe.
        async let permissionStatus = self.permissionStatusProvider(Self.trackedPermissions)

        let (resolvedSessionKey, status) = await (sessionKey, permissionStatus)
        guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
        self.sessionKey = resolvedSessionKey
        // The cached display only describes this session key; routing changes must not
        // label a send with the previous agent while the fresh identity is in flight.
        if self.agentDisplaySessionKey != resolvedSessionKey {
            self.agentDisplay = .placeholder
            self.agentDisplaySessionKey = nil
        }
        self.applyPermissionStatus(status)

        do {
            let display = try await self.agentIdentityProvider(resolvedSessionKey)
            guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
            self.agentDisplay = display
            self.agentDisplaySessionKey = resolvedSessionKey
        } catch {
            // Keep the key-matched display on transient fetch failures; stale beats flashing.
        }
    }

    func dismissPermissionsForSession() {
        self.permissionsDismissedThisSession = true
    }

    func grantMissingPermissions() {
        let capabilities = self.missingPermissions
        guard !capabilities.isEmpty, !self.isGrantingPermissions else { return }
        let id = self.presentationID
        self.permissionTask?.cancel()
        self.isGrantingPermissions = true
        self.permissionTask = Task { [weak self] in
            guard let self else { return }
            _ = await self.permissionGrantProvider(capabilities)
            // The 1s poll keeps the strip current afterwards; one immediate recheck avoids lag.
            guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
            await self.recheckPermissions(id: id)
            guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
            self.isGrantingPermissions = false
            self.permissionTask = nil
        }
    }

    func send() async -> Bool {
        let draft = self.text
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !self.sessionKey.isEmpty, self.connectionGate == .available else { return false }
        guard self.sendState != .sending else { return false }

        let sessionKey = self.sessionKey
        let idempotencyKey: String
        if let retryIdentity = self.retryIdentity,
           retryIdentity.draft == draft,
           retryIdentity.sessionKey == sessionKey
        {
            idempotencyKey = retryIdentity.idempotencyKey
        } else {
            idempotencyKey = UUID().uuidString
            self.retryIdentity = RetryIdentity(
                draft: draft,
                sessionKey: sessionKey,
                idempotencyKey: idempotencyKey)
        }
        let task = Task {
            try await self.sendProvider(sessionKey, message, idempotencyKey)
        }
        self.sendTask = task
        self.sendState = .sending
        do {
            let status = try await task.value
            self.sendTask = nil
            switch ChatSendStatus.acceptance(of: status) {
            case .terminalFailure:
                self.retryIdentity = nil
                let normalized = ChatSendStatus.normalized(status)
                self.sendState = self.text == draft
                    ? .failed("Message was not accepted (\(normalized)).")
                    : .idle
                return false
            case .terminalSuccess, .inFlight:
                // chat.send acknowledges acceptance; the reply completes asynchronously in full chat.
                self.retryIdentity = nil
                if self.text == draft {
                    self.sendState = .sent
                    self.text = ""
                } else {
                    self.sendState = .idle
                }
                return true
            }
        } catch is CancellationError {
            self.sendTask = nil
            self.retryIdentity = nil
            self.sendState = .idle
            return false
        } catch {
            self.sendTask = nil
            self.sendState = self.text == draft ? .failed(error.localizedDescription) : .idle
            return false
        }
    }

    func endPresentation() {
        self.isPresentationActive = false
        self.presentationID = UUID()
        self.sessionKey = ""
        // A dispatched chat.send may already be accepted; cancelling and retrying with a new UUID can duplicate it.
        self.cancelPermissionTask()
        self.cancelPermissionPolling()
    }

    func cancelAllTasks() {
        self.sendTask?.cancel()
        self.sendTask = nil
        self.retryIdentity = nil
        self.cancelPermissionTask()
        self.cancelPermissionPolling()
        if self.sendState == .sending { self.sendState = .idle }
    }

    private func startPermissionPolling(id: UUID) {
        guard !ProcessInfo.processInfo.isRunningTests else { return }
        self.permissionPollTask?.cancel()
        // TCC posts no change notifications; poll the tracked capabilities (cheap native
        // checks, no AppleScript probe) only while the bar is presented so the strip
        // appears and clears live, including grants made from System Settings.
        self.permissionPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, self.isCurrentPresentation(id), !Task.isCancelled else { return }
                await self.recheckPermissions(id: id)
            }
        }
    }

    private func cancelPermissionPolling() {
        self.permissionPollTask?.cancel()
        self.permissionPollTask = nil
    }

    private func cancelPermissionTask() {
        self.permissionTask?.cancel()
        self.permissionTask = nil
        self.isGrantingPermissions = false
    }

    private func recheckPermissions(id: UUID) async {
        let status = await self.permissionStatusProvider(Self.trackedPermissions)
        guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
        self.applyPermissionStatus(status)
    }

    private func applyPermissionStatus(_ status: [Capability: Bool]) {
        self.missingPermissions = Self.trackedPermissions.filter { status[$0] != true }
    }

    private func isCurrentPresentation(_ id: UUID) -> Bool {
        self.isPresentationActive && self.presentationID == id
    }
}
