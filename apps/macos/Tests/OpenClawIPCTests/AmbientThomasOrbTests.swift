import SwiftUI
import Testing
@testable import OpenClaw

@MainActor
struct AmbientThomasOrbTests {
    @Test func `motion profiles match Canvas-like behavior by state`() {
        let ready = AmbientThomasOrbMotionProfile.profile(for: .ready)
        let sending = AmbientThomasOrbMotionProfile.profile(for: .sending)
        let error = AmbientThomasOrbMotionProfile.profile(for: .error)

        #expect(sending.orbitSeconds < ready.orbitSeconds)
        #expect(sending.pulseSeconds < ready.pulseSeconds)
        #expect(error.floatAmplitude < ready.floatAmplitude)
    }

    @Test func `motion samples travel between floating anchor points`() {
        let first = AmbientThomasOrbMotionSample.sample(time: 0, state: .focused)
        let next = AmbientThomasOrbMotionSample.sample(time: 3.2, state: .focused)

        #expect(abs(first.offsetX - next.offsetX) > 8)
        #expect(abs(first.offsetY - next.offsetY) > 8)
        #expect(abs(next.tiltDegrees) > 0.1)
    }

    @Test func `Thomas orb view builds body for working state`() {
        let view = AmbientThomasOrbView(state: .working)

        _ = view.body
    }
}
