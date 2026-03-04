import Foundation
import Testing
@testable import OpenClaw

@Suite struct CompanyDeskHelpersTests {
    @Test func makeSessionKeyReturnsUUIDString() {
        let key = CompanyDeskViewModel.makeSessionKey()
        #expect(UUID(uuidString: key) != nil)
    }

    @Test func makeSessionKeyProducesDistinctValues() {
        let first = CompanyDeskViewModel.makeSessionKey()
        let second = CompanyDeskViewModel.makeSessionKey()
        #expect(first != second)
    }

    @Test func phoneEnvelopeFormatsHeaderAndBody() {
        let envelope = CompanyDeskViewModel.phoneEnvelope(
            from: "alpha",
            to: "bravo",
            thread: "main",
            body: "hello world")
        let expected = "FROM=alpha\nTO=bravo\nTHREAD=main\nKIND=internal_sms\n---\nhello world"
        #expect(envelope == expected)
    }

    @Test func phoneEnvelopePreservesMultilineBody() {
        let envelope = CompanyDeskViewModel.phoneEnvelope(
            from: "alpha",
            to: "bravo",
            thread: "ops-1",
            body: "line1\nline2")
        #expect(envelope.hasSuffix("---\nline1\nline2"))
    }
}
