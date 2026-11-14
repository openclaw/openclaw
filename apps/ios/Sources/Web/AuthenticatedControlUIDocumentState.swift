import Observation

/// Document recovery only. Page connections and handoff completion stay owned by the web app.
@MainActor
@Observable
final class AuthenticatedControlUIDocumentState {
    enum Phase {
        case loading
        case ready
        case failed
    }

    var phase: Phase = .loading
    private(set) var reloadID = 0

    func reload() {
        self.phase = .loading
        self.reloadID += 1
    }
}
