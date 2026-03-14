import Foundation

enum TalkModePhase: String {
    case idle
    /// Shown while the Voxtral/ExecuTorch model is loading (e.g. 20–30 s).
    case loading
    case listening
    case thinking
    case speaking
}

/// STT backend selection for Talk Mode.
enum TalkSttBackend: String, CaseIterable {
    case appleSpeech = "apple"
    case executorch = "executorch"

    var displayName: String {
        switch self {
        case .appleSpeech: return "Apple Speech"
        case .executorch: return "ExecuTorch Voxtral"
        }
    }

    var subtitle: String {
        switch self {
        case .appleSpeech: return "Built-in on-device recognition"
        case .executorch: return "Voxtral 4B — higher quality, streaming, multilingual"
        }
    }
}
