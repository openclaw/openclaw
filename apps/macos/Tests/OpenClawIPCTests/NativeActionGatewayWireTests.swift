import AppKit
import CryptoKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

private struct MacNativeWireDescriptor: Decodable, Sendable {
    struct Case: Decodable, Sendable {
        let sessionKey: String
        let marker: String
        let message: String
    }

    struct Media: Decodable, Sendable {
        struct Session: Decodable, Sendable {
            let sessionKey: String
            let artifactID: String
        }

        let pngBase64: String
        let sha256: String
        let sessions: [String: Session]
    }

    struct Approvals: Decodable, Sendable {
        struct Request: Decodable, Sendable {
            let id: String
            let sessionKey: String
            let command: String
        }

        let gatewayURL: URL
        let requests: [String: Request]
    }

    let version: Int
    let gatewayURL: URL
    let controlURL: URL
    let controlToken: String
    let aliceProfileID: String
    let bobProfileID: String
    let cases: [String: Case]
    let media: Media
    let approvals: Approvals
}

private struct MacNativeWireControlResponse: Decodable, Sendable {
    struct HeldResponse: Decodable, Sendable {
        let method: String
        let ok: Bool
        let runId: String?
    }

    let paired: Bool?
    let revoked: Bool?
    let profileID: String?
    let verified: String?
    let completed: String?
    let heldResponse: HeldResponse?
    let canvasOrigin: URL?
}

@MainActor
private final class MacNativeWireControl {
    let descriptor: MacNativeWireDescriptor
    private let session = URLSession(configuration: .ephemeral)

    init(descriptor: MacNativeWireDescriptor) {
        self.descriptor = descriptor
    }

    func close() {
        self.session.invalidateAndCancel()
    }

    @discardableResult
    func request(
        _ action: String,
        fields: [String: String] = [:]) async throws -> MacNativeWireControlResponse
    {
        var request = URLRequest(url: self.descriptor.controlURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue(self.descriptor.controlToken, forHTTPHeaderField: "x-qa-fixture-token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization
            .data(withJSONObject: fields.merging(["action": action]) { _, rhs in rhs })
        let (data, response) = try await self.session.data(for: request)
        try #require((response as? HTTPURLResponse)?.statusCode == 200, "Fixture control failed: \(action)")
        try #require(data.count <= 32768)
        return try JSONDecoder().decode(MacNativeWireControlResponse.self, from: data)
    }

    func verify(_ id: String, run: OpenClawNativeRunRef? = nil) async throws {
        var fields = ["case": id, "outcome": run == nil ? "rejected" : "allowed"]
        if let run { fields["runId"] = run.runID }
        let response = try await self.request("verify", fields: fields)
        try #require(response.verified == id)
    }

    func complete(_ id: String) async throws {
        let response = try await self.request("complete", fields: ["case": id])
        try #require(response.completed == id)
    }

    func submitHolding(
        _ method: String,
        prepared: OpenClawNativePreparedSend,
        whileHeld: (MacNativeWireControlResponse.HeldResponse) async throws -> Void) async throws
        -> Result<OpenClawNativeRunRef, Error>
    {
        try await self.request("hold-response", fields: ["method": method])
        let submission = Task { try await prepared.submit() }
        var holding = false
        do {
            let response = try await self.request("wait-held")
            holding = true
            let held = try #require(response.heldResponse)
            try #require(held.method == method && held.ok)
            try await whileHeld(held)
            try await self.request("release-response")
            holding = false
            return await submission.result
        } catch {
            if holding { try? await self.request("release-response") }
            submission.cancel()
            _ = await submission.result
            throw error
        }
    }
}

@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_ACTION_FIXTURE"] != nil))
@MainActor
struct NativeActionGatewayWireTests {
    @Test func `native submissions retain exact authority through real Gateway effects`() async throws {
        let raw = try #require(ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_ACTION_FIXTURE"])
        let descriptor = try JSONDecoder().decode(MacNativeWireDescriptor.self, from: Data(raw.utf8))
        try #require(descriptor.version == 1)
        let control = MacNativeWireControl(descriptor: descriptor)
        defer { control.close() }
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            func selectGateway(_ url: URL) throws -> String {
                let configuration: [String: Any] = [
                    "gateway": [
                        "mode": "remote",
                        "remote": ["transport": "direct", "url": url.absoluteString],
                    ],
                ]
                try JSONSerialization.data(withJSONObject: configuration)
                    .write(to: URL(fileURLWithPath: configPath))
                // macOS derives its primary Gateway owner from the configured endpoint.
                // The fixture's gatewayID is an iOS selection ID, not a Gateway-issued identity to compare.
                return try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(root: configuration))
            }
            let gatewayID = try selectGateway(descriptor.gatewayURL)
            // Use the production initializer: the test-only endpoint initializer omits device identity.
            let connection = GatewayConnection(
                endpointProvider: {
                    .init(
                        config: (descriptor.gatewayURL, nil, nil),
                        routeAuthority: nil,
                        deviceAuthGatewayID: gatewayID)
                },
                supportsSharedEndpointRecovery: false)
            do {
                try await withWebChatManagerLifetime(primaryConnection: connection) { manager in
                    do {
                        _ = try await connection.acquireServerLease()
                        throw OpenClawNativeActionError("An unpaired native device was admitted.")
                    } catch let error as GatewayConnectAuthError {
                        try #require(error.detailCodeRaw == GatewayConnectAuthDetailCode.pairingRequired.rawValue)
                    }
                    let pairing = try await control.request("pair")
                    try #require(pairing.paired == true)
                    _ = try await connection.acquireServerLease()
                    let hello = try #require(await connection.lastSnapshot)
                    let scopeValues = try #require(hello.auth["scopes"]?.arrayValue)
                    let scopes = scopeValues.compactMap(\.stringValue)
                    try #require(Set(scopes) == ["operator.read", "operator.write"])
                    try #require(!scopes.contains("operator.admin"))

                    let router = NativeActionRouter(windows: manager, launchPlan: .init(arguments: ["OpenClaw"]))
                    try await self.exercise(
                        control: control, gatewayID: gatewayID, manager: manager, router: router)
                }
                // Retire the writer's windows before changing the selected endpoint.
                // Keep one state directory so only credential ownership, not device identity, changes.
                let approvalGatewayID = try selectGateway(descriptor.approvals.gatewayURL)
                try await self.exerciseApprovals(control: control, gatewayID: approvalGatewayID)
            } catch {
                await connection.shutdown()
                throw error
            }
            await connection.shutdown()
        }
    }

