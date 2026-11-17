import Foundation
import OpenClawKit
import Testing
import UIKit
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
@Suite(.enabled { await MainActor.run { UIDevice.current.userInterfaceIdiom == .pad } }, .timeLimit(.minutes(1)))
struct IOSConversationControllerTests {
    @Test func `retiring during the final destination draft read cannot leak a web claim`() async throws {
        try await ControllerFixture.run { fixture in
            _ = try await fixture.startWeb()
            let destination = NativeConversationContext(agentId: "main", sessionKey: "agent:main:destination")
            let readEntered = AsyncTestGate()
            let releaseRead = AsyncTestGate()
            let model = fixture.model
            var reads = 0
            fixture.controller.pendingInputCheck = { context in
                let pending = await model.hasPendingNativeConversationInput(for: context)
                if context == destination {
                    reads += 1
                    if reads == 2 {
                        readEntered.open()
                        await releaseRead.wait()
                    }
                }
                return pending
            }
            let reservation = Task { await fixture.controller.reserve(destination) }
            defer {
                reservation.cancel()
                releaseRead.open()
            }
            try await readEntered.wait("final destination draft read")
            // The temporary reservation excludes native sends while the read is suspended.
            fixture.expectNativeAdmission(destination, allowed: false)
            let admissionBlocked = AsyncTestGate()
            let admission = Task {
                try await fixture.waitForNativeAdmission(destination, onBlocked: { admissionBlocked.open() })
            }
            defer { admission.cancel() }
            try await admissionBlocked.wait("native admission blocked by temporary reservation")
            fixture.controller.requestNativeControls()
            #expect(fixture.controller.bridge == nil)
            #expect(!fixture.model.usesWebConversation)
            releaseRead.open()
            let reserved = try await TestWait.value(of: reservation, "retired destination reservation")
            #expect(!reserved)
            try await TestWait.value(of: admission, "native admission after joined reservation release")
            fixture.expectNativeAdmission(destination, allowed: true)
            fixture.expectNativeAdmission(.init(agentId: "main", sessionKey: "agent:main:main"), allowed: true)
        }
    }

