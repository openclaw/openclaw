import Foundation
import Testing
@testable import OpenClaw

struct MacNodeBrowserProxyTests {
    @Test func requestUsesBrowserControlEndpointAndWrapsResult() async throws {
        let proxy = MacNodeBrowserProxy(
            endpointProvider: {
                MacNodeBrowserProxy.Endpoint(
                    baseURL: URL(string: "http://127.0.0.1:18791")!,
                    token: "test-token",
                    password: nil)
            },
            performRequest: { request in
                #expect(request.url?.absoluteString == "http://127.0.0.1:18791/tabs?profile=work")
                #expect(request.httpMethod == "GET")
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")

                let body = Data(#"{"tabs":[{"id":"tab-1"}]}"#.utf8)
                let url = try #require(request.url)
                let response = try #require(
                    HTTPURLResponse(
                        url: url,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "application/json"]))
                return (body, response)
            })

        let payloadJSON = try await proxy.request(
            paramsJSON: #"{"method":"GET","path":"/tabs","profile":"work"}"#)
        let payload = try #require(
            JSONSerialization.jsonObject(with: Data(payloadJSON.utf8)) as? [String: Any])
        let result = try #require(payload["result"] as? [String: Any])
        let tabs = try #require(result["tabs"] as? [[String: Any]])

        #expect(payload["files"] == nil)
        #expect(tabs.count == 1)
        #expect(tabs[0]["id"] as? String == "tab-1")
    }
}
