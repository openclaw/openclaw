import Foundation
import Testing
@testable import OpenClaw

struct MacNodeBrowserProxyTests {
    @Test func `request uses browser control endpoint and wraps result`() async throws {
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

    // Regression test: nested POST bodies must serialize without __SwiftValue crashes.
    @Test func postRequestSerializesNestedBodyWithoutCrash() async throws {
        actor BodyCapture {
            private var body: Data?

            func set(_ body: Data?) {
                self.body = body
            }

            func get() -> Data? {
                self.body
            }
        }

        let capturedBody = BodyCapture()
        let proxy = MacNodeBrowserProxy(
            endpointProvider: {
                MacNodeBrowserProxy.Endpoint(
                    baseURL: URL(string: "http://127.0.0.1:18791")!,
                    token: nil,
                    password: nil)
            },
            performRequest: { request in
                await capturedBody.set(request.httpBody)
                let url = try #require(request.url)
                let response = try #require(
                    HTTPURLResponse(
                        url: url,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: nil))
                return (Data(#"{"ok":true}"#.utf8), response)
            })

        _ = try await proxy.request(
            paramsJSON: #"{"method":"POST","path":"/action","body":{"nested":{"key":"val"},"arr":[1,2]}}"#)

        let bodyData = try #require(await capturedBody.get())
        let parsed = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        let nested = try #require(parsed["nested"] as? [String: Any])
        #expect(nested["key"] as? String == "val")
        let arr = try #require(parsed["arr"] as? [Any])
        #expect(arr.count == 2)
    }

    // MARK: - sanitizeForJSON

    @Test func sanitizeForJSONConvertsNonSerializableValuesToStrings() {
        // A custom Swift struct that NSJSONSerialization cannot handle.
        struct OpaqueValue: CustomStringConvertible {
            let id: Int
            var description: String { "OpaqueValue(\(id))" }
        }

        let result = MacNodeBrowserProxy.sanitizeForJSON(OpaqueValue(id: 42))
        #expect(result as? String == "OpaqueValue(42)")
    }

    @Test func sanitizeForJSONRecursesIntoDictionaries() throws {
        struct Opaque: CustomStringConvertible {
            var description: String { "opaque" }
        }

        let input: [String: Any] = [
            "ok": true,
            "count": 3,
            "nested": ["inner": Opaque()],
        ]
        let result = MacNodeBrowserProxy.sanitizeForJSON(input)
        let dict = try #require(result as? [String: Any])
        #expect(dict["ok"] as? Bool == true)
        #expect(dict["count"] as? Int == 3)
        let nested = try #require(dict["nested"] as? [String: Any])
        #expect(nested["inner"] as? String == "opaque")
    }

    @Test func sanitizeForJSONRecursesIntoArrays() throws {
        struct Opaque: CustomStringConvertible {
            var description: String { "item" }
        }

        let input: [Any] = [1, "two", Opaque()]
        let result = MacNodeBrowserProxy.sanitizeForJSON(input)
        let arr = try #require(result as? [Any])
        #expect(arr.count == 3)
        #expect(arr[0] as? Int == 1)
        #expect(arr[1] as? String == "two")
        #expect(arr[2] as? String == "item")
    }

    @Test func sanitizeForJSONPreservesJSONSafeValues() throws {
        let dict: [String: Any] = ["a": 1, "b": "hello", "c": true, "d": NSNull()]
        let result = MacNodeBrowserProxy.sanitizeForJSON(dict)
        // Should be passable to NSJSONSerialization without throwing.
        let data = try JSONSerialization.data(withJSONObject: result)
        let parsed = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(parsed["a"] as? Int == 1)
        #expect(parsed["b"] as? String == "hello")
        #expect(parsed["c"] as? Bool == true)
    }

    // Regression: POST request body is correctly serialized end-to-end.
    // The sanitizer fast-path handles valid JSON; non-serializable values
    // are exercised at unit level in sanitizeForJSONConvertsNonSerializableValuesToStrings.
    @Test func postRequestSanitizesBodyDuringSerialization() async throws {
        actor BodyCapture {
            private var body: Data?
            func set(_ body: Data?) { self.body = body }
            func get() -> Data? { self.body }
        }

        let capturedBody = BodyCapture()
        let proxy = MacNodeBrowserProxy(
            endpointProvider: {
                MacNodeBrowserProxy.Endpoint(
                    baseURL: URL(string: "http://127.0.0.1:18791")!,
                    token: nil,
                    password: nil)
            },
            performRequest: { request in
                await capturedBody.set(request.httpBody)
                let url = try #require(request.url)
                let response = try #require(
                    HTTPURLResponse(
                        url: url,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: nil))
                return (Data(#"{"ok":true}"#.utf8), response)
            })

        // Encode a body that, after AnyCodable decoding, is fine.
        // The sanitization layer ensures no crash even if the gateway
        // sends something unexpected in the future.
        _ = try await proxy.request(
            paramsJSON: #"{"method":"POST","path":"/action","body":{"key":"val"}}"#)

        let bodyData = try #require(await capturedBody.get())
        let parsed = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        #expect(parsed["key"] as? String == "val")
    }
}
