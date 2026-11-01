import AppKit
import Foundation
import Testing
@testable import OpenClaw

@Suite(.testWaitLimit)
@MainActor
struct GatewaysMainMenuTests {
    @Test(arguments: [false, true])
    func `command number switches its originating window and option opens another`(
        destinationAlreadyOpen: Bool) async throws
    {
        try await withIsolatedWebChatProfile { manager, profile in
            let appState = AppStateStore.shared
            let previousExperience = appState.nativeExperienceEnabled
            appState.nativeExperienceEnabled = true
            defer { appState.nativeExperienceEnabled = previousExperience }
            defer { WebChatManager.shared.closeGatewayWindows(profileID: profile.id) }
            let primary = appState.primaryGatewaySnapshot()
            let previousNativeConversation = AppDefaults.standard.bool(forKey: nativeConversationForcedKey)
            AppDefaults.standard.set(true, forKey: nativeConversationForcedKey)
            defer { AppDefaults.standard.set(previousNativeConversation, forKey: nativeConversationForcedKey) }
            let target = DashboardGatewayTarget.profile(profile.id)
            var independent: WebChatSwiftUIWindowController?
            if destinationAlreadyOpen {
                let previousWindows = Set(NSApp.windows.map(ObjectIdentifier.init))
                await manager.openGatewayWindow(for: target, newWindow: true).value
                let window = try #require(NSApp.windows.first { !previousWindows.contains(ObjectIdentifier($0)) })
                independent = try #require(window.delegate as? WebChatSwiftUIWindowController)
                independent?.applyDraftIfEmpty("Independent Gateway draft")
            }
            let previousWindows = Set(NSApp.windows.map(ObjectIdentifier.init))
            manager.show(sessionKey: "agent:main:shortcuts", draft: "Primary shortcut draft")
            let window = try #require(NSApp.windows.first { !previousWindows.contains(ObjectIdentifier($0)) })
            let original = try #require(window.delegate as? WebChatSwiftUIWindowController)
            let frame = window.frame
            let entries = [
                DashboardGatewayEntry(
                    id: "primary", name: "Primary", kind: "local",
                    isPrimary: true, canPromote: false, health: .unknown),
                DashboardGatewayEntry(
                    id: target.bridgeID, name: "Saved", kind: "remote",
                    isPrimary: false, canPromote: false, health: .unknown),
            ]
            let previousMenu = NSApp.mainMenu
            defer { NSApp.mainMenu = previousMenu }
            let mainMenu = NSMenu()
            let gateways = mainMenu.addItem(withTitle: String(localized: "Gateways"), action: nil, keyEquivalent: "")
            NSApp.mainMenu = mainMenu
            // The accessory runner has no stable global key window. Supply the
            // originating window, but dispatch real AppKit menu key equivalents.
            let owner = GatewaysMainMenu(gatewayEntries: { entries }, currentWindow: { window })
            owner.install()
            let menu = try #require(gateways.submenu)

            try self.press("2", keyCode: 19, in: window, menu: menu)
            try await TestWait.state("Command-2 switches the originating Gateway window") {
                manager.openWindowCount(for: .primary) == 0 &&
                    manager.openWindowCount(for: target) == (destinationAlreadyOpen ? 2 : 1)
            }
            let saved = try #require(window.delegate as? WebChatSwiftUIWindowController)
            #expect(saved !== original)
            #expect(saved._testWindow === window)
            #expect(window.frame == frame)
            #expect(saved._testDraft.isEmpty)
            #expect(independent == nil || independent?._testDraft == "Independent Gateway draft")
            saved.applyDraftIfEmpty("Saved shortcut draft")

            try self.press("1", keyCode: 18, in: window, menu: menu)
            try await TestWait.state("Command-1 restores the original Gateway content") {
                window.delegate === original
            }
            #expect(original._testDraft == "Primary shortcut draft")
            #expect(manager.activeSessionKey == "agent:main:shortcuts")
            #expect(window.frame == frame)

            try self.press("2", keyCode: 19, in: window, menu: menu)
            try await TestWait.state("Command-2 restores the saved Gateway composer") {
                window.delegate === saved
            }
            #expect(saved._testDraft == "Saved shortcut draft")
            #expect(independent == nil || independent?.isWindowOpen == true)
            #expect(appState.isCurrentPrimaryGateway(primary))

            let count = manager.openWindowCount(for: target)
            try self.press("2", keyCode: 19, modifiers: [.command, .option], in: window, menu: menu)
            try await TestWait.state("Option-Command-2 explicitly opens an independent Gateway window") {
                // The explicit open belongs to the application navigation owner.
                WebChatManager.shared.openWindowCount(for: target) == 1
            }
            #expect(manager.openWindowCount(for: target) == count)
            #expect(window.delegate === saved)
            #expect(saved._testDraft == "Saved shortcut draft")
        }
    }

    private func press(
        _ key: String, keyCode: UInt16, modifiers: NSEvent.ModifierFlags = [.command],
        in window: NSWindow, menu: NSMenu) throws
    {
        let event = try #require(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            characters: key,
            charactersIgnoringModifiers: key,
            isARepeat: false,
            keyCode: keyCode))
        #expect(menu.performKeyEquivalent(with: event))
    }
}
