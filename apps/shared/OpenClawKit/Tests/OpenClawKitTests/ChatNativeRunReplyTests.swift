import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatNativeRunReplyTests {
    private let run = OpenClawNativeRunRef(
        session: .init(
            owner: .init(gatewayID: "gateway-a", profileID: "profile-a"),
            agentID: "reviewer",
            sessionKey: "agent:reviewer:main"),
        runID: "run-e\u{301}")

    @Test func `only the exact successful run returns recorded answer text`() throws {
        let result = try decode([
            "status": "ok", "terminalReply": ["disposition": "visible", "text": "Requested answer"],
        ])
        #expect(result.run == self.run)
        #expect(result.outcome == .answer("Requested answer"))
        #expect(result.text == "Requested answer")
        let differentRun = try decode([
            "runId": "run-\u{E9}", "status": "ok",
            "terminalReply": ["disposition": "visible", "text": "Another run's answer"],
        ])
        #expect(differentRun.outcome == .unavailable)
    }

    @Test(arguments: ["error", "timeout", "cancelled"])
    func `failed terminal state does not become a successful answer`(status: String) throws {
        let result = try decode([
            "status": status, "endedAt": 10, "error": "Run ended unsuccessfully",
            "terminalReply": ["disposition": "visible", "text": "Partial output"],
        ])
        #expect(result.outcome == .failed("Run ended unsuccessfully"))
        #expect(!result.text.contains("Partial output"))
    }

    @Test(arguments: ["pending", "timeout"])
    func `a wait deadline is not a run failure`(status: String) throws {
        #expect(try self.decode(["status": status]).outcome == .pending)
    }

    @Test func `silent empty and missing replies stay distinct`() throws {
        #expect(try self.decode([
            "status": "ok", "terminalReply": ["disposition": "silent"],
        ]).outcome == .silent)
        #expect(try self.decode([
            "status": "ok", "terminalReply": ["disposition": "empty"],
        ]).outcome == .empty)
        #expect(try self.decode(["status": "ok"]).outcome == .unavailable)
    }

    @Test func `dialog is bounded without truncating the returned answer`() throws {
        let answer = String(repeating: "a", count: 4096)
        let result = try decode([
            "status": "ok", "terminalReply": ["disposition": "visible", "text": answer],
        ])
        #expect(result.text == answer)
        #expect(result.dialog.count < 900)
        #expect(result.dialog.hasSuffix("Open the chat for the rest."))
    }

    @Test func `reply preview follows the producer UTF-16 bound`() throws {
        let answer = String(repeating: "🦊", count: 2048)
        #expect(try self.decode([
            "status": "ok", "terminalReply": ["disposition": "visible", "text": answer],
        ]).outcome == .answer(answer))
        #expect(try self.decode([
            "status": "ok", "terminalReply": ["disposition": "visible", "text": answer + "a"],
        ]).outcome == .unavailable)
    }

    @Test(arguments: [false, true])
    func `wait uses captured profile and rejects a retired connection`(retired: Bool) async throws {
        let requests = ReplyRequests(retire: retired)
        let gateway = self.gateway(requests)
        let result = try await gateway.waitForReply(self.run)
        #expect(result.outcome == (retired ? .unavailable : .answer("Requested answer")))
        #expect(await requests.methods == ["agent.wait"])
        #expect(await requests.profiles == ["profile-a"])
        #expect(await requests.runIDs == [self.run.runID])
    }

    @Test func `cancellation stops observation without sending an abort or retry`() async throws {
        let requests = ReplyRequests(suspend: true)
        let gateway = self.gateway(requests)
        let task = Task { try await gateway.waitForReply(self.run) }
        await requests.waitUntilRequested()
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(await requests.methods == ["agent.wait"])
    }

    @Test(arguments: [false, true])
    func `cancellation during the final authority check suppresses every result`(retired: Bool) async throws {
        let requests = ReplyRequests(retire: retired, suspendFinalCheck: true)
        let gateway = self.gateway(requests)
        let task = Task { try await gateway.waitForReply(self.run) }
        await requests.waitUntilFinalCheck()
        task.cancel()
        await requests.finishFinalCheck()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(await requests.methods == ["agent.wait"])
    }

    private func gateway(_ requests: ReplyRequests) -> OpenClawChatNativeActionGateway {
        .init(
            gatewayID: self.run.session.owner.gatewayID,
            gatewayName: "Gateway",
            supportsProfileBinding: { true },
            request: { try await requests.respond($0, profile: $1) },
            isCurrent: { await requests.isCurrent() })
    }

    private func decode(_ fields: [String: Any]) throws -> OpenClawNativeRunReply {
        var payload: [String: Any] = ["runId": run.runID]
        payload.merge(fields) { _, value in value }
        return try OpenClawChatGatewayPayloadCodec.decodeNativeRunReply(
            JSONSerialization.data(withJSONObject: payload), run: self.run)
    }
}

private actor ReplyRequests {
    var methods: [String] = []
    var profiles: [String?] = []
    var runIDs: [String?] = []
    var current = true
    let retire: Bool
    let suspend: Bool
    let suspendFinalCheck: Bool
    private var requested: CheckedContinuation<Void, Never>?
    private var finalCheckEntered: CheckedContinuation<Void, Never>?
    private var finalCheckRelease: CheckedContinuation<Void, Never>?

    init(retire: Bool = false, suspend: Bool = false, suspendFinalCheck: Bool = false) {
        self.retire = retire
        self.suspend = suspend
        self.suspendFinalCheck = suspendFinalCheck
    }

    func isCurrent() async -> Bool {
        if self.suspendFinalCheck, !self.methods.isEmpty {
            await withCheckedContinuation { continuation in
                self.finalCheckRelease = continuation
                self.finalCheckEntered?.resume()
                self.finalCheckEntered = nil
            }
        }
        return self.current
    }

    func waitUntilFinalCheck() async {
        if self.finalCheckRelease != nil { return }
        await withCheckedContinuation { self.finalCheckEntered = $0 }
    }

    func finishFinalCheck() {
        self.finalCheckRelease?.resume()
        self.finalCheckRelease = nil
    }

    func waitUntilRequested() async {
        if !self.methods.isEmpty {
            return
        }
        await withCheckedContinuation { self.requested = $0 }
    }

    func respond(_ request: OpenClawChatGatewayRequest, profile: String?) async throws -> Data {
        self.methods.append(request.method)
        self.profiles.append(profile)
        let runID = request.params["runId"]?.value as? String
        self.runIDs.append(runID)
        self.requested?.resume()
        self.requested = nil
        if self.suspend {
            try await Task.sleep(for: .seconds(60))
        }
        self.current = !self.retire
        return try JSONSerialization.data(withJSONObject: [
            "runId": runID ?? "", "status": "ok",
            "terminalReply": ["disposition": "visible", "text": "Requested answer"],
        ])
    }
}
