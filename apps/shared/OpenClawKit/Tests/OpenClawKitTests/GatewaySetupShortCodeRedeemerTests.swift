import Foundation
import OpenClawKit
import Testing

private struct MockSetupCodeHTTPClient: GatewaySetupShortCodeHTTPClient {
    let handler: @Sendable (URLRequest) async throws -> (Data, URLResponse)

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await self.handler(request)
    }
}

@Suite struct GatewaySetupShortCodeRedeemerTests {
    @Test func normalizesGroupedShortCodes() {
        #expect(GatewaySetupShortCode.normalize(" abcd-2345 ") == "ABCD2345")
        #expect(GatewaySetupShortCode.normalize("ABCI2345") == nil)
    }

    @Test func redemptionURLUsesHttpPeerOfWebSocketGateway() {
        let gateway = GatewayConnectDeepLink(
            host: "openclaw.local",
            port: 18789,
            tls: false,
            bootstrapToken: nil,
            token: nil,
            password: nil)

        #expect(
            GatewaySetupShortCodeRedeemer.redemptionURL(for: gateway)?.absoluteString ==
                "http://openclaw.local:18789/api/v1/pairing/setup-code/redeem")
    }

    @Test func redeemPostsCodeAndReturnsSetupPayloadLink() async throws {
        let gateway = GatewayConnectDeepLink(
            host: "gateway.example.com",
            port: 443,
            tls: true,
            bootstrapToken: nil,
            token: nil,
            password: nil)
        let client = MockSetupCodeHTTPClient { request in
            #expect(request.url?.absoluteString == "https://gateway.example.com:443/api/v1/pairing/setup-code/redeem")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "content-type") == "application/json")
            #expect(String(data: request.httpBody ?? Data(), encoding: .utf8) == #"{"code":"ABCD2345"}"#)
            let data = Data(
                #"{"ok":true,"payload":{"url":"wss://gateway.example.com","bootstrapToken":"boot-123"}}"#.utf8)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil)!
            return (data, response)
        }

        let link = try await GatewaySetupShortCodeRedeemer(client: client).redeem("abcd-2345", through: gateway)

        #expect(link == GatewayConnectDeepLink(
            host: "gateway.example.com",
            port: 443,
            tls: true,
            bootstrapToken: "boot-123",
            token: nil,
            password: nil))
    }

    @Test func redeemMapsInvalidOrExpiredResponses() async {
        let gateway = GatewayConnectDeepLink(
            host: "openclaw.local",
            port: 18789,
            tls: false,
            bootstrapToken: nil,
            token: nil,
            password: nil)
        let client = MockSetupCodeHTTPClient { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil)!
            return (Data(#"{"ok":false}"#.utf8), response)
        }

        await #expect(throws: GatewaySetupShortCodeRedeemer.RedeemError.invalidOrExpired) {
            _ = try await GatewaySetupShortCodeRedeemer(client: client).redeem("ABCD2345", through: gateway)
        }
    }
}
