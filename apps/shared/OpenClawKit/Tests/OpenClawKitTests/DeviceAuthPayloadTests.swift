import Foundation
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

    @Test("native app device identity ignores inherited shared state dir")
    func nativeAppDeviceIdentityIgnoresInheritedSharedStateDir() {
        let sharedStateDir = "/tmp/openclaw-shared-state-from-shell"
        Self.withEnv([
            "OPENCLAW_STATE_DIR": sharedStateDir,
            "OPENCLAW_DEVICE_STATE_DIR": nil,
            "OPENCLAW_MAC_ALLOW_STATE_DIR_IDENTITY": nil,
            "__CFBundleIdentifier": nil,
        ]) {
            let url = DeviceIdentityPaths.stateDirURL(bundleIdentifier: "ai.openclaw.mac")
            #expect(url.path != sharedStateDir)
            #expect(url.path.hasSuffix("/OpenClaw") || url.lastPathComponent == "openclaw")
        }
    }

    @Test("native app device identity honors explicit device state dir")
    func nativeAppDeviceIdentityHonorsExplicitDeviceStateDir() {
        let sharedStateDir = "/tmp/openclaw-shared-state-from-shell"
        let deviceStateDir = "/tmp/openclaw-device-state-explicit"
        Self.withEnv([
            "OPENCLAW_STATE_DIR": sharedStateDir,
            "OPENCLAW_DEVICE_STATE_DIR": deviceStateDir,
            "OPENCLAW_MAC_ALLOW_STATE_DIR_IDENTITY": nil,
            "__CFBundleIdentifier": nil,
        ]) {
            #expect(DeviceIdentityPaths.stateDirURL(bundleIdentifier: "ai.openclaw.mac").path == deviceStateDir)
        }
    }

    private static func withEnv(_ values: [String: String?], body: () -> Void) {
        let previous = values.mapValues { _ -> String? in nil }
        var saved = previous
        for key in values.keys {
            if let raw = getenv(key) {
                saved[key] = String(cString: raw)
            }
        }
        for (key, value) in values {
            if let value {
                setenv(key, value, 1)
            } else {
                unsetenv(key)
            }
        }
        defer {
            for (key, value) in saved {
                if let value {
                    setenv(key, value, 1)
                } else {
                    unsetenv(key)
                }
            }
        }
        body()
    }
}
