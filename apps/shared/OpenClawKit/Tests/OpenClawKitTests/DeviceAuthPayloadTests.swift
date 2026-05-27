import Testing
@testable import OpenClawKit

@Suite("DeviceAuthPayload")
struct DeviceAuthPayloadTests {
    @Test("builds canonical v3 payload vector")
    func buildsCanonicalV3PayloadVector() {
        let payload = GatewayDeviceAuthPayload.buildV3(
            deviceId: "dev-1",
            clientId: "openclaw-macos",
            clientMode: "ui",
            role: "operator",
            scopes: ["operator.admin", "operator.read"],
            signedAtMs: 1_700_000_000_000,
            token: "tok-123",
            nonce: "nonce-abc",
            platform: "  IOS  ",
            deviceFamily: "  iPhone  ")
        #expect(
            payload
                == "v3|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000|tok-123|nonce-abc|ios|iphone")
    }

    @Test("normalizes metadata with ASCII-only lowercase")
    func normalizesMetadataWithAsciiLowercase() {
        #expect(GatewayDeviceAuthPayload.normalizeMetadataField("  İOS  ") == "İos")
        #expect(GatewayDeviceAuthPayload.normalizeMetadataField("  MAC  ") == "mac")
        #expect(GatewayDeviceAuthPayload.normalizeMetadataField(nil) == "")
    }
}
