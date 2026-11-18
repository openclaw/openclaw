import Foundation
import Testing
@testable import OpenClaw

struct MacOpenClawIDDashboardProxyTests {
    @Test
    func `cookie rules keep the operator cookie on the proxy origin only`() throws {
        let source = try MacOpenClawIDDashboardProxy.cookieRules(for: #require(URL(string: "http://127.0.0.1:52811/")))
        let rules = try #require(
            try JSONSerialization.jsonObject(with: Data(source.utf8)) as? [[String: [String: String]]])
        #expect(rules.first?["action"]?["type"] == "block-cookies")
        #expect(rules.first?["trigger"]?["url-filter"] == ".*")
        let allowed = rules.dropFirst().compactMap { $0["trigger"]?["url-filter"] }
        #expect(allowed == [#"^http://127\.0\.0\.1:52811/"#, #"^ws://127\.0\.0\.1:52811/"#])
        for pattern in allowed {
            let regex = try NSRegularExpression(pattern: pattern)
            for other in ["http://127.0.0.1:52812/", "http://127.0.0.1:5281/x", "http://localhost:52811/"] {
                #expect(regex.firstMatch(in: other, range: NSRange(other.startIndex..., in: other)) == nil)
            }
        }
    }
}
