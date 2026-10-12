import Foundation

struct QuickChatDictationTextUpdate: Equatable, Sendable {
    let text: String
    let selection: NSRange
}

struct QuickChatDictationTextSession: Equatable, Sendable {
    let baseText: String
    let replacementRange: NSRange

    init(baseText: String, replacementRange: NSRange) {
        let utf16Count = baseText.utf16.count
        let location = min(max(0, replacementRange.location), utf16Count)
        let length = min(max(0, replacementRange.length), utf16Count - location)
        self.baseText = baseText
        self.replacementRange = NSRange(location: location, length: length)
    }

    func update(transcript: String) -> QuickChatDictationTextUpdate {
        let transcript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty,
              let range = Range(self.replacementRange, in: self.baseText)
        else {
            return QuickChatDictationTextUpdate(
                text: self.baseText,
                selection: NSRange(location: self.replacementRange.location, length: 0))
        }

        let insertion = self.spacedInsertion(transcript, at: range)
        let text = self.baseText.replacingCharacters(in: range, with: insertion)
        return QuickChatDictationTextUpdate(
            text: text,
            selection: NSRange(
                location: self.replacementRange.location + insertion.utf16.count,
                length: 0))
    }

    private func spacedInsertion(_ transcript: String, at range: Range<String.Index>) -> String {
        guard self.replacementRange.length == 0 else { return transcript }
        let prefix = self.baseText[..<range.lowerBound]
        let suffix = self.baseText[range.upperBound...]
        var insertion = transcript
        if let previous = prefix.last, !previous.isWhitespace,
           let first = insertion.first, !first.isWhitespace
        {
            insertion.insert(" ", at: insertion.startIndex)
        }
        if let next = suffix.first, !next.isWhitespace, !Self.isPunctuation(next),
           let last = insertion.last, !last.isWhitespace
        {
            insertion.append(" ")
        }
        return insertion
    }

    private static func isPunctuation(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy { CharacterSet.punctuationCharacters.contains($0) }
    }
}

/// Short-lived speech recognition dedicated to the Quick Chat composer.
/// A private serial queue owns every Speech/AVFoundation object so audio work
/// stays off the main actor and `stop()` can synchronously release the mic.
final class QuickChatDictation: @unchecked Sendable {
    enum Event: Sendable {
        case transcript(String)
        case finished
        case failed
    }

    typealias UpdateHandler = @MainActor @Sendable (Event) -> Void

    private let queue = DispatchQueue(label: "ai.openclaw.quickchat.dictation")
    private let capture = SpeechCaptureResources(mode: .dictation)
    private var sessionID = UUID()

    func start(onUpdate: @escaping UpdateHandler) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.queue.async {
                do {
                    try self.startLocked(onUpdate: onUpdate)
                    continuation.resume()
                } catch {
                    self.stopLocked()
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func stop() {
        self.queue.sync {
            self.stopLocked()
        }
    }

    private func startLocked(onUpdate: @escaping UpdateHandler) throws {
        self.stopLocked()
        let sessionID = UUID()
        self.sessionID = sessionID

        try self.capture.start(localeID: Locale.current.identifier) { [weak self] update in
            guard let self else { return }
            self.queue.async { [weak self] in
                guard let self, self.sessionID == sessionID else { return }
                if update.error != nil || update.isFinal {
                    self.stopLocked()
                }
                Task { @MainActor in
                    if let transcript = update.transcript {
                        onUpdate(.transcript(transcript))
                    }
                    if update.error != nil {
                        onUpdate(.failed)
                    } else if update.isFinal {
                        onUpdate(.finished)
                    }
                }
            }
        }
    }

    private func stopLocked() {
        self.sessionID = UUID()
        self.capture.stop()
    }
}
