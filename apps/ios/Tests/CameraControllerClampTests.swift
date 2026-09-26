import OpenClawKit
import Testing
@testable import OpenClaw

struct CameraControllerClampTests {
    @Test func `clamp quality defaults and bounds`() {
        #expect(CameraController.clampQuality(nil) == 0.9)
        #expect(CameraController.clampQuality(0.0) == 0.05)
        #expect(CameraController.clampQuality(0.049) == 0.05)
        #expect(CameraController.clampQuality(0.05) == 0.05)
        #expect(CameraController.clampQuality(0.5) == 0.5)
        #expect(CameraController.clampQuality(1.0) == 1.0)
        #expect(CameraController.clampQuality(1.1) == 1.0)
    }

    @Test func `clamp duration defaults and bounds`() {
        #expect(CaptureRateLimits.clampDurationMs(nil, defaultMs: 3000) == 3000)
        #expect(CaptureRateLimits.clampDurationMs(0, defaultMs: 3000) == 250)
        #expect(CaptureRateLimits.clampDurationMs(249, defaultMs: 3000) == 250)
        #expect(CaptureRateLimits.clampDurationMs(250, defaultMs: 3000) == 250)
        #expect(CaptureRateLimits.clampDurationMs(1000, defaultMs: 3000) == 1000)
        #expect(CaptureRateLimits.clampDurationMs(60000, defaultMs: 3000) == 60000)
        #expect(CaptureRateLimits.clampDurationMs(60001, defaultMs: 3000) == 60000)
    }

    @Test func `preferred facing defaults and explicit override`() {
        #expect(NodeAppModel.cameraFacingPreference(rawValue: nil) == .front)
        #expect(NodeAppModel.cameraFacingPreference(rawValue: "back") == .back)
        #expect(CameraController.resolveFacing(nil, defaultFacing: .back) == .back)
        #expect(CameraController.resolveFacing(.front, defaultFacing: .back) == .front)
    }
}
