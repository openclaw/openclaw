import Foundation

/// Keeps trimmed history while reading, but never across an authoritative deletion.
struct ChatReaderHistorySnapshot {
    let messages: [OpenClawChatMessage]
    let deletionRevision: UInt64

    func presentation(current: [OpenClawChatMessage], deletionRevision: UInt64) -> [OpenClawChatMessage] {
        guard self.deletionRevision == deletionRevision,
              let first = current.first,
              let overlap = self.messages.firstIndex(where: { $0.id == first.id }), overlap > 0,
              self.messages[overlap...].map(\.id) == current.prefix(self.messages.count - overlap).map(\.id)
        else { return current }
        return Array(self.messages[..<overlap]) + current
    }
}
