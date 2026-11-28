import SwiftUI
import Testing
import UIKit
@testable import OpenClawChatUI

@MainActor
struct ChatTranscriptTimeTests {
    @Test func `clock uses device hour cycle and local day`() throws {
        let zone = try #require(TimeZone(secondsFromGMT: -3600))
        let midnightUTC = try #require(ISO8601DateFormatter().date(from: "2026-11-27T00:50:00Z"))
        for (locale, expected) in [("en-US-u-hc-h12", "11:50 PM"), ("en-US-u-hc-h23", "23:50")] {
            for offset in [0, 86400] {
                let clock = try #require(ChatMessageClock(
                    timestamp: midnightUTC.timeIntervalSince1970 * 1000,
                    now: midnightUTC.addingTimeInterval(Double(offset)), locale: Locale(identifier: locale),
                    timeZone: zone))
                #expect(clock.time.replacingOccurrences(of: " ", with: " ") == expected)
                #expect(clock.day == (offset == 0 ? nil : "Nov 26"))
            }
        }
        #expect(ChatMessageClock(timestamp: nil) == nil)
    }

    @Test func `user status only takes space for visible send states`() {
        for phase: ChatUserSendPresentation.Phase? in [nil, .sending, .uploading, .queued, .notSent, .deliveryUnknown] {
            let host = UIHostingController(rootView: VStack(spacing: 4) {
                Color.clear.frame(height: 40)
                ChatUserMessageStatus(send: phase.map { ChatUserSendPresentation(phase: $0) })
            })
            let height = host.sizeThatFits(in: CGSize(width: 320, height: 500)).height
            switch phase {
            case nil, .sending, .uploading: #expect(height == 40)
            case .queued, .notSent, .deliveryUnknown: #expect(height > 44)
            }
        }
    }
}
