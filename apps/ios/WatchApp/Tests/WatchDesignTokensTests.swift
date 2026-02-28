import Testing

@testable import OpenClawWatch

@Suite("WatchDesignTokens")
struct WatchDesignTokensTests {
    @Test func spacingValuesArePositive() {
        #expect(WatchDesignTokens.spacingXS > 0)
        #expect(WatchDesignTokens.spacingSM > 0)
        #expect(WatchDesignTokens.spacingMD > 0)
        #expect(WatchDesignTokens.spacingLG > 0)
        #expect(WatchDesignTokens.spacingXL > 0)
    }

    @Test func spacingValuesAreOrdered() {
        #expect(WatchDesignTokens.spacingXS < WatchDesignTokens.spacingSM)
        #expect(WatchDesignTokens.spacingSM < WatchDesignTokens.spacingMD)
        #expect(WatchDesignTokens.spacingMD < WatchDesignTokens.spacingLG)
        #expect(WatchDesignTokens.spacingLG < WatchDesignTokens.spacingXL)
    }
}