    private func exercise(
        control: MacNativeWireControl,
        gatewayID: String,
        manager: WebChatManager,
        router: NativeActionRouter) async throws
    {
        let descriptor = control.descriptor
        func target(_ id: String, profileID: String? = nil) throws -> OpenClawNativeSessionRef {
            let spec = try #require(descriptor.cases[id])
            return OpenClawNativeSessionRef(
                owner: .init(gatewayID: gatewayID, profileID: profileID ?? descriptor.aliceProfileID),
                agentID: "qa",
                sessionKey: spec.sessionKey)
        }
        func prepare(_ id: String, profileID: String? = nil) async throws -> OpenClawNativePreparedSend {
            let spec = try #require(descriptor.cases[id])
            return try await router.prepareSend(
                to: target(id, profileID: profileID),
                message: spec.message)
        }
        func transport(_ id: String, profileID: String? = nil) async throws -> MacGatewayChatTransport {
            let gateway = try await manager.captureNativeGateway(gatewayID: gatewayID)
            let controller = try manager.presentNative(.session(target(id, profileID: profileID)), gateway: gateway)
            return try #require(controller.gatewayTransport)
        }
        func allowed(_ id: String, profileID: String? = nil) async throws -> OpenClawNativeRunRef {
            let prepared = try await prepare(id, profileID: profileID)
            let run = try await prepared.submit()
            try #require(!run.runID.isEmpty)
            try await control.verify(id, run: run)
            if id == "allowed" {
                let replay = try await prepared.submit()
                try #require(replay == run)
                try await control.verify(id, run: replay)
            }
            try await control.complete(id)
            return run
        }

        let first = try await allowed("allowed")
        let distinct = try await allowed("distinct")
        try #require(first.runID != distinct.runID)
        try await self.requireVisibleRejection {
            _ = try await prepare("foreign", profileID: descriptor.bobProfileID)
        }
        try await control.verify("foreign")
        try await control.complete("foreign")

        // Each pair shares a session, so preparing the second must preserve the first presentation.
        let acl = try await prepare("acl")
        let aclSuspended = try await prepare("aclSuspended")
        let aclMedia = try await transport("acl")
        try await self.verifyMedia(control, transport: aclMedia, id: "aclAllowed", session: "acl", allowed: true)
        let aclResult = try await control.submitHolding("users.self", prepared: aclSuspended) { _ in
            let response = try await control.request("revoke-acl")
            try #require(response.revoked == true)
        }
        try await self.requireVisibleRejection { _ = try aclResult.get() }
        try await self.requireVisibleRejection { _ = try await acl.submit() }
        for id in ["acl", "aclSuspended"] {
            try await control.verify(id)
            try await control.complete(id)
        }
        try await self.verifyMedia(control, transport: aclMedia, id: "acl", session: "acl", allowed: false)
        _ = try await allowed("controlACL")
        try await self.verifyMedia(
            control, transport: transport("controlACL"), id: "controlACL", session: "controlACL", allowed: true)

        let accepted = try await prepare("accepted")
        var acceptedRunID: String?
        let acceptedResult = try await control.submitHolding("chat.send", prepared: accepted) { held in
            acceptedRunID = try #require(held.runId)
            // Keep the real socket alive; only the presenting native window is retired.
            manager.resetPrimaryConnections()
        }
        let receipt = try acceptedResult.get()
        try #require(receipt.runID == acceptedRunID)
        try await control.verify("accepted", run: receipt)
        try await self.requireVisibleRejection { _ = try await accepted.submit() }
        try await control.verify("accepted", run: receipt)
        try await control.complete("accepted")

        let widgetTransport = try await transport("controlACL")
        let initialWidget = try await self.verifyWidget(
            control, transport: widgetTransport, id: "allowed", replacing: nil, allowed: true)
        let widget = try #require(initialWidget)
        let profile = try await prepare("profile")
        let profileSuspended = try await prepare("profileSuspended")
        let profileMedia = try await transport("profile")
        try await self.verifyMedia(
            control, transport: profileMedia, id: "profileAllowed", session: "profile", allowed: true)
        let profileResult = try await control.submitHolding("users.self", prepared: profileSuspended) { _ in
            let response = try await control.request("merge-profile")
            try #require(response.profileID == descriptor.bobProfileID)
        }
        try await self.requireVisibleRejection { _ = try profileResult.get() }
        try await self.requireVisibleRejection { _ = try await profile.submit() }
        for id in ["profile", "profileSuspended"] {
            try await control.verify(id)
            try await control.complete(id)
        }
        _ = try await self.verifyWidget(
            control, transport: widgetTransport, id: "profile", replacing: widget, allowed: false)
        try await self.verifyMedia(
            control, transport: profileMedia, id: "profile", session: "profile", allowed: false)
        _ = try await allowed("controlProfile", profileID: descriptor.bobProfileID)
        let fresh = try await transport("controlProfile", profileID: descriptor.bobProfileID)
        try await self.verifyMedia(
            control, transport: fresh, id: "controlProfile", session: "controlProfile", allowed: true)
        _ = try await self.verifyWidget(control, transport: fresh, id: "controlProfile", replacing: nil, allowed: true)
    }

