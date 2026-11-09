#if os(macOS)
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor struct ChatSessionHoverInteractionTests {
    private let now = Date(timeIntervalSinceReferenceDate: 0)

    @Test func `hover routing uses the row key before the selected agent`() throws {
        let row = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: Data(#"{"key":"agent:ops:release-plan"}"#.utf8))
        #expect(ChatHoverPresentation.agentID(for: row, selected: "research") == "ops")
        let global = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: Data(#"{"key":"global"}"#.utf8))
        #expect(ChatHoverPresentation.agentID(for: global, selected: "ops") == "ops")
    }

    @Test func `new keyboard intent defeats old hover completion and old row cleanup`() throws {
        let owner = ChatHoverPresentation()
        let first = UUID(), second = UUID()
        owner.request(first, keyboard: false, now: self.now)
        let hover = try #require(owner.pending)
        owner.request(second, keyboard: true, now: self.now)
        let keyboard = try #require(owner.pending)
        owner.dismiss(first, now: self.now)
        owner.complete(hover, now: self.now)
        #expect(owner.selected == nil && owner.pending == keyboard)
        owner.complete(keyboard, now: self.now)
        #expect(owner.selected == second && owner.keyboardOpened)
    }

    @Test func `menus cancel pending hover and closing them does not reopen it`() throws {
        let owner = ChatHoverPresentation()
        let row = UUID(), menu = UUID()
        owner.request(row, keyboard: false, now: self.now)
        let stale = try #require(owner.pending)
        owner.setMenu(menu, open: true, now: self.now)
        owner.complete(stale, now: self.now)
        owner.request(row, keyboard: true, now: self.now)
        #expect(owner.selected == nil && owner.pending == nil)
        owner.setMenu(menu, open: false, now: self.now)
        #expect(owner.selected == nil && owner.pending == nil)
        owner.request(row, keyboard: false, now: self.now)
        try owner.complete(#require(owner.pending), now: self.now)
        #expect(owner.selected == row)
    }

    @Test(arguments: [false, true])
    func `reentering the displayed row cancels an older sweep`(keyboard: Bool) throws {
        let owner = ChatHoverPresentation()
        let first = UUID(), second = UUID()
        owner.request(first, keyboard: false, now: self.now)
        try owner.complete(#require(owner.pending), now: self.now)
        owner.request(second, keyboard: false, now: self.now)
        let sweep = try #require(owner.pending)
        owner.request(first, keyboard: keyboard, now: self.now)
        #expect(owner.pending == nil)
        owner.complete(sweep, now: self.now)
        #expect(owner.selected == first && owner.keyboardOpened == keyboard)
    }

    @Test(arguments: [false, true])
    func `canceling an initial open does not enable the warm delay`(menu: Bool) {
        let owner = ChatHoverPresentation()
        let row = UUID(), menuID = UUID()
        owner.request(row, keyboard: false, now: self.now)
        if menu {
            owner.setMenu(menuID, open: true, now: self.now)
            owner.setMenu(menuID, open: false, now: self.now)
        } else { owner.dismiss(row, restoreFocus: true, focused: true, now: self.now) }
        owner.request(UUID(), keyboard: false, now: self.now.addingTimeInterval(0.1))
        #expect(owner.pending?.delay == 450)
    }

    @Test(arguments: [false, true], [false, true])
    func `explicit exit cancels the open card and a pending pointer sweep`(
        fromPendingRow: Bool, restoreFocus: Bool) throws
    {
        let owner = ChatHoverPresentation()
        let first = UUID(), second = UUID()
        owner.request(first, keyboard: true, now: self.now)
        try owner.complete(#require(owner.pending), now: self.now)
        owner.request(second, keyboard: false, now: self.now)
        let sweep = try #require(owner.pending)
        owner.dismiss(
            fromPendingRow ? second : first,
            explicit: !restoreFocus,
            restoreFocus: restoreFocus,
            focused: true,
            now: self.now)
        #expect(owner.selected == nil && owner.pending == nil)
        owner.complete(sweep, now: self.now)
        #expect(owner.selected == nil)
    }

    @Test(arguments: [false, true])
    func `Escape restoration preserves newer pointer intent until genuine keyboard reentry`(focused: Bool) throws {
        let owner = ChatHoverPresentation()
        let row = UUID()
        owner.request(row, keyboard: true, now: self.now)
        try owner.complete(#require(owner.pending), now: self.now)
        owner.dismiss(row, restoreFocus: true, focused: focused, now: self.now)
        if !focused { owner.leaveFocus(row) }
        owner.request(UUID(), keyboard: false, now: self.now)
        let newerPointer = try #require(owner.pending)
        owner.request(row, keyboard: true, now: self.now)
        #expect(owner.selected == nil && owner.pending == newerPointer)
        owner.leaveFocus(row)
        owner.request(row, keyboard: true, now: self.now)
        try owner.complete(#require(owner.pending), now: self.now)
        #expect(owner.selected == row)
    }

    @Test func `entry delays use the web sweep and warm interval boundaries`() throws {
        let owner = ChatHoverPresentation()
        let row = UUID()
        owner.request(row, keyboard: false, now: self.now)
        #expect(owner.pending?.delay == 450)
        try owner.complete(#require(owner.pending), now: self.now)
        owner.request(UUID(), keyboard: false, now: self.now)
        #expect(owner.pending?.delay == 80)
        owner.dismiss(row, now: self.now)
        owner.request(UUID(), keyboard: false, now: self.now.addingTimeInterval(0.299))
        #expect(owner.pending?.delay == 80)
        owner.request(UUID(), keyboard: false, now: self.now.addingTimeInterval(0.3))
        #expect(owner.pending?.delay == 450)
        owner.request(UUID(), keyboard: true, now: self.now.addingTimeInterval(10))
        #expect(owner.pending?.delay == 0)
    }
}
#endif
