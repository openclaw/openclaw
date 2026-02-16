import Testing
@testable import OpenClaw

@Suite struct AudioInputDeviceObserverTests {
    @Test func defaultInputMissingIsNotUsable() {
        #expect(!AudioInputDeviceObserver._testHasUsableDefaultInputDevice(
            defaultUID: nil,
            aliveInputUIDs: ["mic-a"]))
    }

    @Test func defaultInputNotAliveIsNotUsable() {
        #expect(!AudioInputDeviceObserver._testHasUsableDefaultInputDevice(
            defaultUID: "mic-a",
            aliveInputUIDs: ["mic-b"]))
    }

    @Test func defaultInputAliveIsUsable() {
        #expect(AudioInputDeviceObserver._testHasUsableDefaultInputDevice(
            defaultUID: "mic-a",
            aliveInputUIDs: ["mic-a", "mic-b"]))
    }
}
