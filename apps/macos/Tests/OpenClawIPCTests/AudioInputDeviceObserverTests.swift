import Foundation
import Testing
@testable import OpenClaw

@Suite struct AudioInputDeviceObserverTests {
    @Test func hasUsableDefaultInputDeviceReturnsBool() {
        // Smoke test: verifies the composition logic runs without crashing.
        // Actual result depends on whether the host has an audio input device.
        let result = AudioInputDeviceObserver.hasUsableDefaultInputDevice()
        _ = result // suppress unused-variable warning; the assertion is "no crash"
    }

    @Test func hasUsableDefaultInputDeviceConsistentWithComponents() {
        // When no default UID exists, the method must return false.
        // When a default UID exists, the result must match alive-set membership.
        let uid = AudioInputDeviceObserver.defaultInputDeviceUID()
        let alive = AudioInputDeviceObserver.aliveInputDeviceUIDs()
        let expected = uid.map { alive.contains($0) } ?? false
        #expect(AudioInputDeviceObserver.hasUsableDefaultInputDevice() == expected)
    }
}
