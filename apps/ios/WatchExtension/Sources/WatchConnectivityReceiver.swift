import Foundation
import WatchConnectivity

struct WatchReplyDraft: Sendable {
    var replyId: String
    var promptId: String
    var actionId: String
    var actionLabel: String?
    var sessionKey: String?
    var note: String?
    var sentAtMs: Int
}

struct WatchReplySendResult: Sendable, Equatable {
    var deliveredImmediately: Bool
    var queuedForDelivery: Bool
    var transport: String
    var errorMessage: String?
}

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

    private func ensureActivated() async {
        guard let session = self.session else { return }
        if session.activationState == .activated {
            return
        }
        session.activate()
        for _ in 0..<8 {
            if session.activationState == .activated {
                return
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    func sendReply(_ draft: WatchReplyDraft) async -> WatchReplySendResult {
        await self.ensureActivated()
        guard let session = self.session else {
            return WatchReplySendResult(
                deliveredImmediately: false,
                queuedForDelivery: false,
                transport: "none",
                errorMessage: "watch session unavailable")
        }

        var payload: [String: Any] = [
            "type": "watch.reply",
            "replyId": draft.replyId,
            "promptId": draft.promptId,
            "actionId": draft.actionId,
            "sentAtMs": draft.sentAtMs,
        ]
        if let actionLabel = draft.actionLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
           !actionLabel.isEmpty
        {
            payload["actionLabel"] = actionLabel
        }
        if let sessionKey = draft.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines),
           !sessionKey.isEmpty
        {
            payload["sessionKey"] = sessionKey
        }
        if let note = draft.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
            payload["note"] = note
        }

        if session.isReachable {
            do {
                try await withCheckedThrowingContinuation { continuation in
                    session.sendMessage(payload, replyHandler: { _ in
                        continuation.resume()
                    }, errorHandler: { error in
                        continuation.resume(throwing: error)
                    })
                }
                return WatchReplySendResult(
                    deliveredImmediately: true,
                    queuedForDelivery: false,
                    transport: "sendMessage",
                    errorMessage: nil)
            } catch {
                // Fall through to queued delivery below.
            }
        }

        _ = session.transferUserInfo(payload)
        return WatchReplySendResult(
            deliveredImmediately: false,
            queuedForDelivery: true,
            transport: "transferUserInfo",
            errorMessage: nil)
    }

    private static func normalizeObject(_ value: Any) -> [String: Any]? {
        if let object = value as? [String: Any] {
            return object
        }
        if let object = value as? [AnyHashable: Any] {
            var normalized: [String: Any] = [:]
            normalized.reserveCapacity(object.count)
            for (key, item) in object {
                guard let stringKey = key as? String else {
                    continue
                }
                normalized[stringKey] = item
            }
            return normalized
        }
        return nil
    }

    private static func parseActions(_ value: Any?) -> [WatchPromptAction] {
        guard let raw = value as? [Any] else {
            return []
        }
        return raw.compactMap { item in
            guard let obj = Self.normalizeObject(item) else {
                return nil
            }
            let id = (obj["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let label = (obj["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !id.isEmpty, !label.isEmpty else {
                return nil
            }
            let style = (obj["style"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return WatchPromptAction(id: id, label: label, style: style)
        }
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
        let promptId = (payload["promptId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sessionKey = (payload["sessionKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let kind = (payload["kind"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let details = (payload["details"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let expiresAtMs = (payload["expiresAtMs"] as? Int) ?? (payload["expiresAtMs"] as? NSNumber)?.intValue
        let risk = (payload["risk"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let actions = Self.parseActions(payload["actions"])

        return WatchNotifyMessage(
            id: id,
            title: title,
            body: body,
            sentAtMs: sentAtMs,
            promptId: promptId,
            sessionKey: sessionKey,
            kind: kind,
            details: details,
            expiresAtMs: expiresAtMs,
            risk: risk,
            actions: actions)
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
        replyHandler(["ok": true])
        Task { @MainActor in
            self.store.consume(message: incoming, transport: "sendMessage")
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
