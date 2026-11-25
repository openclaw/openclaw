import Observation
import SwiftUI
import Synchronization
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
struct ChatVoiceObservationTests {
    @Test(arguments: [false, true])
    func `voice controls observe live levels without subscribing tab construction`(speaking: Bool) {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(talkMode: talkMode, audioAdmissionInitiallyAllowed: false)
        talkMode.isEnabled = true
        talkMode.isListening = !speaking
        talkMode.isSpeaking = speaking
        talkMode.micLevel = 0.2
        talkMode.playbackLevel = 0.2
        let parentInvalidated = Mutex(false)
        let (avatar, control) = withObservationTracking {
            (ChatVoiceAvatar(talkMode: talkMode) { Color.clear }, ChatProTab.talkControl(appModel: appModel))
        } onChange: {
            parentInvalidated.withLock { $0 = true }
        }
        let avatarInvalidated = Mutex(false)
        let waveform = withObservationTracking {
            avatar.body
        } onChange: {
            avatarInvalidated.withLock { $0 = true }
        }
        let glyphInvalidated = Mutex(false)
        let glyph = ChatTalkButtonGlyph(control: control)
        withObservationTracking {
            _ = glyph.body
        } onChange: {
            glyphInvalidated.withLock { $0 = true }
        }
        #expect(control.resolvedLevel == 0.2)
        #expect(waveform.phase == (speaking ? .speaking(level: 0.2) : .listening(level: 0.2, speechActive: false)))

        if speaking {
            talkMode.playbackLevel = 0.8
        } else {
            talkMode.micLevel = 0.8
        }
        #expect(!parentInvalidated.withLock { $0 })
        #expect(avatarInvalidated.withLock { $0 })
        #expect(glyphInvalidated.withLock { $0 })
        #expect(control.resolvedLevel == 0.8)
        #expect(avatar.body.phase == (speaking ? .speaking(level: 0.8) : .listening(level: 0.8, speechActive: false)))

        // The header keeps its synthetic pulse; the existing button contract uses zero for missing playback.
        if speaking {
            talkMode.playbackLevel = nil
            #expect(avatar.body.phase == .speaking(level: nil))
            #expect(control.resolvedLevel == 0)
        }
        talkMode.isEnabled = false
        talkMode.isListening = false
        talkMode.isSpeaking = false
        #expect(control.resolvedLevel == 0)
        #expect(avatar.body.phase == .idle)
    }
}
