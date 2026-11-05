import Foundation
import Testing
@testable import OpenClawKit

struct DeviceCommandsTests {
    @Test func `battery payload decodes without the additive percentage`() throws {
        let json = Data(#"{"level":0.5,"state":"unplugged","lowPowerModeEnabled":false}"#.utf8)

        let battery = try JSONDecoder().decode(OpenClawBatteryStatusPayload.self, from: json)

        #expect(battery.level == 0.5)
        #expect(battery.levelPercent == nil)
        #expect(battery.state == .unplugged)
        #expect(!battery.lowPowerModeEnabled)
    }

    @Test func `battery percentage preserves the fractional wire contract`() throws {
        let battery = OpenClawBatteryStatusPayload(
            level: 0.125,
            state: .charging,
            lowPowerModeEnabled: true,
            levelPercent: 13)

        let encoded = try JSONEncoder().encode(battery)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let decoded = try JSONDecoder().decode(OpenClawBatteryStatusPayload.self, from: encoded)
        let legacy = try JSONDecoder().decode(LegacyBatteryStatus.self, from: encoded)

        #expect(object["levelPercent"] as? Int == 13)
        #expect(decoded == battery)
        #expect(legacy.level == 0.125)
        #expect(legacy.state == .charging)
        #expect(legacy.lowPowerModeEnabled)
    }

    @Test func `unavailable battery readings omit both numeric fields`() throws {
        let battery = OpenClawBatteryStatusPayload(
            level: nil,
            state: .unknown,
            lowPowerModeEnabled: false)

        let encoded = try JSONEncoder().encode(battery)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let decoded = try JSONDecoder().decode(OpenClawBatteryStatusPayload.self, from: encoded)

        #expect(object["level"] == nil)
        #expect(object["levelPercent"] == nil)
        #expect(decoded == battery)
    }

    private struct LegacyBatteryStatus: Decodable {
        let level: Double?
        let state: OpenClawBatteryState
        let lowPowerModeEnabled: Bool
    }
}
