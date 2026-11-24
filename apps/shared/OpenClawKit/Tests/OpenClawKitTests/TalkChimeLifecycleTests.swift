import OpenClawKit
import Testing

struct TalkChimeLifecycleTests {
    @Test func `ready and clean end cue once per call`() {
        var call = TalkChimeLifecycle()
        #expect(call.end(clean: true, enabled: true) == nil)
        #expect(call.ready(enabled: true) == .wake)
        // Listening again after a turn, reconnect, or replacement is still the same call.
        #expect(call.ready(enabled: true) == nil)
        #expect(call.end(clean: true, enabled: true) == .bye)
        #expect(call.end(clean: true, enabled: true) == nil)
        #expect(call.ready(enabled: true) == .wake)
    }

    @Test func `error end and disabled preference are silent`() {
        var call = TalkChimeLifecycle()
        #expect(call.ready(enabled: false) == nil)
        #expect(call.ready(enabled: true) == nil)
        #expect(call.end(clean: false, enabled: true) == nil)
        #expect(call.end(clean: true, enabled: true) == nil)
        #expect(call.ready(enabled: true) == .wake)
        #expect(call.end(clean: true, enabled: false) == nil)
    }

    @Test func `native reply cues once per resumed listen`() {
        var call = TalkChimeLifecycle()
        _ = call.ready(enabled: false)
        #expect(call.resumedListening(isRealtime: false, enabled: true) == nil)
        for _ in 0..<2 {
            call.replyFinished(isRealtime: false)
            #expect(call.resumedListening(isRealtime: false, enabled: true) == .follow)
            #expect(call.resumedListening(isRealtime: false, enabled: true) == nil)
        }
        call.replyFinished(isRealtime: false)
        #expect(call.resumedListening(isRealtime: false, enabled: false) == nil)
        #expect(call.resumedListening(isRealtime: false, enabled: true) == nil)
    }

    @Test func `reply never cues on realtime or after end`() {
        var call = TalkChimeLifecycle()
        _ = call.ready(enabled: true)
        call.replyFinished(isRealtime: true)
        #expect(call.resumedListening(isRealtime: false, enabled: true) == nil)
        call.replyFinished(isRealtime: false)
        #expect(call.resumedListening(isRealtime: true, enabled: true) == nil)
        call.replyFinished(isRealtime: false)
        _ = call.end(clean: true, enabled: true)
        call.replyFinished(isRealtime: false)
        #expect(call.resumedListening(isRealtime: false, enabled: true) == nil)
    }
}
