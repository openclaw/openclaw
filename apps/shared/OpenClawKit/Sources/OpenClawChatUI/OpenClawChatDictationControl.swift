import Foundation

public struct OpenClawChatDictationControl {
    public enum Phase: Equatable {
        case idle
        case starting
        case listening
        case processing

        var statusText: String {
            switch self {
            case .idle: String(localized: "Not listening")
            case .starting: String(localized: "Starting dictation…")
            case .listening: String(localized: "Listening…")
            case .processing: String(localized: "Finishing dictation…")
            }
        }
    }

    public var phase: Phase
    public var isAvailable: Bool
    public var partialTranscript: String
    public var level: Double
    public var start: @MainActor () async throws -> String?
    public var finish: @MainActor () -> Void
    public var cancel: @MainActor () -> Void

    public init(
        phase: Phase,
        isAvailable: Bool,
        partialTranscript: String,
        level: Double,
        start: @escaping @MainActor () async throws -> String?,
        finish: @escaping @MainActor () -> Void,
        cancel: @escaping @MainActor () -> Void)
    {
        self.phase = phase
        self.isAvailable = isAvailable
        self.partialTranscript = partialTranscript
        self.level = level
        self.start = start
        self.finish = finish
        self.cancel = cancel
    }

    public var isActive: Bool {
        self.phase != .idle
    }
}

extension OpenClawChatViewModel {
    func appendDictationTranscript(_ transcript: String, for session: SessionSnapshot) {
        guard self.isCurrentSession(session) else { return }
        if self.input.isEmpty {
            self.input = transcript
        } else {
            let separator = self.input.last?.isWhitespace == true ? "" : " "
            self.input += separator + transcript
        }
    }

    func setDictationError(_ error: Error, for session: SessionSnapshot) {
        guard self.isCurrentSession(session) else { return }
        self.errorText = error.localizedDescription
    }
}
