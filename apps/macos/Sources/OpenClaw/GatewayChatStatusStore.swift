import Foundation
import Observation

@MainActor
@Observable
final class GatewayChatStatusStore {
    static let shared = GatewayChatStatusStore()

    struct Entry: Identifiable, Equatable {
        let id: String
        let profile: GatewayProfile
        var lastKnownHealthy: Bool?
        var detail: String
    }

    private(set) var entries: [Entry] = []

    func refresh(from appState: AppState) {
        var next: [Entry] = []
        let local = GatewayProfile.local()
        next.append(self.existingOrNew(profile: local))
        for saved in appState.remoteGateways {
            guard let profile = GatewayProfile.remoteDirect(from: saved) else { continue }
            next.append(self.existingOrNew(profile: profile))
        }
        self.entries = next
        for profile in next.map(\.profile) {
            Task { await self.probe(profile: profile) }
        }
    }

    private func existingOrNew(profile: GatewayProfile) -> Entry {
        if let existing = self.entries.first(where: { $0.id == profile.id }) {
            return Entry(id: profile.id, profile: profile, lastKnownHealthy: existing.lastKnownHealthy, detail: existing.detail)
        }
        return Entry(id: profile.id, profile: profile, lastKnownHealthy: nil, detail: "Checking…")
    }

    private func setEntry(_ updated: Entry) {
        if let index = self.entries.firstIndex(where: { $0.id == updated.id }) {
            self.entries[index] = updated
        }
    }

    func probe(profile: GatewayProfile) async {
        let connection = await GatewayChatConnectionRegistry.shared.connection(for: profile)
        do {
            let ok = try await connection.healthOK(timeoutMs: 5000)
            await MainActor.run {
                self.setEntry(Entry(id: profile.id, profile: profile, lastKnownHealthy: ok, detail: ok ? "Connected" : "Unavailable"))
            }
        } catch {
            await MainActor.run {
                self.setEntry(Entry(id: profile.id, profile: profile, lastKnownHealthy: false, detail: error.localizedDescription))
            }
        }
    }
}
