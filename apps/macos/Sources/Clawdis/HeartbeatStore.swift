import Foundation
import SwiftUI

@MainActor
final class HeartbeatStore: ObservableObject {
    static let shared = HeartbeatStore()

    @Published private(set) var lastEvent: AgentRPC.HeartbeatEvent?

    private var observer: NSObjectProtocol?

    private init() {
        self.observer = NotificationCenter.default.addObserver(
            forName: AgentRPC.heartbeatNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let event = note.object as? AgentRPC.HeartbeatEvent else { return }
            Task { @MainActor in
                self?.lastEvent = event
            }
        }
    }

    @MainActor
    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}
