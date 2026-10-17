#if os(macOS) || os(iOS)
import Foundation
import Testing

struct NativeGatewayWebSocketFixtureTests {
    @Test
    func `RPC wait after fixture stop throws cancellation`() async throws {
        let fixture = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [])
        defer { fixture.stop() }
        fixture.stop()

        await #expect(throws: CancellationError.self) {
            _ = try await fixture.waitForRPC(method: "users.self")
        }
    }
}
#endif
