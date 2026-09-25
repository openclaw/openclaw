import Foundation

/// Optional transcription context never changes which phrases authorize a local command.
enum RealtimeTalkTranscriptionHints {
    static func accepts(_ phrases: [String]) -> Bool {
        guard !phrases.isEmpty, phrases.count <= 8 else { return false }
        var total = 0
        for phrase in phrases {
            let count = phrase.utf16.count
            guard (1...64).contains(count),
                  phrase == phrase.trimmingCharacters(in: .whitespacesAndNewlines),
                  !phrase.unicodeScalars.contains(where: { scalar in
                      switch scalar.properties.generalCategory {
                      case .control, .format, .surrogate, .lineSeparator, .paragraphSeparator: true
                      default: false
                      }
                  })
            else { return false }
            total += count
            guard total <= 256 else { return false }
        }
        return true
    }

    static func isSupported(catalog data: Data) -> Bool {
        guard let catalog = try? JSONDecoder().decode(Catalog.self, from: data) else { return false }
        let providers = catalog.realtime.providers.filter { $0.id == "openai" }
        guard providers.count == 1, let provider = providers.first, provider.configured,
              let capability = provider.transcriptionCommandHints
        else { return false }
        return capability.version == 1 && capability.kind == "local-stop-phrases" &&
            capability.mode == "realtime" && capability.transport == "gateway-relay" &&
            capability.models == ["gpt-realtime-2.1"] &&
            capability.transcriptionModel == "gpt-4o-mini-transcribe" &&
            capability.maxPhrases == 8 && capability.maxPhraseUtf16Units == 64 &&
            capability.maxTotalUtf16Units == 256 && capability.maxPromptUtf8Bytes == 1024
    }

    private struct Catalog: Decodable {
        let realtime: Group
    }

    private struct Group: Decodable {
        let providers: [Provider]
    }

    private struct Provider: Decodable {
        let id: String
        let configured: Bool
        let transcriptionCommandHints: Capability?
    }

    private struct Capability: Decodable {
        let version: Int
        let kind: String
        let mode: String
        let transport: String
        let models: [String]
        let transcriptionModel: String
        let maxPhrases: Int
        let maxPhraseUtf16Units: Int
        let maxTotalUtf16Units: Int
        let maxPromptUtf8Bytes: Int
    }
}
