import Foundation
import Testing
@testable import OpenClaw

struct TalkModeRuntimeIdleTimeoutTests {
    private let anchor = Date(timeIntervalSince1970: 1000)
    private let idleTimeout: TimeInterval = 30
    private let speechRecognitionGrace: TimeInterval = 1

    @Test func `idle timeout expires at its deadline without speech energy`() {
        #expect(!self.shouldExpire(after: 29.99, speechEnergyAfter: nil))
        #expect(self.shouldExpire(after: 30, speechEnergyAfter: nil))
    }

    @Test func `recent speech energy receives a short recognition grace`() {
        #expect(!self.shouldExpire(after: 30.5, speechEnergyAfter: 30.4))
    }

    @Test func `continuous audio cannot extend the recognition grace`() {
        #expect(self.shouldExpire(after: 31, speechEnergyAfter: 30.99))
    }

    @Test func `stale audio does not delay idle expiry`() {
        #expect(self.shouldExpire(after: 30, speechEnergyAfter: 28.99))
    }

    private func shouldExpire(after elapsed: TimeInterval, speechEnergyAfter: TimeInterval?) -> Bool {
        TalkModeRuntime.shouldExpireIdleTimeout(
            now: self.anchor.addingTimeInterval(elapsed),
            lastInteractionAt: self.anchor,
            idleTimeout: self.idleTimeout,
            lastSpeechEnergyAt: speechEnergyAfter.map(self.anchor.addingTimeInterval),
            speechRecognitionGrace: self.speechRecognitionGrace)
    }
}
