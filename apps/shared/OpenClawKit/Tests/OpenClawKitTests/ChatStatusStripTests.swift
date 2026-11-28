import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatStatusStripTests {
    /// A clock the test moves by hand.
    private final class Clock {
        var now = ContinuousClock.now
    }

    private func status(
        _ id: String,
        priority: Int,
        text: String? = nil,
        action: Bool = false,
        clearing: OpenClawChatStatus.Clearing = .byOwner,
        scope: OpenClawChatStatus.Scope = .chat,
        delay: Duration = .zero) -> OpenClawChatStatus
    {
        OpenClawChatStatus(
            id: id,
            priority: priority,
            text: text ?? id,
            tone: .info,
            action: action ? OpenClawChatStatus.Action(title: "Try again") {} : nil,
            clearing: clearing,
            scope: scope,
            appearDelay: delay)
    }

    private func makeStrip(_ clock: Clock, voiceOver: Bool = false) -> OpenClawChatStatusStrip {
        OpenClawChatStatusStrip(now: { clock.now }, voiceOverRunning: { voiceOver })
    }

    @Test
    func `the graver state replaces a lower one, which comes back while it is still true`() {
        let clock = Clock()
        let strip = self.makeStrip(clock)
        strip.post(self.status("note", priority: 20, clearing: .onSend))
        strip.post(self.status("connection", priority: OpenClawChatStatusPriority.unreachable, action: true))
        #expect(strip.current?.id == "connection")

        strip.clear("connection")
        #expect(strip.current?.id == "note")
    }

    @Test
    func `a send in between keeps the lower state from coming back`() {
        let clock = Clock()
        let strip = self.makeStrip(clock)
        strip.post(self.status("note", priority: 20, clearing: .onSend))
        strip.post(self.status("connection", priority: OpenClawChatStatusPriority.reconnecting, scope: .app))
        strip.didSend()
        strip.clear("connection")
        #expect(strip.current == nil)
    }

    @Test
    func `one slot per owner: a repost replaces, and equal priorities go to the later post`() {
        let clock = Clock()
        let strip = self.makeStrip(clock)
        strip.post(self.status("connection", priority: OpenClawChatStatusPriority.reconnecting, text: "Reconnecting"))
        strip.post(self.status("connection", priority: OpenClawChatStatusPriority.unreachable, text: "Can’t reach"))
        #expect(strip.entries.count == 1)
        #expect(strip.current?.text == "Can’t reach")

        strip.post(self.status("access", priority: 50))
        strip.post(self.status("skills", priority: 50))
        strip.clear("connection")
        #expect(strip.current?.id == "skills")
    }

    @Test
    func `a delayed state shows only once it has lasted, and a repost does not restart the wait`() {
        let clock = Clock()
        let strip = self.makeStrip(clock)
        let reconnecting = self.status(
            "connection",
            priority: OpenClawChatStatusPriority.reconnecting,
            delay: .seconds(1))
        strip.post(reconnecting)
        #expect(strip.current == nil)

        clock.now += .milliseconds(600)
        strip.post(reconnecting)
        clock.now += .milliseconds(500)
        #expect(strip.current?.id == "connection")
    }

    @Test
    func `a timed note leaves by itself, and waits longer for VoiceOver`() {
        let clock = Clock()
        let note = self.status("note", priority: 10, clearing: .after(.seconds(4)))
        let strip = self.makeStrip(clock)
        strip.post(note)
        clock.now += .seconds(5)
        #expect(strip.current == nil)

        let spoken = self.makeStrip(clock, voiceOver: true)
        spoken.post(note)
        clock.now += .seconds(5)
        #expect(spoken.current?.id == "note")
        clock.now += .seconds(6)
        #expect(spoken.current == nil)
    }

    @Test
    func `a sheet that shows its own error is known to be open until it closes, without touching the strip`() {
        let clock = Clock()
        let strip = self.makeStrip(clock)
        strip.post(self.status("connection", priority: OpenClawChatStatusPriority.reconnecting, scope: .app))
        strip.surfaceDidOpen("add-sheet")
        #expect(strip.isSurfaceOpen("add-sheet"))
        #expect(strip.current?.id == "connection")
        strip.surfaceDidClose("add-sheet")
        #expect(!strip.isSurfaceOpen("add-sheet"))
    }

    @Test
    func `opening another chat clears that chat's states and keeps the connection`() {
        let clock = Clock()
        let strip = self.makeStrip(clock)
        strip.post(self.status("note", priority: 20))
        strip.post(self.status("connection", priority: OpenClawChatStatusPriority.reconnecting, scope: .app))
        strip.chatDidChange()
        #expect(strip.current?.id == "connection")
        #expect(strip.entries.count == 1)
    }

    @Test
    func `only a strip with an action spans the composer`() {
        #expect(!self.status("reconnecting", priority: 70).isWide)
        #expect(self.status("unreachable", priority: 100, action: true).isWide)
    }
}
