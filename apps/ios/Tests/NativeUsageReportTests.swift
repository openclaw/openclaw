import Foundation
import Testing
@testable import OpenClaw

struct NativeUsageReportTests {
    @Test func `missing prices are not free`() throws {
        func cost(_ amount: Double, missing: Int) throws -> Double? {
            let payload = try JSONSerialization.data(withJSONObject: [
                "input": 40,
                "output": 12,
                "cacheRead": 15,
                "cacheWrite": 0,
                "totalTokens": 67,
                "totalCost": amount,
                "missingCostEntries": missing,
            ])
            return try JSONDecoder().decode(NativeUsageReport.Totals.self, from: payload).recordedCost
        }
        #expect(try cost(0, missing: 3) == nil)
        #expect(try cost(0, missing: 0) == 0)
        #expect(try cost(0.18, missing: 2) == 0.18)
    }
}
