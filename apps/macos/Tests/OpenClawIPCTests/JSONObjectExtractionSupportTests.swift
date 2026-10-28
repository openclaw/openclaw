import Foundation
import Testing
@testable import OpenClaw

struct JSONObjectExtractionSupportTests {
    @Test(arguments: ["", "no JSON", "{", "}", "} diagnostic {"])
    func `ignores output without JSON object`(_ output: String) {
        #expect(JSONObjectExtractionSupport.extract(from: output) == nil)
    }

    @Test func `extracts service error from noisy output`() throws {
        let output = #"warning before {"error":"service failed","hints":["retry","inspect logs","extra"]} after"#
        let result = try #require(JSONObjectExtractionSupport.extract(from: output))
        #expect(result.text == #"{"error":"service failed","hints":["retry","inspect logs","extra"]}"#)
        #expect(result.message == "service failed (retry · inspect logs)")
    }
}
