import Foundation
import WatchConnectivity

final class WatchConnectivityReceiver: NSObject {
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
}

extension WatchConnectivityReceiver: WCSessionDelegate {
    func session(
        _: WCSession,
        activationDidCompleteWith _: WCSessionActivationState,
        error _: (any Error)?)
    {}

    func session(_: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in
            self.store.consume(payload: message, transport: "sendMessage")
        }
    }

    func session(_: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        Task { @MainActor in
            self.store.consume(payload: userInfo, transport: "transferUserInfo")
        }
    }

    func session(_: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in
            self.store.consume(payload: applicationContext, transport: "applicationContext")
        }
    }
}
