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

    func testValidatedSeedBounds() {
        XCTAssertEqual(TalkTTSValidation.validatedSeed(0), 0)
        XCTAssertEqual(TalkTTSValidation.validatedSeed(1234), 1234)
        XCTAssertNil(TalkTTSValidation.validatedSeed(-1))
    }
}
