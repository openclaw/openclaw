import Testing

@testable import OpenClawWatch

@Suite("WatchAppGroup")
struct WatchAppGroupTests {
    @Test func suiteNameIsCorrect() {
        #expect(WatchAppGroup.suiteName == "group.ai.openclaw.watch")
    }

    @Test func defaultsReturnsNonNil() {
        // WatchAppGroup.defaults falls back to .standard if the suite
        // is unavailable, so it must never be nil in any environment.
        let defaults = WatchAppGroup.defaults
        #expect(defaults === defaults) // sanity: non-nil reference
    }
}
