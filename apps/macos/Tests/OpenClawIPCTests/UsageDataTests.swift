import Foundation
import Testing
@testable import OpenClaw

struct UsageDataTests {
    @Test(arguments: [
        ("1e100", 100.0, 0),
        ("-1e100", 0.0, 100),
        ("125", 100.0, 0),
        ("-25", 0.0, 100),
        ("25.5", 25.5, 75),
        ("0.5", 0.5, 100),
    ])
    func `decoded provider usage produces bounded menu percentages`(
        wirePercent: String, expectedUsed: Double, expectedRemaining: Int) throws
    {
        let summary = try JSONDecoder().decode(GatewayUsageSummary.self, from: Data("""
        {"updatedAt":0,"providers":[{"provider":"synthetic","displayName":"Synthetic",
         "windows":[{"label":"daily","usedPercent":\(wirePercent)}]}]}
        """.utf8))
        let row = try #require(summary.primaryRows().first)
        #expect(row.usedPercent == expectedUsed)
        #expect(row.remainingPercent == expectedRemaining)
    }
}
