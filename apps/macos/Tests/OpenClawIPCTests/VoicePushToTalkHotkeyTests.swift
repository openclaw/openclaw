import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct VoicePushToTalkHotkeyTests {
    @Test func `either Option release order ends the right hold`() {
        let releaseOrders: [[UInt]] = [
            [0x80020, 0],
            [0x80040, 0],
        ]
        for releases in releaseOrders {
            var began = 0
            var ended = 0
            let hotkey = VoicePushToTalkHotkey(
                beginAction: { began += 1 },
                endAction: { cancelled in
                    if !cancelled { ended += 1 }
                })
            hotkey.setEnabled(true)
            hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80020))
            #expect(began == 0)
            for flags in [UInt(0x80040), 0x80040, 0x80060] {
                hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: flags))
            }
            #expect(began == 1)
            for flags in releases {
                hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: flags))
            }
            #expect(ended == 1)
            hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80040))
            hotkey._testUpdateModifierState(modifierFlags: [])
            #expect(began == 2)
            #expect(ended == 2)
        }
    }

    @Test func `Talk suppression survives preference changes until shutdown completes`() {
        var began = 0
        var cancelled = 0
        let hotkey = VoicePushToTalkHotkey(
            beginAction: { began += 1 },
            endAction: { forced in
                if forced { cancelled += 1 }
            })
        hotkey.setEnabled(true)
        hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80040))
        hotkey.setTalkSuppressed(true)
        #expect(cancelled == 1)
        hotkey.setEnabled(false)
        hotkey.setEnabled(true)
        hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80040))
        #expect(began == 1)
        hotkey.setTalkSuppressed(false)
        hotkey._testUpdateModifierState(modifierFlags: .init(rawValue: 0x80040))
        #expect(began == 2)
        hotkey.setEnabled(false)
    }
}
