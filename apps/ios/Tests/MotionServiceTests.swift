import Testing
@testable import OpenClaw

@Suite(.serialized) struct MotionServiceTests {
    @Test func errorDomainIsCorrect() {
        #expect(MotionService.errorDomain == "Motion")
    }
}
