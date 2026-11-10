import Testing
@testable import OpenClaw

@MainActor
struct OnboardingPageTests {
    @Test(arguments: zip([0, 1, 2, 3, 4, 5], [0, 1, 2, 2, 3, 4]))
    func `removing preparation preserves the semantic page instead of skipping AI`(cursor: Int, expected: Int) {
        #expect(OnboardingView.pageCursor(
            preserving: cursor, from: [0, 1, 2, 3, 5, 9], to: [0, 1, 3, 5, 9]) == expected)
    }

    @Test(arguments: zip([-1, 0, 1, 2, 3, Int.max], [0, 0, 1, 2, 2, 2]))
    func `pager stays on a visible page after the installed CLI page disappears`(cursor: Int, expected: Int) {
        // AI setup starts at cursor 3 while the CLI probe is pending. Once
        // installed, the three-page flow must still render its final page.
        #expect(OnboardingView.visiblePageCursor(cursor, pageCount: 3) == expected)
    }
}