    @Test(arguments: [true, false])
    func `canonical main reports unlock web thread navigation before native controls`(viaState: Bool) async throws {
        try await ControllerFixture.run { fixture in
            #expect(fixture.model.sessionKey == "main")
            let bridge = try await fixture.startWeb()
            let main = NativeConversationContext(agentId: "main", sessionKey: "agent:main:main")
            // Exercise the controller's trusted-document callbacks. Bridge admission and
            // actual about:blank retirement are covered by IOSConversationAdapterTests.
            if viaState {
                let state = try JSONDecoder().decode(NativeConversationState.self, from: Data(#"""
                {"revision":1,"context":{"agentId":"main","sessionKey":"agent:main:main"},
                 "title":"Main","run":{"active":false},"connection":"connected"}
                """#.utf8))
                bridge.onState?(state)
            } else {
                bridge.onRoute?(main)
            }
            try await TestWait.observed("canonical main selection") { fixture.model.sessionKey == "agent:main:main" }
            let thread = NativeConversationContext(agentId: "main", sessionKey: "agent:main:web-thread")
            bridge.onRoute?(thread)
            try await TestWait.observed("web thread selection") { fixture.model.sessionKey == thread.sessionKey }
            #expect(fixture.controller.bridge === bridge)
            #expect(fixture.model.usesWebConversation)
            fixture.expectNativeAdmission(thread, allowed: false)
            fixture.controller.requestNativeControls()
            #expect(!fixture.model.usesWebConversation)
            #expect(fixture.model.sessionKey == "agent:main:web-thread")
            try await fixture.waitForNativeAdmission(thread)
            fixture.expectNativeAdmission(main, allowed: true)
        }
    }

    @Test(arguments: [true, false])
    func `unavailable web destination opens its native draft or queued work instead of the old chat`(
        hasDraft: Bool) async throws
    {
        try await ControllerFixture.run(sessionKey: "agent:main:origin") { fixture in
            let destination = NativeConversationContext(agentId: "main", sessionKey: "agent:main:pending")
            let draftKey = fixture.model.composerSessionKey(for: destination.sessionKey, agentID: destination.agentId)
            if hasDraft {
                #expect(await fixture.store.saveComposerDraftText(key: draftKey, text: "Draft for B only", revision: 1))
            } else {
                #expect(await fixture.store.enqueueCommand(.init(
                    id: "queued-b",
                    sessionKey: destination.sessionKey,
                    deliverySessionKey: destination.sessionKey,
                    routingContract: "per-sender|main|main",
                    agentID: "main",
                    text: "Queued for B only",
                    thinking: "off",
                    createdAt: Date().timeIntervalSince1970,
                    status: .queued,
                    retryCount: 0,
                    lastError: nil)))
            }
            let bridge = try await fixture.startWeb()
            #expect(fixture.model.sessionKey == "agent:main:origin")
            bridge.onRoute?(.init(agentId: "main", sessionKey: "agent:main:origin"))
            bridge.onRoute?(destination)
            try await TestWait.observed("unavailable destination retirement") { fixture.controller.bridge == nil }
            await fixture.model.composerDraftSync.load?.value
            #expect(!fixture.model.usesWebConversation)
            #expect(fixture.model.sessionKey == "agent:main:pending")
            #expect(fixture.model.input == (hasDraft ? "Draft for B only" : ""))
            let commands = await fixture.store.loadCommands()
            #expect(commands.map(\.text) == (hasDraft ? [] : ["Queued for B only"]))
            #expect(commands.map(\.deliverySessionKey) == (hasDraft ? [] : ["agent:main:pending"]))
            #expect(fixture.controller.bridge == nil)
            #expect(fixture.controller.nativeRequested)
            // Concurrent destination reads may still own temporary reservations while
            // their database reads return. Join release before asserting native admission.
            try await fixture.waitForNativeAdmission(destination)
            fixture.expectNativeAdmission(.init(agentId: "main", sessionKey: "agent:main:origin"), allowed: true)
        }
    }
}

@MainActor
private struct ControllerFixture {
    let appModel: NodeAppModel
    let model: OpenClawChatViewModel
    let controller: IOSConversationController
    let store: OpenClawChatSQLiteTranscriptCache

    static func run(sessionKey: String = "main", _ body: (Self) async throws -> Void) async throws {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let gatewayID = "conversation-controller-" + UUID().uuidString
        let state = try TemporaryOpenClawState(instanceID: gatewayID)
        defer { state.restore() }
        let appModel = NodeAppModel()
        defer {
            appModel.chatPresentation.conversation?.close()
            appModel.chatPresentation.viewModel?.detachTransport()
            appModel.voiceWake.stop()
            appModel.disconnectGateway()
        }
        appModel.connectedGatewayID = gatewayID
        appModel.gatewayDefaultAgentId = "main"
        appModel.focusChatSession(sessionKey)
        appModel.activeGatewayConnectConfig = try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.invalid/control")),
            stableID: gatewayID,
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Controller fixture",
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: gatewayID))
        appModel.chatPresentation.sync(appModel: appModel)
        let fixture = try Self(
            appModel: appModel,
            model: #require(appModel.chatPresentation.viewModel),
            controller: #require(appModel.chatPresentation.conversation),
            store: #require(appModel.makeChatOfflineStore()))
        fixture.model.syncSessionRoutingContract("per-sender|main|main")
        await fixture.model.composerDraftSync.load?.value
        var failure: (any Error)?
        do { try await body(fixture) } catch { failure = error }
        fixture.controller.close()
        fixture.model.detachTransport()
        await fixture.model.composerDraftWrites?.value
        // The app database is installation-wide; remove only this fixture's random Gateway namespace.
        #expect(await appModel.purgeChatTranscriptCache(gatewayID: gatewayID))
        GatewaySettingsStore.saveGatewayFocusedChatSessionKey(stableID: gatewayID, sessionKey: nil)
        await IOSConversationController.removeStorage(gatewayID: gatewayID)
        if let failure {
            throw failure
        }
    }

    func startWeb() async throws -> IOSConversationBridge {
        self.appModel.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
        self.controller.reconcile()
        try await TestWait.observed("conversation bridge creation") { self.controller.bridge != nil }
        let bridge = try #require(controller.bridge)
        // No WKWebView is mounted: controller callbacks are this suite's boundary.
        // This also makes retirement immediate, deterministically rotating claimOwner.
        bridge.onReady?()
        return bridge
    }

    func waitForNativeAdmission(
        _ context: NativeConversationContext, onBlocked: (() -> Void)? = nil) async throws
    {
        let scope = OpenClawChatSendOwnership.Scope(
            sessionKey: context.sessionKey,
            agentID: context.agentId,
            routingContract: self.appModel.chatSessionRoutingContract)
        // Ownership claims are NSLock-backed, not Observation storage. endWeb
        // publishes no change signal, so use the shared untracked-state wait.
        try await TestWait.state("destination reservation release") {
            let admitted = self.appModel.chatSendOwnership.beginNative(scope)
            if admitted {
                self.appModel.chatSendOwnership.endNative(scope)
            } else {
                onBlocked?()
            }
            return admitted
        }
    }

    func expectNativeAdmission(_ context: NativeConversationContext, allowed: Bool) {
        let scope = OpenClawChatSendOwnership.Scope(
            sessionKey: context.sessionKey,
            agentID: context.agentId,
            routingContract: self.appModel.chatSessionRoutingContract)
        let admitted = self.appModel.chatSendOwnership.beginNative(scope)
        #expect(admitted == allowed, "Native admission for \(context.sessionKey): expected \(allowed), got \(admitted)")
        if admitted {
            self.appModel.chatSendOwnership.endNative(scope)
        }
    }
}
