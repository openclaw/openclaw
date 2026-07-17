import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatModelTests {
    @Test(arguments: ["started", "ok", "in_flight"])
    func `accepted send clears text`(_ status: String) async {
        let model = self.makeModel(sendStatus: status)
        await self.prepare(model)
        model.text = " hello "

        #expect(await model.send())
        #expect(model.sendState == .sent)
        #expect(model.text.isEmpty)
    }

    @Test func `new draft clears sent presentation state`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.text = "first"
        #expect(await model.send())
        #expect(model.sendState == .sent)

        model.text = "second"

        #expect(model.sendState == .idle)
    }

    @Test(arguments: ["error", "timeout"])
    func `terminal failure preserves text`(_ status: String) async {
        let model = self.makeModel(sendStatus: status)
        await self.prepare(model)
        model.text = "hello"

        #expect(!(await model.send()))
        guard case let .failed(message) = model.sendState else {
            Issue.record("expected failed send state")
            return
        }
        #expect(message.contains(status))
        #expect(model.text == "hello")
    }

    @Test func `thrown send error becomes failure`() async {
        let model = self.makeModel(sendError: FakeSendError.rejected)
        await self.prepare(model)
        model.text = "hello"

        #expect(!(await model.send()))
        #expect(model.sendState == QuickChatSendState.failed("Fake rejection"))
        #expect(model.text == "hello")
    }

    @Test func `unchanged draft reuses idempotency key after transport failure`() async {
        var keys: [String] = []
        let model = self.makeModel(sendHandler: { _, _, idempotencyKey in
            keys.append(idempotencyKey)
            if keys.count == 1 { throw FakeSendError.rejected }
            return "started"
        })
        await self.prepare(model)
        model.text = "hello"

        #expect(!(await model.send()))
        #expect(await model.send())
        #expect(keys.count == 2)
        #expect(keys[0] == keys[1])
    }

    @Test func `edited draft gets new idempotency key`() async {
        var keys: [String] = []
        let model = self.makeModel(sendHandler: { _, _, idempotencyKey in
            keys.append(idempotencyKey)
            throw FakeSendError.rejected
        })
        await self.prepare(model)
        model.text = "first"
        #expect(!(await model.send()))

        model.text = "second"
        #expect(!(await model.send()))

        #expect(keys.count == 2)
        #expect(keys[0] != keys[1])
    }

    @Test func `empty text does not call gateway`() async {
        var sendCount = 0
        let model = self.makeModel(sendHandler: { _, _, _ in
            sendCount += 1
            return "ok"
        })
        await self.prepare(model)
        model.text = "  \n "

        #expect(!(await model.send()))
        #expect(sendCount == 0)
        #expect(model.sendState == .idle)
    }

    @Test func `disconnected gateway disables send`() async {
        var sendCount = 0
        let model = self.makeModel(
            gate: .disconnected,
            sendHandler: { _, _, _ in
                sendCount += 1
                return "ok"
            })
        await self.prepare(model)
        model.text = "hello"

        #expect(!model.canSend)
        #expect(model.connectionStatusMessage == "Gateway disconnected")
        #expect(!(await model.send()))
        #expect(sendCount == 0)
    }

    @Test func `new presentation disables send until session key refreshes`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.text = "hello"
        #expect(model.canSend)

        model.endPresentation()
        _ = model.beginPresentation()

        #expect(model.sessionKey.isEmpty)
        #expect(!model.canSend)
    }

    @Test func `dismissal lets dispatched send settle without retry`() async {
        let latch = SendLatch()
        let model = self.makeModel(sendHandler: { _, _, _ in
            try await latch.wait()
        })
        await self.prepare(model)
        model.text = "hello"

        let send = Task { await model.send() }
        while !latch.started {
            await Task.yield()
        }
        model.endPresentation()
        latch.finish(with: "started")

        #expect(await send.value)
        #expect(latch.callCount == 1)
        #expect(model.text.isEmpty)
        #expect(model.sendState == .sent)
    }

    @Test func `cached agent display survives representation for the same session`() async {
        let model = self.makeModel()
        await self.prepare(model)
        #expect(model.agentDisplay.name == "Molty")

        model.endPresentation()
        _ = model.beginPresentation()

        #expect(model.agentDisplay.name == "Molty")
    }

    @Test func `routing change resets stale agent display before identity resolves`() async {
        let keyBox = SessionKeyBox(key: "agent:one:main")
        let model = QuickChatModel(
            sessionKeyProvider: { keyBox.key },
            agentIdentityProvider: { sessionKey in
                if sessionKey == "agent:two:main" { throw FakeSendError.rejected }
                return QuickChatAgentDisplay(name: "One", emoji: nil)
            },
            sendProvider: { _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available })
        await self.prepare(model)
        #expect(model.agentDisplay.name == "One")

        model.endPresentation()
        keyBox.key = "agent:two:main"
        await self.prepare(model)

        // Identity for the new session failed; the old agent's name must not label sends.
        #expect(model.agentDisplay == .placeholder)
        #expect(model.sessionKey == "agent:two:main")
    }

    @Test func `grant refreshes permission status immediately`() async {
        let granted = GrantFlag()
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map {
                    ($0, granted.value || $0 != .screenRecording)
                })
            },
            permissionGrantProvider: { capabilities in
                granted.value = true
                return Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available })
        await self.prepare(model)
        #expect(model.missingPermissions == [.screenRecording])

        model.grantMissingPermissions()
        while model.isGrantingPermissions {
            await Task.yield()
        }

        #expect(model.missingPermissions.isEmpty)
        #expect(!model.shouldShowPermissionStrip)
    }

    @Test func `permission strip tracks missing permissions and session dismissal`() async {
        let model = self.makeModel(permissionStatus: [
            .notifications: false,
            .accessibility: true,
            .screenRecording: false,
        ])
        await self.prepare(model)

        #expect(model.missingPermissions == [.notifications, .screenRecording])
        #expect(model.shouldShowPermissionStrip)
        model.dismissPermissionsForSession()
        #expect(!model.shouldShowPermissionStrip)
    }

    private func prepare(_ model: QuickChatModel) async {
        let id = model.beginPresentation()
        await model.refreshForPresentation(id: id)
    }

    private func makeModel(
        gate: QuickChatConnectionGate = .available,
        sendStatus: String = "ok",
        sendError: Error? = nil,
        permissionStatus: [Capability: Bool]? = nil,
        sendHandler: QuickChatModel.SendProvider? = nil) -> QuickChatModel
    {
        QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentIdentityProvider: { _ in QuickChatAgentDisplay(name: "Molty", emoji: "🦞") },
            sendProvider: sendHandler ?? { _, _, _ in
                if let sendError { throw sendError }
                return sendStatus
            },
            permissionStatusProvider: { capabilities in
                permissionStatus ?? Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { gate })
    }
}

private enum FakeSendError: LocalizedError {
    case rejected

    var errorDescription: String? { "Fake rejection" }
}

@MainActor
private final class GrantFlag {
    var value = false
}

@MainActor
private final class SessionKeyBox {
    var key: String

    init(key: String) {
        self.key = key
    }
}

@MainActor
private final class SendLatch {
    private var continuation: CheckedContinuation<String, any Error>?
    private(set) var callCount = 0

    var started: Bool {
        self.continuation != nil
    }

    func wait() async throws -> String {
        self.callCount += 1
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func finish(with status: String) {
        self.continuation?.resume(returning: status)
        self.continuation = nil
    }
}
