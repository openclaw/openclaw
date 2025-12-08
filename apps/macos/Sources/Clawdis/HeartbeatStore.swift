import Foundation
import SwiftUI

@MainActor
final class HeartbeatStore: ObservableObject {
    static let shared = HeartbeatStore()

    @Published private(set) var lastEvent: ControlHeartbeatEvent?

    private var observer: NSObjectProtocol?

    private init() {
        self.observer = NotificationCenter.default.addObserver(
            forName: .controlHeartbeat,
            object: nil,
            queue: .main) { [weak self] note in
                guard let data = note.object as? Data else { return }
                if let decoded = try? JSONDecoder().decode(ControlHeartbeatEvent.self, from: data) {
                    Task { @MainActor in self?.lastEvent = decoded }
                }
            }
    }

    @MainActor
    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
}
