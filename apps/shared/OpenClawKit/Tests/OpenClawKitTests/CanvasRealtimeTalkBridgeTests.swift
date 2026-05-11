import Foundation
import Testing
@testable import OpenClawKit

@Suite struct CanvasRealtimeTalkBridgeTests {
    @Test func consultPayloadCarriesSessionKeyAndTranscript() throws {
        let payload = CanvasRealtimeTalkBridge.consultPayload(
            sessionKey: "agent:main:canvas",
            args: ["question": "What changed?"],
            transcript: [
                ["role": "user", "text": "hello"],
                ["role": "assistant", "text": "hi"],
            ])

        let data = try JSONSerialization.data(withJSONObject: payload)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(decoded["sessionKey"] as? String == "agent:main:canvas")
        let args = try #require(decoded["args"] as? [String: Any])
        #expect(args["question"] as? String == "What changed?")
        let transcript = try #require(decoded["transcript"] as? [[String: String]])
        #expect(transcript.count == 2)
        #expect(transcript.first?["role"] == "user")
    }
}
