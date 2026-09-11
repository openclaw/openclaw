import AppKit
import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct VoiceOwnerLifecycleTests {
    enum PendingAdmission: CaseIterable, Sendable {
        case permission
        case bootstrap
    }

    @Test func `preview graph construction does not activate voice`() async throws {
        try await withVoiceOwnerFixture(activate: false) { fixture, state, _ in
            #expect(state.isPreview)
            #expect(!state.voiceRuntime.isActive)
            #expect(fixture.log.snapshot().isEmpty)
            state.activateVoice()
            await fixture.requestTalk(false, state: state).value
            #expect(state.voiceRuntime.isActive)
            #expect(state.isPreview)
            #expect(fixture.log.count("publish:false:disabled") == 1)
        }
    }

    @Test func `preference observation admits fresh denied holds`() async throws {
        try await withVoiceOwnerFixture { fixture, state, menu in
            let hotkey = state.voiceRuntime.hotkey
            menu.startVoiceObservation()
            state.voicePushToTalkEnabled = true
            // A positive permission receipt establishes the scheduled Observation
            // route. Repeated down flags do not manufacture a fresh hold.
            try await waitForVoiceOwner("observed preference enables PTT") { [log = fixture.log] in
                await MainActor.run { hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80040)) }
                return log.count("ptt.permission.request") == 1
            }
            hotkey._testUpdateModifierState(modifierFlags: [])
            state.voicePushToTalkEnabled = false
            menu.stopVoiceObservation()
            state.voicePushToTalkEnabled = true
            menu.startVoiceObservation()
            hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80040))
            try await waitForVoiceOwner("fresh denied hold") { [log = fixture.log] in
                log.count("ptt.permission.request") == 2
            }
            hotkey._testUpdateModifierState(modifierFlags: [])
            #expect(fixture.log.count("app.permission.request") == 0)
            #expect(fixture.log.count("talk.permission.request") == 0)
            // Permission receipts do not join PTT's private startup task.
        }
    }

    @Test func `wake refresh waits for last acknowledged lease`() async throws {
        try await withVoiceOwnerFixture(activate: false) { fixture, state, _ in
            let wake = state.voiceRuntime.wake
            state.swabbleEnabled = true
            let first = UUID()
            let second = UUID()
            await wake.pauseForPushToTalk(lease: first)
            await wake.pauseForPushToTalk(lease: second)
            await wake.refresh(state: state)
            await wake.resumeAfterPushToTalk(lease: first)
            await wake.resumeAfterPushToTalk(lease: UUID())
            #expect(fixture.log.count("wake.permission") == 0)
            await wake.resumeAfterPushToTalk(lease: second)
            #expect(fixture.log.count("wake.permission") == 1)
            await wake.resumeAfterPushToTalk(lease: second)
            #expect(fixture.log.count("wake.permission") == 1)
        }
    }

    @Test(arguments: PendingAdmission.allCases)
    func `off invalidates pending runtime before joining shutdown`(pending: PendingAdmission) async throws {
        try await withVoiceOwnerFixture { fixture, state, menu in
            state.voicePushToTalkEnabled = true
            menu.startVoiceObservation()
            switch pending {
            case .permission: await fixture.talkPermission.hold()
            case .bootstrap: await fixture.bootstrap.hold()
            }
            let on = fixture.requestTalk(true, state: state)
            let request = pending == .permission ? "talk.permission.request" : "bootstrap.request"
            try await waitForVoiceOwner("runtime admission pending") { [log = fixture.log] in
                log.count(request) == 1
            }
            await fixture.shutdown.hold()
            let hidden = fixture.log.count("talk.hidden")
            let off = fixture.requestTalk(false, state: state)
            try await waitForVoiceOwner("shutdown entered before admission resolves") { [log = fixture.log] in
                log.count("shutdown.buffered.request") == 1
            }
            #expect(await state.voiceRuntime.talkRuntime.isEnabled == false)
            let repeatedOff = fixture.requestTalk(false, state: state)
            try await waitForVoiceOwner("repeated Off entered its controller") { [log = fixture.log] in
                log.count("talk.hidden") == hidden + 2
            }
            state.voiceRuntime.hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80040))
            await fixture.talkPermission.releaseAll()
            await fixture.bootstrap.releaseAll()
            await on.value
            #expect(fixture.log.count("capture.make") == 0)
            await fixture.shutdown.releaseAll()
            await off.value
            await repeatedOff.value
            state.voiceRuntime.hotkey._testUpdateModifierState(modifierFlags: [])
            state.voiceRuntime.hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80040))
            try await waitForVoiceOwner("PTT available after joined shutdown") { [log = fixture.log] in
                log.count("ptt.permission.request") == 1
            }
            state.voiceRuntime.hotkey._testUpdateModifierState(modifierFlags: [])
            #expect(fixture.log.count("shutdown.buffered.request") == 1)
            #expect(!state.talkEnabled)
        }
    }

    @Test func `replacement talk starts after old audio shutdown`() async throws {
        try await withVoiceOwnerFixture { fixture, state, _ in
            await fixture.requestTalk(true, state: state).value
            #expect(fixture.log.count("capture.start:1") == 1)
            await fixture.shutdown.hold()
            let off = fixture.requestTalk(false, state: state)
            try await waitForVoiceOwner("old shutdown suspended") { [log = fixture.log] in
                log.count("shutdown.buffered.request") == 1
            }
            let replacement = fixture.requestTalk(true, state: state)
            try await waitForVoiceOwner("replacement entered its controller") { [log = fixture.log] in
                log.count("talk.present") == 2
            }
            #expect(await state.voiceRuntime.talkRuntime.isEnabled == false)
            await fixture.shutdown.releaseAll()
            await off.value
            await replacement.value
            #expect(state.talkEnabled)
            #expect(fixture.log.count("capture.start:2") == 1)
            #expect(fixture.log.count("capture.stop:1") == 1)
            #expect(fixture.log.count("capture.stop:2") == 0)
            let events = fixture.log.snapshot()
            let stopped = try #require(events.firstIndex(of: "capture.stop:1"))
            let started = try #require(events.firstIndex(of: "capture.start:2"))
            #expect(stopped < started)
            let buffered = try #require(events.firstIndex(of: "shutdown.buffered.request"))
            let system = try #require(events.firstIndex(of: "shutdown.system"))
            let mlx = try #require(events.firstIndex(of: "shutdown.mlx"))
            #expect(buffered < system && system < mlx && mlx < started)
            await fixture.requestTalk(false, state: state).value
            #expect(fixture.log.count("capture.stop:2") == 1)
            #expect(fixture.log.count("player.stop:1") >= 1)
            #expect(fixture.log.count("player.stop:2") >= 1)
        }
    }

    @Test func `late relay create is closed without capture`() async throws {
        try await withVoiceOwnerFixture { fixture, state, _ in
            await fixture.create.hold()
            let on = fixture.requestTalk(true, state: state)
            try await waitForVoiceOwner("relay create pending") { [log = fixture.log] in
                log.count("relay.created:relay-1") == 1
            }
            await fixture.requestTalk(false, state: state).value
            await fixture.create.releaseAll()
            await on.value
            try await waitForVoiceOwner("late relay close") { [log = fixture.log] in
                log.count("relay.closed:relay-1") == 1
            }
            #expect(fixture.log.count("capture.start:1") == 0)
            #expect(await state.voiceRuntime.talkRuntime.isEnabled == false)
        }
    }

    @Test(arguments: [false, true])
    func `superseded app permission cannot restore talk`(granted: Bool) async throws {
        try await withVoiceOwnerFixture(appPermissionGranted: false) { fixture, state, _ in
            await fixture.appPermission.hold()
            await fixture.talkPermission.hold()
            let on = fixture.requestTalk(true, state: state)
            try await waitForVoiceOwner("distinct owner permission requests") { [log = fixture.log] in
                log.count("app.permission.request") == 1 && log.count("talk.permission.request") == 1
            }
            await fixture.requestTalk(false, state: state).value
            await fixture.appPermission.resolve(1, returning: granted)
            await fixture.talkPermission.releaseAll()
            await on.value
            #expect(!state.talkEnabled)
            #expect(await state.voiceRuntime.talkRuntime.isEnabled == false)
            #expect(fixture.log.count("publish:true:enabled") == 0)
            #expect(fixture.log.count("capture.make") == 0)
            #expect(fixture.log.count("ptt.permission.request") == 0)
        }
    }

    @Test func `stale originating dismissal cannot hide replacement`() async throws {
        try await withVoiceOwnerFixture { fixture, state, _ in
            let voice = state.voiceRuntime
            let first = voice.sessions.startSession(source: .pushToTalk, text: "first draft")
            let blink = state.blinkTick
            voice.overlay.dismiss(token: first)
            #expect(fixture.log.count("overlay.request:\(first)") == 1)
            let second = voice.sessions.startSession(source: .pushToTalk, text: "second draft")
            fixture.completeDismissal(first)
            #expect(voice.sessions.snapshot().token == second)
            #expect(voice.overlay.snapshot().text == "second draft")
            #expect(voice.overlay.isVisible)
            #expect(state.earBoostActive)
            #expect(state.blinkTick == blink)
            #expect(fixture.log.count("overlay.finished:\(first)") == 0)
            voice.overlay.dismiss(token: second)
            fixture.completeDismissal(second)
            #expect(voice.sessions.snapshot().token == nil)
            #expect(!voice.overlay.isVisible)
            #expect(!state.earBoostActive)
            #expect(state.blinkTick == blink + 1)
            #expect(fixture.log.count("overlay.finished:\(second)") == 1)
        }
    }

    @Test func `overlay send uses owned coordinator and originating completion`() async throws {
        try await withVoiceOwnerFixture(activate: false) { fixture, state, _ in
            let voice = state.voiceRuntime
            let celebration = state.sendCelebrationTick
            let token = voice.sessions.startSession(source: .pushToTalk, text: "owned transcript")
            voice.overlay.requestSend(token: token)
            try await waitForVoiceOwner("owned forward and send dismissal") { [log = fixture.log] in
                log.count("forward:owned transcript") == 1 && log.count("overlay.request:\(token)") == 1
            }
            #expect(voice.sessions.snapshot().token == token)
            fixture.completeDismissal(token)
            #expect(voice.sessions.snapshot().token == nil)
            #expect(!voice.overlay.isVisible)
            #expect(state.sendCelebrationTick == celebration + 1)
        }
    }
}
