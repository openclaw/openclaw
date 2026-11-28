import Testing
@testable import OpenClaw

struct RootSidebarPullToSearchTests {
    @Test func `a pull that starts at the top tracks the distance and opens past the threshold`() {
        var pull = RootSidebarPullToSearch()
        pull.dragBegan(offset: 0)
        pull.scrolled(offset: -RootSidebarPullToSearch.threshold / 2)
        #expect(abs(pull.progress - 0.5) < 0.001)
        #expect(!pull.hasReachedThreshold)
        pull.scrolled(offset: -RootSidebarPullToSearch.threshold)
        #expect(pull.hasReachedThreshold)
        let opened = pull.dragEnded()
        #expect(opened)
        #expect(pull.progress == 0)
    }

    @Test func `a drag that starts below the top never arms, even when it reaches the top`() {
        var pull = RootSidebarPullToSearch()
        pull.dragBegan(offset: 240)
        pull.scrolled(offset: 0)
        pull.scrolled(offset: -100)
        #expect(pull.progress == 0)
        #expect(!pull.hasReachedThreshold)
        let opened = pull.dragEnded()
        #expect(!opened)
    }

    @Test func `an early release opens nothing and the circle settles with the list`() {
        var pull = RootSidebarPullToSearch()
        pull.dragBegan(offset: 0)
        pull.scrolled(offset: -80) // Past the former 64-point threshold.
        #expect(!pull.hasReachedThreshold)
        let opened = pull.dragEnded()
        #expect(!opened)
        #expect(abs(pull.progress - 80 / RootSidebarPullToSearch.threshold) < 0.001)
        pull.scrolled(offset: -110) // Momentum after release cannot arm search.
        #expect(!pull.hasReachedThreshold)
        pull.scrolled(offset: -10)
        #expect(abs(pull.progress - 10 / RootSidebarPullToSearch.threshold) < 0.001)
        pull.scrolled(offset: 0)
        #expect(pull.progress == 0)
        pull.scrolled(offset: -30)
        #expect(pull.progress == 0)
    }

    @Test func `pulling back above the threshold before release cancels`() {
        var pull = RootSidebarPullToSearch()
        pull.dragBegan(offset: 0)
        pull.scrolled(offset: -RootSidebarPullToSearch.threshold)
        #expect(pull.hasReachedThreshold)
        pull.scrolled(offset: -20)
        let opened = pull.dragEnded()
        #expect(!opened)
    }
}
