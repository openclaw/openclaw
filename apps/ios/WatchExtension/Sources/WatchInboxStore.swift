import Foundation
import Observation

@MainActor @Observable final class WatchInboxStore {
    var title = "OpenClaw"
    var body = "Waiting for messages from your iPhone."
    var transport = "none"
    var updatedAt: Date?

    func consume(payload: [String: Any], transport: String) {
        guard let type = payload["type"] as? String, type == "watch.notify" else {
            return
        }

        let titleValue = (payload["title"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bodyValue = (payload["body"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard titleValue.isEmpty == false || bodyValue.isEmpty == false else {
            return
        }

        self.title = titleValue.isEmpty ? "OpenClaw" : titleValue
        self.body = bodyValue
        self.transport = transport
        self.updatedAt = Date()
    }
}
