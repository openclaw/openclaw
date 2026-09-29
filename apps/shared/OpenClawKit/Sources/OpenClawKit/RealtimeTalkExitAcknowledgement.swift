import Foundation

/// Response guidance is optional and never grants authority to turn Talk off.
enum RealtimeTalkExitAcknowledgement {
    static func isSuitable(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
            .lowercased()
        return normalized == "okay" || normalized == "ok"
    }

    static func isSupported(catalog data: Data) -> Bool {
        guard let catalog = try? JSONDecoder().decode(Catalog.self, from: data) else { return false }
        let providers = catalog.realtime.providers.filter { $0.id == "openai" }
        guard providers.count == 1, let provider = providers.first, provider.configured,
              let capability = provider.localExitAcknowledgement else { return false }
        return capability.version == 1 && capability.mode == "realtime" &&
            capability.transport == "gateway-relay" && capability.maxPhrases == 8 &&
            capability.maxPhraseUtf16Units == 64 && capability.maxTotalUtf16Units == 256
    }

    private struct Catalog: Decodable { let realtime: Group }
    private struct Group: Decodable { let providers: [Provider] }
    private struct Provider: Decodable {
        let id: String
        let configured: Bool
        let localExitAcknowledgement: Capability?
    }

    private struct Capability: Decodable {
        let version: Int
        let mode: String
        let transport: String
        let maxPhrases: Int
        let maxPhraseUtf16Units: Int
        let maxTotalUtf16Units: Int
    }
}
