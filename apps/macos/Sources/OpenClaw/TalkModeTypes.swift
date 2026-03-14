import Foundation

enum TalkModePhase: String {
    case idle
    /// Shown while the Parakeet/ExecuTorch model is loading (e.g. 20–30 s).
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
        case .executorch: return "ExecuTorch Parakeet-TDT"
        }
    }

    var subtitle: String {
        switch self {
        case .appleSpeech: return "Built-in on-device recognition"
        case .executorch: return "Parakeet TDT 0.6B — low-latency command recognition"
        }
    }
}
