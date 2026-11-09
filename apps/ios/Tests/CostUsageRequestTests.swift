import Foundation
import Testing
@testable import OpenClaw

struct CostUsageRequestTests {
    @Test func `monthly usage requests all agents with local day boundaries`() throws {
        let timeZone = try #require(TimeZone(secondsFromGMT: 345 * 60))
        let data = Data(CostUsageRequest.monthParamsJSON(timeZone: timeZone).utf8)
        let params = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(params["agentScope"] as? String == "all")
        #expect(params["days"] as? Int == 31)
        #expect(params["mode"] as? String == "specific")
        #expect(params["timeZone"] as? String == timeZone.identifier)
        #expect(params["utcOffset"] as? String == "UTC+5:45")
    }
}
