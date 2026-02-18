import Foundation
import WatchConnectivity

final class WatchConnectivityReceiver: NSObject, @unchecked Sendable {
    private let store: WatchInboxStore
    private let session: WCSession?

    init(store: WatchInboxStore) {
        self.store = store
        if WCSession.isSupported() {
            self.session = WCSession.default
        } else {
            self.session = nil
        }
        super.init()
    }

    func activate() {
        guard let session = self.session else { return }
        session.delegate = self
        session.activate()
    }

    private static func parseNotificationPayload(_ payload: [String: Any]) -> WatchNotifyMessage? {
        guard let type = payload["type"] as? String, type == "watch.notify" else {
            return nil
        }

        let title = (payload["title"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let body = (payload["body"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard title.isEmpty == false || body.isEmpty == false else {
            return nil
        }

        let id = (payload["id"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sentAtMs = (payload["sentAtMs"] as? Int) ?? (payload["sentAtMs"] as? NSNumber)?.intValue

        return WatchNotifyMessage(
            id: id,
            title: title,
            body: body,
            sentAtMs: sentAtMs)
    }
}

extension WatchConnectivityReceiver: WCSessionDelegate {
    func session(
        _: WCSession,
        activationDidCompleteWith _: WCSessionActivationState,
        error _: (any Error)?)
    {}

    func session(_: WCSession, didReceiveMessage message: [String: Any]) {
        guard let incoming = Self.parseNotificationPayload(message) else { return }
        Task { @MainActor in
            self.store.consume(message: incoming, transport: "sendMessage")
        }
    }

    func session(
        _: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void)
    {
        guard let incoming = Self.parseNotificationPayload(message) else {
            replyHandler(["ok": false])
            return
        }
        Task { @MainActor in
            self.store.consume(message: incoming, transport: "sendMessage")
            replyHandler(["ok": true])
        }
    }

    func session(_: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        guard let incoming = Self.parseNotificationPayload(userInfo) else { return }
        Task { @MainActor in
            self.store.consume(message: incoming, transport: "transferUserInfo")
        }
    }

    func session(_: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let incoming = Self.parseNotificationPayload(applicationContext) else { return }
        Task { @MainActor in
            self.store.consume(message: incoming, transport: "applicationContext")
        }
    }
}
