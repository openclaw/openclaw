import Foundation
import Testing
@testable import OpenClaw

struct TalkRealtimeOfferURLPolicyTests {
    private let gateway = URL(string: "ws://192.168.1.20:18789")

    @Test func `https offer URLs on any host are allowed`() throws {
        let url = try #require(URL(string: "https://api.openai.com/v1/realtime/calls"))
        #expect(TalkRealtimeWebRTCSession.isAllowedOfferURL(url, gatewayURL: self.gateway))
        #expect(TalkRealtimeWebRTCSession.isAllowedOfferURL(url, gatewayURL: nil))
    }

    @Test func `http offer URLs on a foreign host are rejected`() throws {
        let url = try #require(URL(string: "http://proxy.example.com/v1/realtime/calls"))
        #expect(!TalkRealtimeWebRTCSession.isAllowedOfferURL(url, gatewayURL: self.gateway))
        #expect(!TalkRealtimeWebRTCSession.isAllowedOfferURL(url, gatewayURL: nil))
    }

    @Test func `http offer URL with the gateway host and port is allowed`() throws {
        let same = try #require(URL(string: "http://192.168.1.20:18789/v1/realtime/calls"))
        let otherPort = try #require(URL(string: "http://192.168.1.20:9999/v1/realtime/calls"))
        #expect(TalkRealtimeWebRTCSession.isAllowedOfferURL(same, gatewayURL: self.gateway))
        #expect(!TalkRealtimeWebRTCSession.isAllowedOfferURL(otherPort, gatewayURL: self.gateway))
    }
}
