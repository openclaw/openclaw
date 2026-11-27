import Foundation
import OpenClawKit

enum WatchMessagingError: LocalizedError {
    case unsupported
    case notPaired
    case watchAppNotInstalled
    case admissionUnavailable

    var errorDescription: String? {
        switch self {
        case .unsupported:
            "WATCH_UNAVAILABLE: WatchConnectivity is not supported on this device"
        case .notPaired:
            "WATCH_UNAVAILABLE: no paired Apple Watch"
        case .watchAppNotInstalled:
            "WATCH_UNAVAILABLE: OpenClaw watch companion app is not installed"
        case .admissionUnavailable:
            "WATCH_UNAVAILABLE: Watch chat storage is not ready"
        }
    }
}

@MainActor
final class WatchMessagingService: @preconcurrency WatchMessagingServicing {
    private let transport: WatchConnectivityTransport
    private var statusHandler: (@Sendable (WatchMessagingStatus) -> Void)?
    private var lastEmittedStatus: WatchMessagingStatus?
    private var chatDeliveryHandler: (@Sendable (OpenClawWatchChatDeliveryCommand) async throws -> Void)?
    private var chatDeliveryReceiptAckHandler: (@Sendable (OpenClawWatchChatDeliveryReceiptAck) async throws -> Void)?
    private var legacyChatRejectedHandler: (@Sendable () -> Void)?
    private var hasRejectedLegacyChat = false
    private var execApprovalResolveHandler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?
    private var execApprovalSnapshotRequestHandler: (
        @Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?
    private var appSnapshotRequestHandler: (@Sendable (WatchAppSnapshotRequestEvent) -> Void)?
    private var appCommandHandler: (@Sendable (WatchAppCommandEvent) -> Void)?

    init(transport: WatchConnectivityTransport = WatchConnectivityTransport()) {
        self.transport = transport
        self.transport.setStatusUpdateHandler { [weak self] snapshot in
            Task { @MainActor [weak self] in
                self?.emitStatusIfChanged(snapshot)
            }
        }
        self.transport.setInboundEventHandler { [weak self] event in
            guard let self else { throw WatchMessagingError.admissionUnavailable }
            try await self.receiveInboundEvent(event)
        }
        self.transport.activate()
    }

    nonisolated static func isSupportedOnDevice() -> Bool {
        WatchConnectivityTransport.isSupportedOnDevice()
    }

    func status() async -> WatchMessagingStatus {
        await self.transport.status()
    }

    func setStatusHandler(_ handler: (@Sendable (WatchMessagingStatus) -> Void)?) {
        self.statusHandler = handler
        guard let handler else {
            self.lastEmittedStatus = nil
            return
        }
        let snapshot = self.transport.currentStatusSnapshot()
        self.lastEmittedStatus = snapshot
        handler(snapshot)
    }

    func setChatDeliveryHandler(
        _ handler: (@Sendable (OpenClawWatchChatDeliveryCommand) async throws -> Void)?)
    {
        self.chatDeliveryHandler = handler
    }

    func setChatDeliveryReceiptAckHandler(
        _ handler: (@Sendable (OpenClawWatchChatDeliveryReceiptAck) async throws -> Void)?)
    {
        self.chatDeliveryReceiptAckHandler = handler
    }

    func setLegacyChatRejectedHandler(_ handler: (@Sendable () -> Void)?) {
        self.legacyChatRejectedHandler = handler
        if self.hasRejectedLegacyChat { handler?() }
    }

    func setExecApprovalResolveHandler(_ handler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?) {
        self.execApprovalResolveHandler = handler
    }

    func setExecApprovalSnapshotRequestHandler(
        _ handler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?)
    {
        self.execApprovalSnapshotRequestHandler = handler
    }

    func setAppSnapshotRequestHandler(_ handler: (@Sendable (WatchAppSnapshotRequestEvent) -> Void)?) {
        self.appSnapshotRequestHandler = handler
    }

    func setAppCommandHandler(_ handler: (@Sendable (WatchAppCommandEvent) -> Void)?) {
        self.appCommandHandler = handler
    }

    func sendNotification(
        id: String,
        params: OpenClawWatchNotifyParams,
        gatewayStableID: String?,
        chatDeliveryContext: OpenClawWatchChatDeliveryContext? = nil) async throws -> WatchNotificationSendResult
    {
        let payload = WatchMessagingPayloadCodec.encodeNotificationPayload(
            id: id,
            params: params,
            gatewayStableID: gatewayStableID,
            chatDeliveryContext: chatDeliveryContext)
        return try await self.transport.sendPayload(payload)
    }

    func sendDirectNodeSetup(setupCode: String) async throws -> WatchNotificationSendResult {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeDirectNodeSetupPayload(setupCode: setupCode))
    }

    func sendExecApprovalPrompt(
        _ message: OpenClawWatchExecApprovalPromptMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeExecApprovalPromptPayload(message))
    }

    func sendExecApprovalResolved(
        _ message: OpenClawWatchExecApprovalResolvedMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeExecApprovalResolvedPayload(message))
    }

    func sendExecApprovalExpired(
        _ message: OpenClawWatchExecApprovalExpiredMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeExecApprovalExpiredPayload(message))
    }

    func syncExecApprovalSnapshot(
        _ message: OpenClawWatchExecApprovalSnapshotMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendSnapshotPayload(
            WatchMessagingPayloadCodec.encodeExecApprovalSnapshotPayload(message))
    }

    func syncAppSnapshot(
        _ message: OpenClawWatchAppSnapshotMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendSnapshotPayload(
            WatchMessagingPayloadCodec.encodeAppSnapshotPayload(message))
    }

    func sendChatDeliveryReceipt(
        _ receipt: OpenClawWatchChatDeliveryReceipt) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendPayload(
            OpenClawWatchChatDeliveryCodec.encode(receipt))
    }

    private func emitStatusIfChanged(_ snapshot: WatchMessagingStatus) {
        guard snapshot != self.lastEmittedStatus else {
            return
        }
        self.lastEmittedStatus = snapshot
        self.statusHandler?(snapshot)
    }

    private func receiveInboundEvent(_ event: WatchMessagingInboundEvent) async throws {
        // NodeAppModel installs handlers synchronously on MainActor before queued transport delivery can run.
        switch event {
        case let .chatDeliveryCommand(command):
            // Returning is the application ACK boundary; a startup buffer is not custody.
            guard let handler = self.chatDeliveryHandler else { throw WatchMessagingError.admissionUnavailable }
            try await handler(command)
        case let .chatDeliveryReceiptAck(acknowledgment):
            guard let handler = self.chatDeliveryReceiptAckHandler
            else { throw WatchMessagingError.admissionUnavailable }
            try await handler(acknowledgment)
        case .legacyChat:
            self.hasRejectedLegacyChat = true
            self.legacyChatRejectedHandler?()
            throw OpenClawWatchChatDeliveryError(
                code: "upgrade_required",
                message: "Update OpenClaw on iPhone and Apple Watch before sending Watch messages.")
        case let .execApprovalResolve(event):
            self.execApprovalResolveHandler?(event)
        case let .execApprovalSnapshotRequest(event):
            self.execApprovalSnapshotRequestHandler?(event)
        case let .appSnapshotRequest(event):
            self.appSnapshotRequestHandler?(event)
        case let .appCommand(event):
            self.appCommandHandler?(event)
        }
    }
}
