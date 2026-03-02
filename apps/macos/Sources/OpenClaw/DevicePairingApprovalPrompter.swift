import AppKit
import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import OSLog

@MainActor
@Observable
final class DevicePairingApprovalPrompter {
    static let shared = DevicePairingApprovalPrompter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "device-pairing")
    private var task: Task<Void, Never>?
    private var isStopping = false
    private var isPresenting = false
    private var queue: [PendingRequest] = []
    var pendingCount: Int = 0
    var pendingRepairCount: Int = 0
    private var activeAlert: NSAlert?
    private var activeRequestId: String?
    private var alertHostWindow: NSWindow?
    private var resolvedByRequestId: Set<String> = []

    private struct PairingList: Codable {
        let pending: [PendingRequest]
        let paired: [PairedDevice]?
    }

    private struct PairedDevice: Codable, Equatable {
        let deviceId: String
        let approvedAtMs: Double?
        let displayName: String?
        let platform: String?
        let remoteIp: String?
    }

    private struct PendingRequest: Codable, Equatable, Identifiable {
        let requestId: String
        let deviceId: String
        let publicKey: String
        let displayName: String?
        let platform: String?
        let clientId: String?
        let clientMode: String?
        let role: String?
        let scopes: [String]?
        let remoteIp: String?
        let silent: Bool?
        let isRepair: Bool?
        let ts: Double

        var id: String {
            self.requestId
        }
    }

    private typealias PairingResolvedEvent = PairingAlertSupport.PairingResolvedEvent

    func start() {
        self.startPushTask()
    }

    private func startPushTask() {
        PairingAlertSupport.startPairingPushTask(
            task: &self.task,
            isStopping: &self.isStopping,
            loadPending: self.loadPendingRequestsFromGateway,
            handlePush: self.handle(push:))
    }

    func stop() {
        self.stopPushTask()
        self.updatePendingCounts()
        self.resolvedByRequestId.removeAll(keepingCapacity: false)
    }

    private func stopPushTask() {
        PairingAlertSupport.stopPairingPrompter(
            isStopping: &self.isStopping,
            activeAlert: &self.activeAlert,
            activeRequestId: &self.activeRequestId,
            task: &self.task,
            queue: &self.queue,
            isPresenting: &self.isPresenting,
            alertHostWindow: &self.alertHostWindow)
    }

    private func loadPendingRequestsFromGateway() async {
        do {
            let list: PairingList = try await GatewayConnection.shared.requestDecoded(method: .devicePairList)
            await self.apply(list: list)
        } catch {
            self.logger.error("failed to load device pairing requests: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func apply(list: PairingList) async {
        self.queue = list.pending.sorted(by: { $0.ts > $1.ts })
        self.updatePendingCounts()
        self.presentNextIfNeeded()
    }

    private func updatePendingCounts() {
        self.pendingCount = self.queue.count
        self.pendingRepairCount = self.queue.count(where: { $0.isRepair == true })
    }

    private func presentNextIfNeeded() {
        guard !self.isStopping else { return }
        guard !self.isPresenting else { return }
        guard let next = self.queue.first else { return }
        self.isPresenting = true
        self.presentAlert(for: next)
    }

    private func presentAlert(for req: PendingRequest) {
        self.logger.info("presenting device pairing alert requestId=\(req.requestId, privacy: .public)")
        PairingAlertSupport.presentPairingAlert(
            request: req,
            requestId: req.requestId,
            messageText: "Allow device to connect?",
            informativeText: Self.describe(req),
            activeAlert: &self.activeAlert,
            activeRequestId: &self.activeRequestId,
            alertHostWindow: &self.alertHostWindow,
            clearActive: self.clearActiveAlert(hostWindow:),
            onResponse: self.handleAlertResponse)
    }

    private func clearActiveAlert(hostWindow: NSWindow) {
        PairingAlertSupport.clearActivePairingAlert(
            activeAlert: &self.activeAlert,
            activeRequestId: &self.activeRequestId,
            hostWindow: hostWindow)
    }

    private func handleAlertResponse(_ response: NSApplication.ModalResponse, request: PendingRequest) async {
        var shouldRemove = response != .alertFirstButtonReturn
        defer {
            if shouldRemove {
                if self.queue.first == request {
                    self.queue.removeFirst()
                } else {
                    self.queue.removeAll { $0 == request }
                }
            }
            self.updatePendingCounts()
            self.isPresenting = false
            self.presentNextIfNeeded()
        }

        guard !self.isStopping else { return }

        if self.resolvedByRequestId.remove(request.requestId) != nil {
            return
        }

        switch response {
        case .alertFirstButtonReturn:
            shouldRemove = false
            if let idx = self.queue.firstIndex(of: request) {
                self.queue.remove(at: idx)
            }
            self.queue.append(request)
            return
        case .alertSecondButtonReturn:
            _ = await self.approve(requestId: request.requestId)
        case .alertThirdButtonReturn:
            await self.reject(requestId: request.requestId)
        default:
            return
        }
    }

    private func approve(requestId: String) async -> Bool {
        await PairingAlertSupport.approveRequest(
            requestId: requestId,
            kind: "device",
            logger: self.logger)
        {
            try await GatewayConnection.shared.devicePairApprove(requestId: requestId)
        }
    }

    private func reject(requestId: String) async {
        await PairingAlertSupport.rejectRequest(
            requestId: requestId,
            kind: "device",
            logger: self.logger)
        {
            try await GatewayConnection.shared.devicePairReject(requestId: requestId)
        }
    }

    private func endActiveAlert() {
        PairingAlertSupport.endActiveAlert(activeAlert: &self.activeAlert, activeRequestId: &self.activeRequestId)
    }

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "device.pair.requested":
            guard let payload = evt.payload else { return }
            do {
                let req = try GatewayPayloadDecoding.decode(payload, as: PendingRequest.self)
                self.enqueue(req)
            } catch {
                self.logger
                    .error("failed to decode device pairing request: \(error.localizedDescription, privacy: .public)")
            }
        case let .event(evt) where evt.event == "device.pair.resolved":
            guard let payload = evt.payload else { return }
            do {
                let resolved = try GatewayPayloadDecoding.decode(payload, as: PairingResolvedEvent.self)
                self.handleResolved(resolved)
            } catch {
                self.logger
                    .error(
                        "failed to decode device pairing resolution: \(error.localizedDescription, privacy: .public)")
            }
        default:
            break
        }
    }

    private func enqueue(_ req: PendingRequest) {
        guard !self.queue.contains(req) else { return }
        self.queue.append(req)
        self.updatePendingCounts()
        self.presentNextIfNeeded()
    }

    private func handleResolved(_ resolved: PairingResolvedEvent) {
        let resolution = resolved.decision == PairingAlertSupport.PairingResolution.approved.rawValue
            ? PairingAlertSupport.PairingResolution.approved
            : PairingAlertSupport.PairingResolution.rejected
        if let activeRequestId, activeRequestId == resolved.requestId {
            self.resolvedByRequestId.insert(resolved.requestId)
            self.endActiveAlert()
            let decision = resolution.rawValue
            self.logger.info(
                "device pairing resolved while active requestId=\(resolved.requestId, privacy: .public) " +
                    "decision=\(decision, privacy: .public)")
            return
        }
        self.queue.removeAll { $0.requestId == resolved.requestId }
        self.updatePendingCounts()
    }

    private static func describe(_ req: PendingRequest) -> String {
        var lines: [String] = []
        lines.append("Device: \(req.displayName ?? req.deviceId)")
        if let platform = req.platform {
            lines.append("Platform: \(platform)")
        }
        if let role = req.role {
            lines.append("Role: \(role)")
        }
        if let scopes = req.scopes, !scopes.isEmpty {
            lines.append("Scopes: \(scopes.joined(separator: ", "))")
        }
        if let remoteIp = req.remoteIp {
            lines.append("IP: \(remoteIp)")
        }
        if req.isRepair == true {
            lines.append("Repair: yes")
        }
        return lines.joined(separator: "\n")
    }
}
