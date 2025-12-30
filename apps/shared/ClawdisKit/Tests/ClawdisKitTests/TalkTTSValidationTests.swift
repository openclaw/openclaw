import XCTest
@testable import ClawdisKit

final class TalkTTSValidationTests: XCTestCase {
    func testResolveSpeedUsesRateWPMWhenProvided() {
        let resolved = TalkTTSValidation.resolveSpeed(speed: nil, rateWPM: 175)
        XCTAssertNotNil(resolved)
        XCTAssertEqual(resolved ?? 0, 1.0, accuracy: 0.0001)
        XCTAssertNil(TalkTTSValidation.resolveSpeed(speed: nil, rateWPM: 400))
    }

    func testValidatedUnitBounds() {
        XCTAssertEqual(TalkTTSValidation.validatedUnit(0), 0)
        XCTAssertEqual(TalkTTSValidation.validatedUnit(1), 1)
        XCTAssertNil(TalkTTSValidation.validatedUnit(-0.01))
        XCTAssertNil(TalkTTSValidation.validatedUnit(1.01))
    }

    func testValidatedStability() {
        XCTAssertEqual(TalkTTSValidation.validatedStability(0, modelId: "eleven_v3"), 0)
        XCTAssertEqual(TalkTTSValidation.validatedStability(0.5, modelId: "eleven_v3"), 0.5)
        XCTAssertEqual(TalkTTSValidation.validatedStability(1, modelId: "eleven_v3"), 1)
        XCTAssertNil(TalkTTSValidation.validatedStability(0.7, modelId: "eleven_v3"))
        XCTAssertEqual(TalkTTSValidation.validatedStability(0.7, modelId: "eleven_multilingual_v2"), 0.7)
    }

    func testValidatedSeedBounds() {
        XCTAssertEqual(TalkTTSValidation.validatedSeed(0), 0)
        XCTAssertEqual(TalkTTSValidation.validatedSeed(1234), 1234)
        XCTAssertNil(TalkTTSValidation.validatedSeed(-1))
    }

    func testValidatedLatencyTier() {
        XCTAssertEqual(TalkTTSValidation.validatedLatencyTier(0), 0)
        XCTAssertEqual(TalkTTSValidation.validatedLatencyTier(4), 4)
        XCTAssertNil(TalkTTSValidation.validatedLatencyTier(-1))
        XCTAssertNil(TalkTTSValidation.validatedLatencyTier(5))
    }

    func testPcmSampleRateParse() {
        XCTAssertEqual(TalkTTSValidation.pcmSampleRate(from: "pcm_44100"), 44100)
        XCTAssertNil(TalkTTSValidation.pcmSampleRate(from: "mp3_44100_128"))
        XCTAssertNil(TalkTTSValidation.pcmSampleRate(from: "pcm_bad"))
    }
}
