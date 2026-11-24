import Foundation
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

#if os(iOS) || os(macOS)
@MainActor
struct TalkChimePreferenceUpgradeTests {
    private func makeDefaults() throws -> (UserDefaults, String) {
        let name = "talk-chime-upgrade-\(UUID().uuidString)"
        return (try #require(UserDefaults(suiteName: name)), name)
    }

    @Test func `defaults saved before chimes existed read all three cues on`() throws {
        let (defaults, name) = try self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        // A snapshot from the previous release: other Talk preferences, none of the chime keys.
        defaults.set(false, forKey: "talk.phaseSounds")
        defaults.set(true, forKey: "talk.pushToTalk")
        defaults.set("elevenlabs", forKey: "talk.voice")

        for key in [
            TalkChimePlayer.startPreferenceKey,
            TalkChimePlayer.endPreferenceKey,
            TalkChimePlayer.replyPreferenceKey,
        ] {
            #expect(defaults.object(forKey: key) == nil)
            #expect(TalkChimePlayer.isEnabled(key, in: defaults))
        }
        // Reading never writes: the stored snapshot is unchanged.
        #expect(defaults.object(forKey: TalkChimePlayer.startPreferenceKey) == nil)
        #expect(defaults.bool(forKey: "talk.phaseSounds") == false)
    }

    @Test func `an explicit stored choice survives and a mixed snapshot reads per key`() throws {
        let (defaults, name) = try self.makeDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(false, forKey: TalkChimePlayer.endPreferenceKey)
        defaults.set(true, forKey: TalkChimePlayer.replyPreferenceKey)

        #expect(TalkChimePlayer.isEnabled(TalkChimePlayer.startPreferenceKey, in: defaults))
        #expect(!TalkChimePlayer.isEnabled(TalkChimePlayer.endPreferenceKey, in: defaults))
        #expect(TalkChimePlayer.isEnabled(TalkChimePlayer.replyPreferenceKey, in: defaults))
    }
}
#endif
