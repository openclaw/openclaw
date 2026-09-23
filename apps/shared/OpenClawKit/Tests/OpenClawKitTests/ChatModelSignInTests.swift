import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatModelSignInTests {
    @Test func `lost connection retires sign-in even when captured cleanup cannot run`() async throws {
        var current = true
        var cleanupAttempts = 0
        var catalogRefreshes = 0
        let context = OpenClawChatModelSignInContext(
            agentID: "fixture-agent",
            request: { method, params in
                switch method {
                case "models.authStatus":
                    return Data(
                        #"{"providers":[],"providerCapabilities":[{"loginOptions":[{"id":"fixture/device","label":"Sign in"}]}]}"#
                            .utf8)
                case "models.authLogin":
                    return try JSONEncoder().encode(WizardStartResult(
                        sessionid: #require(params["sessionId"]?.stringValue), done: false,
                        step: WizardStep(id: "code", type: AnyCodable("note"), executor: AnyCodable("client"))))
                case "wizard.next":
                    current = false
                    throw CancellationError()
                default:
                    Issue.record("Unexpected sign-in request: \(method)")
                    throw CancellationError()
                }
            },
            closeWizard: { _ in
                cleanupAttempts += 1
                throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch
            },
            isCurrent: { current })
        let model = ChatModelSignInModel(context: context, onAuthChanged: { catalogRefreshes += 1 })
        await model.refresh()
        try await model.start(#require(model.authStatus?.loginOptions.first))
        #expect(model.sessionID != nil)
        await model.answer()
        #expect(model.message == "The connection changed. Close sign-in and open it again.")
        await model.close()

        #expect(model.sessionID == nil)
        #expect(model.step == nil)
        #expect(model.authStatus == nil)
        #expect(!model.busy)
        #expect(cleanupAttempts == 1)
        #expect(catalogRefreshes == 0)
    }

    @Test(arguments: [
        ("success", true, false),
        ("not_started", true, false),
        ("not_started", false, false),
        ("may_have_executed", true, false),
        ("may_have_executed", false, false),
        ("may_have_executed", false, true),
    ])
    func `held admission preserves cleanup custody without publishing auth state`(
        outcome: String, closeBeforeAdmission: Bool, cleanupFails: Bool) async throws
    {
        let started = AsyncStream<Void>.makeStream()
        defer { started.continuation.finish() }
        var pendingLogin: CheckedContinuation<Data, any Error>?
        var current = true
        var admitted = false
        var cleanupShouldFail = cleanupFails
        var statusReads = 0
        var newSessionCatalogRefreshes = 0
        var cancelledSessionIDs: [String] = []
        let context = OpenClawChatModelSignInContext(
            agentID: "old-agent",
            request: { method, _ in
                switch method {
                case "models.authStatus":
                    statusReads += 1
                    return Data(
                        #"{"providers":[],"providerCapabilities":[{"loginOptions":[{"id":"fixture/device","label":"Sign in"}]}]}"#
                            .utf8)
                case "models.authLogin":
                    return try await withCheckedThrowingContinuation { continuation in
                        pendingLogin = continuation
                        started.continuation.yield()
                    }
                default:
                    Issue.record("Stale sign-in must not request \(method)")
                    throw CancellationError()
                }
            },
            closeWizard: { sessionID in
                cancelledSessionIDs.append(sessionID)
                if !admitted {
                    throw GatewayResponseError(
                        method: "wizard.cancel",
                        code: "INVALID_REQUEST",
                        message: "Not admitted yet",
                        details: ["code": AnyCodable("WIZARD_NOT_FOUND")])
                }
                if cleanupShouldFail { throw URLError(.networkConnectionLost) }
                return try JSONEncoder().encode(WizardStatusResult(status: AnyCodable("cancelled")))
            },
            isCurrent: { current })
        let model = ChatModelSignInModel(context: context, onAuthChanged: { newSessionCatalogRefreshes += 1 })
        await model.refresh()
        let option = try #require(model.authStatus?.loginOptions.first)
        let login = Task { await model.start(option) }
        do {
            var events = started.stream.makeAsyncIterator()
            _ = await events.next()
            let oldSessionID = try #require(model.sessionID)
            if closeBeforeAdmission {
                current = false
                await model.close()
            }
            admitted = true
            if outcome == "success" {
                let response = try JSONEncoder().encode(WizardStartResult(sessionid: oldSessionID, done: false))
                pendingLogin?.resume(returning: response)
            } else {
                pendingLogin?.resume(throwing: GatewayResponseError(
                    method: "models.authLogin",
                    code: "INVALID_REQUEST",
                    message: "Selected profile changed",
                    details: [
                        "reason": AnyCodable("EXPECTED_PROFILE_MISMATCH"),
                        "execution": AnyCodable(outcome),
                    ]))
            }
            pendingLogin = nil
            await login.value

            let expectedCloses = (closeBeforeAdmission ? 1 : 0) + (outcome == "not_started" ? 0 : 1)
            #expect(cancelledSessionIDs == Array(repeating: oldSessionID, count: expectedCloses))
            #expect(model.sessionID == (cleanupFails ? oldSessionID : nil))
            #expect(model.step == nil)
            #expect(statusReads == 1)
            #expect(newSessionCatalogRefreshes == 0)
            if cleanupFails {
                cleanupShouldFail = false
                await model.close()
                #expect(model.sessionID == nil)
                #expect(cancelledSessionIDs == [oldSessionID, oldSessionID])
            }
        } catch {
            pendingLogin?.resume(throwing: error)
            pendingLogin = nil
            await login.value
            throw error
        }
    }

    @Test(arguments: ["done", "error", "cancelled"])
    func `device code is not login completion and terminal errors still refresh published state`(
        terminalStatus: String) async throws
    {
        var loginFinished = false
        var catalogRefreshes = 0
        var statusReads = 0
        let context = OpenClawChatModelSignInContext(
            agentID: "fixture-agent",
            request: { method, params in
                switch method {
                case "models.authStatus":
                    #expect(params["agentId"]?.stringValue == "fixture-agent")
                    statusReads += 1
                    let status = loginFinished ? "ok" : "missing"
                    return Data("""
                    {"providers":[{"provider":"fixture","displayName":"Fixture","status":"\(status)"}],
                     "providerCapabilities":[{"loginOptions":[{"id":"fixture/device","label":"Sign in"}]}]}
                    """.utf8)
                case "models.authLogin":
                    #expect(params["agentId"]?.stringValue == "fixture-agent")
                    #expect(params["authChoice"]?.stringValue == "fixture/device")
                    return try JSONEncoder().encode(WizardStartResult(
                        sessionid: #require(params["sessionId"]?.stringValue), done: false))
                case "wizard.next":
                    if params["answer"] != nil {
                        loginFinished = true
                        return try JSONEncoder().encode(WizardNextResult(
                            done: true, status: AnyCodable(terminalStatus),
                            error: terminalStatus == "error" ? "Later setup failed" : nil))
                    }
                    return try JSONEncoder().encode(WizardNextResult(
                        done: false,
                        step: WizardStep(
                            id: "code", type: AnyCodable("note"), executor: AnyCodable("client"),
                            devicecode: ["code": AnyCodable("ABCD-1234")]),
                        status: AnyCodable("running")))
                default:
                    Issue.record("Unexpected sign-in request: \(method)")
                    throw CancellationError()
                }
            },
            closeWizard: { _ in
                #expect(terminalStatus == "cancelled")
                return try JSONEncoder().encode(WizardStatusResult(status: AnyCodable("cancelled")))
            },
            isCurrent: { true })
        let model = ChatModelSignInModel(context: context, onAuthChanged: { catalogRefreshes += 1 })
        await model.refresh()
        let option = try #require(model.authStatus?.loginOptions.first)
        await model.start(option)

        #expect(parseWizardDeviceCode(model.step?.devicecode)?.code == "ABCD-1234")
        #expect(model.sessionID != nil)
        #expect(statusReads == 1)
        #expect(catalogRefreshes == 0)
        #expect(model.message == nil)

        if terminalStatus == "cancelled" {
            await model.cancel()
        } else {
            await model.answer()
        }

        #expect(model.sessionID == nil)
        #expect(model.step == nil)
        #expect(model.authStatus?.providers.first?.status == (terminalStatus == "cancelled" ? "missing" : "ok"))
        #expect(model.message == (terminalStatus == "done"
                ? "Sign-in finished."
                : "Sign-in ended. Review the account status before trying again."))
        #expect(statusReads == 2)
        #expect(catalogRefreshes == 1)
    }
}