    private func verifyMedia(
        _ control: MacNativeWireControl,
        transport: MacGatewayChatTransport,
        id: String,
        session: String,
        allowed: Bool) async throws
    {
        let media = try #require(control.descriptor.media.sessions[session])
        try await control.request("media-start", fields: ["case": id])
        var fields = ["case": id, "outcome": allowed ? "allowed" : "rejected"]
        if allowed {
            let loaded = try await transport.loadMediaArtifact(
                sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
            guard case let .data(value) = loaded else {
                throw OpenClawNativeActionError("The native PNG did not load as data.")
            }
            let expected = try #require(Data(base64Encoded: control.descriptor.media.pngBase64))
            try #require(value.mimeType == "image/png" && value.data == expected)
            let digest = SHA256.hash(data: value.data).map { String(format: "%02x", $0) }.joined()
            try #require(digest == control.descriptor.media.sha256)
            fields["sha256"] = digest
        } else {
            let rejection: Error?
            do {
                _ = try await transport.loadMediaArtifact(
                    sessionKey: media.sessionKey, artifactId: media.artifactID, kind: .image, playback: nil)
                rejection = nil
            } catch {
                rejection = error
            }
            let error = try #require(rejection, "Retired native media authority was accepted.")
            try #require(error is GatewayResponseError || error is OpenClawChatTransportSendError)
            try #require(!error.localizedDescription.isEmpty)
            if id == "profile", error is OpenClawChatTransportSendError {
                try #require(transport.nativeBinding != nil && !transport.nativeBindingIsCurrent)
                fields["locallyRetired"] = "true"
            }
        }
        try await control.request("media-complete", fields: fields)
    }

    private func verifyWidget(
        _ control: MacNativeWireControl,
        transport: MacGatewayChatTransport,
        id: String,
        replacing resource: OpenClawChatWidgetResource?,
        allowed: Bool) async throws -> OpenClawChatWidgetResource?
    {
        let started = try await control.request("widget-start", fields: ["case": id])
        let canvasOrigin = try #require(started.canvasOrigin)
        let resolved = await transport.resolveInlineWidgetResource(
            path: "/__openclaw__/canvas/documents/native.html", replacing: resource)
        if allowed {
            let value = try #require(resolved)
            // Compare against the canvas authority advertised by this connection's hello.
            try #require(value.url.scheme == canvasOrigin.scheme)
            try #require(value.url.host == canvasOrigin.host)
            try #require(value.url.port == canvasOrigin.port)
        } else {
            try #require(resolved == nil)
            try #require(!transport.nativeBindingIsCurrent)
            try #require(await transport.resolveInlineWidgetResource(
                path: "/__openclaw__/canvas/documents/native.html", replacing: resource) == nil)
        }
        try await control.request(
            "widget-complete", fields: ["case": id, "outcome": allowed ? "allowed" : "rejected"])
        return resolved
    }

    private func exerciseApprovals(control: MacNativeWireControl, gatewayID: String) async throws {
        let descriptor = control.descriptor
        func connection() -> GatewayConnection {
            GatewayConnection(
                endpointProvider: {
                    .init(
                        config: (descriptor.approvals.gatewayURL, nil, nil),
                        routeAuthority: nil,
                        deviceAuthGatewayID: gatewayID)
                },
                supportsSharedEndpointRecovery: false)
        }
        let requester = connection()
        let presenter = connection()
        do {
            // Separate sockets share the real native device identity. Only this
            // approval endpoint gains approvals scope; the send socket stays a writer.
            for connection in [requester, presenter] {
                do {
                    _ = try await connection.acquireServerLease()
                } catch {
                    try await control.request("pair-approval")
                    _ = try await connection.acquireServerLease()
                }
                let hello = try #require(await connection.lastSnapshot)
                let scopes = try #require(hello.auth["scopes"]?.arrayValue).compactMap(\.stringValue)
                try #require(Set(scopes) == ["operator.read", "operator.write", "operator.approvals"])
            }
            let lease = try await requester.acquireServerLease()
            struct Response: Decodable {
                let id: String
                let status: String?
                let deliveryRoute: String?
                let decision: String?
            }
            func request(_ id: String) async throws {
                let spec = try #require(descriptor.approvals.requests[id])
                let data = try await requester.request(
                    method: "exec.approval.request",
                    params: [
                        "id": AnyCodable(spec.id), "command": AnyCodable(spec.command),
                        "agentId": AnyCodable("qa"), "sessionKey": AnyCodable(spec.sessionKey),
                        "host": AnyCodable("gateway"), "ask": AnyCodable("always"),
                        "twoPhase": AnyCodable(true), "timeoutMs": AnyCodable(120_000),
                    ],
                    timeoutMs: 15000,
                    ifCurrentServerLease: lease,
                    expectedProfileId: descriptor.bobProfileID)
                let response = try JSONDecoder().decode(Response.self, from: data)
                try #require(response.id == spec.id && response.status == "accepted")
                try #require(response.deliveryRoute == "approval-client")
            }
            func decision(_ id: String, expected: String) async throws {
                let spec = try #require(descriptor.approvals.requests[id])
                let data = try await requester.request(
                    method: "exec.approval.waitDecision",
                    params: ["id": AnyCodable(spec.id)],
                    timeoutMs: 15000,
                    ifCurrentServerLease: lease,
                    expectedProfileId: descriptor.bobProfileID)
                let response = try JSONDecoder().decode(Response.self, from: data)
                try #require(response.id == spec.id && response.decision == expected)
            }
            try await withWebChatManagerLifetime(primaryConnection: presenter) { manager in
                weak var presentedController: WebChatSwiftUIWindowController?
                var reportedReadinessFailure = false
                @MainActor func present(_ id: String) async throws {
                    let spec = try #require(descriptor.approvals.requests[id])
                    let session = OpenClawNativeSessionRef(
                        owner: .init(gatewayID: gatewayID, profileID: descriptor.bobProfileID),
                        agentID: "qa", sessionKey: spec.sessionKey)
                    let gateway = try await manager.captureNativeGateway(gatewayID: gatewayID)
                    _ = try await gateway.actions.history(session: session)
                    let controller = try manager.presentNative(.session(session), gateway: gateway)
                    presentedController = controller
                    let deadline = ContinuousClock.now + .seconds(10)
                    let initialPresented = controller.hasPresentedNative(.session(session))
                    let initialWindowMatches = manager.approvalContext(connection: presenter)?.windowID ==
                        ObjectIdentifier(controller)
                    let initialBindingPresent = manager.approvalContext(connection: presenter)?.nativeBinding != nil
                    while ContinuousClock.now < deadline {
                        if controller.hasPresentedNative(.session(session)),
                           manager.approvalContext(connection: presenter)?.windowID == ObjectIdentifier(controller),
                           manager.approvalContext(connection: presenter)?.nativeBinding != nil
                        { return }
                        try await Task.sleep(for: .milliseconds(20))
                    }
                    let finalPresented = controller.hasPresentedNative(.session(session))
                    let finalWindowMatches = manager.approvalContext(connection: presenter)?.windowID ==
                        ObjectIdentifier(controller)
                    let finalBindingPresent = manager.approvalContext(connection: presenter)?.nativeBinding != nil
                    reportedReadinessFailure = true
                    print([
                        "native approval readiness failed: case=\(id == "allowed" ? "allowed" : "control")",
                        "initialPresented=\(initialPresented)",
                        "initialWindowMatches=\(initialWindowMatches)",
                        "initialBindingPresent=\(initialBindingPresent)",
                        "finalPresented=\(finalPresented)",
                        "finalWindowMatches=\(finalWindowMatches)",
                        "finalBindingPresent=\(finalBindingPresent)",
                        "visible=\(controller.isVisible)",
                        "key=\(controller.isKeyWindow)",
                        "panelOwnsKey=\(ExecApprovalsPromptPresenter.ownsKeyWindow(for: ObjectIdentifier(controller)))",
                        "transportBindingPresent=\(controller.gatewayTransport?.nativeBinding != nil)",
                        "transportBindingCurrent=\(controller.gatewayTransport?.nativeBindingIsCurrent == true)",
                        "sessionMatches=\(controller.viewModel.sessionKey.utf8.elementsEqual(session.sessionKey.utf8))",
                        "agentMatches=\(controller.currentAgentID?.utf8.elementsEqual(session.agentID.utf8) == true)",
                        "appActive=\(NSApp.isActive)",
                        "leaseStateMatches=\(gateway.connection.serverLeaseMatchesCurrentState(gateway.lease))",
                    ].joined(separator: "; "))
                    throw OpenClawNativeActionError("Native approval context did not become current.")
                }
                let prompter = ExecApprovalsGatewayPrompter(gateway: presenter) { [weak manager] in
                    manager?.approvalContext(connection: presenter)
                }
                prompter.start()
                defer { prompter.stop() }
                enum Stage: String {
                    case allowedPresent, allowedRequest, allowedLookup, allowedPress, allowedDecision, allowedControl
                    case visibleRequest, visibleLookup, queuedRequest, controlPresent, controlRequest, visiblePress
                    case controlLookup, retiredControl, visibleDecision, queuedDecision, controlPress
                    case controlDecision, controlComplete
                }
                var stage = Stage.allowedPresent
                do {
                    try await present("allowed")
                    stage = .allowedRequest
                    try await request("allowed")
                    stage = .allowedLookup
                    let allowed = try await self.approvalPanel(
                        command: #require(descriptor.approvals.requests["allowed"]).command)
                    stage = .allowedPress
                    try await self.pressApprovalButton("Allow Once", in: allowed)
                    stage = .allowedDecision
                    try await decision("allowed", expected: "allow-once")
                    stage = .allowedControl
                    try await control.request("approval-allowed")

                    stage = .visibleRequest
                    try await request("visible")
                    stage = .visibleLookup
                    let visible = try await self.approvalPanel(
                        command: #require(descriptor.approvals.requests["visible"]).command)
                    stage = .queuedRequest
                    try await request("queued")
                    stage = .controlPresent
                    try await present("control")
                    stage = .controlRequest
                    try await request("control")
                    stage = .visiblePress
                    try await self.pressApprovalButton("Allow Once", in: visible)
                    // The fresh panel is a FIFO barrier: the real prompter has
                    // consumed the visible decision and the older queued request.
                    stage = .controlLookup
                    let fresh = try await self.approvalPanel(
                        command: #require(descriptor.approvals.requests["control"]).command)
                    stage = .retiredControl
                    try await control.request("approval-retired")
                    stage = .visibleDecision
                    try await decision("visible", expected: "deny")
                    stage = .queuedDecision
                    try await decision("queued", expected: "deny")
                    stage = .controlPress
                    try await self.pressApprovalButton("Don't Allow", in: fresh)
                    stage = .controlDecision
                    try await decision("control", expected: "deny")
                    stage = .controlComplete
                    try await control.request("approval-complete")
                } catch {
                    if !reportedReadinessFailure {
                        let panels = NSApp.windows.filter {
                            $0.isVisible && $0.title == "OpenClaw Command Approval"
                        }
                        let panel = panels.count == 1 ? panels.first : nil
                        let context = manager.approvalContext(connection: presenter)
                        let binding = presentedController?.gatewayTransport?.nativeBinding
                        let bindingCurrent = presentedController?.gatewayTransport?.nativeBindingIsCurrent
                        let leaseCurrent = binding.map { presenter.serverLeaseMatchesCurrentState($0.lease) }
                        let contextMatches = presentedController.map { context?.windowID == ObjectIdentifier($0) }
                        let panelOwnsKey = presentedController.map {
                            ExecApprovalsPromptPresenter.ownsKeyWindow(for: ObjectIdentifier($0))
                        }
                        func fact(_ value: Bool?) -> String {
                            value.map(String.init) ?? "unknown"
                        }
                        print([
                            "native approval failed: stage=\(stage.rawValue)",
                            "panelCount=\(panels.count)",
                            "panelContentPresent=\(fact(panel.map { $0.contentView != nil }))",
                            "panelKey=\(fact(panel?.isKeyWindow))",
                            "windowVisible=\(fact(presentedController?.isVisible))",
                            "windowKey=\(fact(presentedController?.isKeyWindow))",
                            "panelOwnsKey=\(fact(panelOwnsKey))",
                            "contextWindowMatches=\(fact(contextMatches))",
                            "contextBindingPresent=\(fact(context.map { $0.nativeBinding != nil }))",
                            "bindingCurrent=\(fact(bindingCurrent))",
                            "leaseStateMatches=\(fact(leaseCurrent))",
                        ].joined(separator: "; "))
                    }
                    throw error
                }
            }
        } catch {
            await requester.shutdown()
            await presenter.shutdown()
            throw error
        }
        await requester.shutdown()
        await presenter.shutdown()
    }

    private func approvalPanel(command: String) async throws -> NSView {
        let deadline = ContinuousClock.now + .seconds(15)
        while ContinuousClock.now < deadline {
            for window in NSApp.windows where window.isVisible && window.title == "OpenClaw Command Approval" {
                guard let root = window.contentView else { continue }
                root.layoutSubtreeIfNeeded()
                if try await AppKitTestSupport.accessibilityElements(in: root).contains(where: { element in
                    let value: Any? = element.accessibilityValue?()
                    return [element.accessibilityLabel?(), element.accessibilityTitle?(), value as? String]
                        .compactMap(\.self).contains(where: { $0.contains(command) })
                }) {
                    return root
                }
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw OpenClawNativeActionError("The expected native approval panel did not appear.")
    }

    private func pressApprovalButton(_ title: String, in root: NSView) async throws {
        root.layoutSubtreeIfNeeded()
        let buttons = try await AppKitTestSupport.accessibilityElements(in: root).filter { element in
            element.accessibilityRole?() == .button &&
                element.isAccessibilityEnabled?() == true &&
                [element.accessibilityLabel?(), element.accessibilityTitle?()]
                .compactMap(\.self).contains(title)
        }
        try #require(buttons.count == 1)
        let button = try #require(buttons.first)
        try #require(button.accessibilityPerformPress?() == true)
    }

    private func requireVisibleRejection(_ operation: () async throws -> Void) async throws {
        let rejection: Error?
        do {
            try await operation()
            rejection = nil
        } catch {
            rejection = error
        }
        let error = try #require(rejection, "Retired or foreign native authority was accepted.")
        try #require(error is OpenClawNativeActionError || error is GatewayResponseError)
        try #require(!error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}
