import Foundation
import Testing
@testable import OpenClawKit

struct SystemCommandsTests {
    @Test func systemWhichParamsDecodeDefaultsMissingBinsToEmptyArray() throws {
        let data = Data("{}".utf8)
        let decoded = try JSONDecoder().decode(OpenClawSystemWhichParams.self, from: data)
        #expect(decoded.bins.isEmpty)
    }
}
