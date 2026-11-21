import AppKit
import Foundation
import Testing
@testable import OpenClaw

@Suite(.testWaitLimit)
@MainActor
struct WebChatGatewaySwitchTests {
    @Test(arguments: [false, true])
    func `sidebar gateway selection retains its window and each gateway composer`(
        destinationAlreadyOpen: Bool) async throws
    {
        try await withIsolatedWebChatProfile { manager, profile in
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
                independent?.applyDraftIfEmpty("Independent window draft")
            }

            let previousWindows = Set(NSApp.windows.map(ObjectIdentifier.init))
            manager.show(sessionKey: "agent:main:source", draft: "Primary Gateway draft")
            let window = try #require(NSApp.windows.first { !previousWindows.contains(ObjectIdentifier($0)) })
            let original = try #require(window.delegate as? WebChatSwiftUIWindowController)
            let frame = window.frame
            let visibleWindows = Set(NSApp.windows.filter(\.isVisible).map(ObjectIdentifier.init))

            // Invoke the same window-bound action used by the sidebar's radio item.
            let selection = try #require(original.gatewaySelection.select?(target))
            await selection.value
            let destination = try #require(window.delegate as? WebChatSwiftUIWindowController)
            #expect(destination !== original)
            #expect(destination._testWindow === window)
            #expect(original._testWindow == nil)
            #expect(window.frame == frame)
            #expect(Set(NSApp.windows.filter(\.isVisible).map(ObjectIdentifier.init)) == visibleWindows)
            #expect(manager.frontmostGatewayTarget == target)
            #expect(manager.openWindowCount(for: .primary) == 0)
            #expect(manager.openWindowCount(for: target) == (destinationAlreadyOpen ? 2 : 1))
            #expect(destination._testDraft.isEmpty)
            #expect(original._testDraft == "Primary Gateway draft")
            #expect(independent == nil || independent?.isWindowOpen == true)
            #expect(independent == nil || independent?._testDraft == "Independent window draft")

            destination.applyDraftIfEmpty("Saved Gateway draft")
            let returnToPrimary = try #require(destination.gatewaySelection.select?(.primary))
            await returnToPrimary.value
            #expect(window.delegate === original)
            #expect(original._testDraft == "Primary Gateway draft")
            #expect(original.currentRoute.sessionKey == "agent:main:source")
            #expect(manager.activeSessionKey == "agent:main:source")
            #expect(manager.openProfileIDs.contains(profile.id))

            let returnToProfile = try #require(original.gatewaySelection.select?(target))
            await returnToProfile.value
            #expect(window.delegate === destination)
            #expect(destination._testDraft == "Saved Gateway draft")
            let connection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
            #expect(manager.sessionObserverOwners.isVisible(connection: ObjectIdentifier(connection)))

            // Credential retirement must also discard content retained behind a different Gateway.
            let returnAgain = try #require(destination.gatewaySelection.select?(.primary))
            await returnAgain.value
            manager.closeGatewayWindows(profileID: profile.id)
            #expect(destination.gatewaySelection.select == nil)
            #expect(original.isWindowOpen)
            #expect(window.delegate === original)
            #expect(!manager.sessionObserverOwners.isVisible(connection: ObjectIdentifier(connection)))
            window.close()
            #expect(manager.openWindowCount(for: .primary) == 0)
        }
    }

    @Test(arguments: ["close", "reselect current"])
    func `a delayed picker selection cannot replace a closed or reselected source`(action: String) async throws {
        try await withIsolatedWebChatProfile { manager, profile in
            let previousWindows = Set(NSApp.windows.map(ObjectIdentifier.init))
            manager.show(sessionKey: "agent:main:source")
            let window = try #require(NSApp.windows.first { !previousWindows.contains(ObjectIdentifier($0)) })
            let source = try #require(window.delegate as? WebChatSwiftUIWindowController)
            let release = DispatchSemaphore(value: 0)
            let entered = AsyncStream.makeStream(of: Void.self)
            let fleet = MacGatewayConnectionFleet.shared
            let held = Task.detached {
                await fleet.holdForPendingWindowRegression(entered: entered.continuation, release: release)
            }
            defer { release.signal() }
            var iterator = entered.stream.makeAsyncIterator()
            await iterator.next()

            let selection = try #require(source.gatewaySelection.select?(.profile(profile.id)))
            if action == "close" {
                window.close()
            } else {
                #expect(source.gatewaySelection.select?(.primary) == nil)
            }
            release.signal()
            #expect(await held.value)
            await selection.value
            #expect(manager.openWindowCount(for: .profile(profile.id)) == 0)
            #expect(manager.openWindowCount(for: .primary) == (action == "close" ? 0 : 1))
            if action != "close" { #expect(window.delegate === source) }
        }
    }
}
