import Foundation
import OpenClawKit
import OSLog
@preconcurrency import WatchConnectivity

enum WatchMessagingError: LocalizedError {
    case unsupported
    case notPaired
    case watchAppNotInstalled

    var errorDescription: String? {
        switch self {
        case .unsupported:
            "WATCH_UNAVAILABLE: WatchConnectivity is not supported on this device"
        case .notPaired:
            "WATCH_UNAVAILABLE: no paired Apple Watch"
        case .watchAppNotInstalled:
            "WATCH_UNAVAILABLE: OpenClaw watch companion app is not installed"
        }
    }
}

final class WatchMessagingService: NSObject, WatchMessagingServicing, @unchecked Sendable {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "watch.messaging")
    private let session: WCSession?

    override init() {
        if WCSession.isSupported() {
            self.session = WCSession.default
        } else {
            self.session = nil
        }
        super.init()
        if let session = self.session {
            session.delegate = self
            session.activate()
        }
    }

    static func isSupportedOnDevice() -> Bool {
        WCSession.isSupported()
    }

    static func currentStatusSnapshot() -> WatchMessagingStatus {
        guard WCSession.isSupported() else {
            return WatchMessagingStatus(
                supported: false,
                paired: false,
                appInstalled: false,
                reachable: false,
                activationState: "unsupported")
        }
        let session = WCSession.default
        return status(for: session)
    }

    func status() async -> WatchMessagingStatus {
        await self.ensureActivated()
        guard let session = self.session else {
            return WatchMessagingStatus(
                supported: false,
                paired: false,
                appInstalled: false,
                reachable: false,
                activationState: "unsupported")
        }
        return Self.status(for: session)
    }

    func sendNotification(
        id: String,
        title: String,
        body: String,
        priority: OpenClawNotificationPriority?) async throws -> WatchNotificationSendResult
    {
        await self.ensureActivated()
        guard let session = self.session else {
            throw WatchMessagingError.unsupported
        }

        let snapshot = Self.status(for: session)
        guard snapshot.paired else { throw WatchMessagingError.notPaired }
        guard snapshot.appInstalled else { throw WatchMessagingError.watchAppNotInstalled }

        let payload: [String: Any] = [
            "type": "watch.notify",
            "id": id,
            "title": title,
            "body": body,
            "priority": priority?.rawValue ?? OpenClawNotificationPriority.active.rawValue,
            "sentAtMs": Int(Date().timeIntervalSince1970 * 1000),
        ]

        if snapshot.reachable {
            do {
                try await self.sendReachableMessage(payload, with: session)
                return WatchNotificationSendResult(
                    deliveredImmediately: true,
                    queuedForDelivery: false,
                    transport: "sendMessage")
            } catch {
                Self.logger.error("watch sendMessage failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        _ = session.transferUserInfo(payload)
        return WatchNotificationSendResult(
            deliveredImmediately: false,
            queuedForDelivery: true,
            transport: "transferUserInfo")
    }

    private func sendReachableMessage(_ payload: [String: Any], with session: WCSession) async throws {
        try await withCheckedThrowingContinuation { continuation in
            session.sendMessage(payload, replyHandler: { _ in
                continuation.resume()
            }, errorHandler: { error in
                continuation.resume(throwing: error)
            })
        }
    }

    private func ensureActivated() async {
        guard let session = self.session else { return }
        if session.activationState == .activated { return }
        session.activate()
        for _ in 0..<8 {
            if session.activationState == .activated { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private static func status(for session: WCSession) -> WatchMessagingStatus {
        WatchMessagingStatus(
            supported: true,
            paired: session.isPaired,
            appInstalled: session.isWatchAppInstalled,
            reachable: session.isReachable,
            activationState: activationStateLabel(session.activationState))
    }

    private static func activationStateLabel(_ state: WCSessionActivationState) -> String {
        switch state {
        case .notActivated:
            "notActivated"
        case .inactive:
            "inactive"
        case .activated:
            "activated"
        @unknown default:
            "unknown"
        }
    }
}

extension WatchMessagingService: WCSessionDelegate {
    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?)
    {
        if let error {
            Self.logger.error("watch activation failed: \(error.localizedDescription, privacy: .public)")
            return
        }
        Self.logger.debug("watch activation state=\(Self.activationStateLabel(activationState), privacy: .public)")
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    func sessionReachabilityDidChange(_ session: WCSession) {}
}
