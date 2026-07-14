import Foundation

struct WatchVoiceTurnTracker: Equatable {
    private(set) var commandId: String?
    private(set) var isAwaitingReply = false

    mutating func begin(commandId: String) {
        self.commandId = commandId
        self.isAwaitingReply = true
    }

    mutating func takeReply(completedCommandId: String?, text: String?) -> String? {
        guard self.isAwaitingReply,
              let completedCommandId,
              completedCommandId == commandId,
              let text = text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else {
            return nil
        }

        self.commandId = nil
        self.isAwaitingReply = false
        return text
    }

    mutating func cancel() {
        self.commandId = nil
        self.isAwaitingReply = false
    }
}
