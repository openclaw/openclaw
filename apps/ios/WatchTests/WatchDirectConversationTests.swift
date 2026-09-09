import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawWatchApp

struct WatchDirectConversationTests {
    @Test func `direct send ownership distinguishes Unicode and companion namespaces`() {
        let direct = WatchDirectRoute(
            gatewayID: "watch-direct:https://gateway.example.invalid/team",
            setupSentAtMs: 1, agentID: "agent-e\u{301}", sessionKey: "chat-e\u{301}")
        #expect(direct != WatchDirectRoute(
            gatewayID: direct.gatewayID, setupSentAtMs: 1,
            agentID: "agent-\u{E9}", sessionKey: direct.sessionKey))
        #expect(direct != WatchDirectRoute(
            gatewayID: direct.gatewayID, setupSentAtMs: 1,
            agentID: direct.agentID, sessionKey: "chat-\u{E9}"))
        #expect(direct != WatchDirectRoute(
            gatewayID: "phone-gateway", setupSentAtMs: 1,
            agentID: direct.agentID, sessionKey: direct.sessionKey))
        #expect(direct != WatchDirectRoute(
            gatewayID: direct.gatewayID, setupSentAtMs: 2,
            agentID: direct.agentID, sessionKey: direct.sessionKey))
    }

    @Test func `approval controls use canonical decisions and freeze for readback`() throws {
        let pending = try Self.pending(expiresAtMs: Int(Date().timeIntervalSince1970 * 1000) + 60000)
        var record = WatchDirectApproval(snapshot: .pending(pending))
        #expect(record.kind == .exec)
        #expect(record.decisions == [.deny])
        #expect(record.rawID.utf8.elementsEqual("approval-e\u{301}".utf8))
        #expect(record.detail.contains("do not hide the warning"))
        record.needsReadback = true
        #expect(record.decisions.isEmpty)
        record.needsReadback = false
        record.resolving = true
        #expect(record.decisions.isEmpty)
        let expired = try WatchDirectApproval(snapshot: .pending(Self.pending(expiresAtMs: 1)))
        #expect(expired.decisions.isEmpty)
    }

    @Test func `already committed approval response remains terminal when applied is false`() throws {
        let pending = try Self.pending(expiresAtMs: 100)
        let terminal = DeniedApprovalSnapshot(
            id: pending.id, urlpath: pending.urlpath, createdatms: 0, expiresatms: 100,
            presentation: pending.presentation, resolvedatms: 10,
            status: "denied", decision: "deny", reason: .user)
        let response = ApprovalResolveResult(applied: false, approval: .denied(terminal))
        let decoded = try JSONDecoder().decode(
            ApprovalResolveResult.self, from: JSONEncoder().encode(response))
        #expect(!decoded.applied)
        let snapshot = try JSONDecoder().decode(
            ApprovalSnapshot.self, from: JSONEncoder().encode(decoded.approval))
        let record = WatchDirectApproval(snapshot: snapshot)
        #expect(record.decisions.isEmpty)
        #expect(record.id == WatchOpaqueUTF8Key(pending.id))
    }

    @Test(arguments: [
        (
            #"{"kind":"payment","amount":"149.95","currency":"USD","target":"Example Supplier"}"#,
            ["149.95", "USD", "Example Supplier"]),
        (#"""
        {"kind":"message-send","target":"team-channel","recipientCount":3,
         "recipients":["Reviewer One","Reviewer Two"],"audience":"external"}
        """#, ["team-channel", "3", "Reviewer One", "Reviewer Two", "external", "1 more recipients"]),
        (
            #"{"kind":"external-post","target":"public-feed","visibility":"public"}"#,
            ["public-feed", "Visibility: public"]),
        (
            #"{"kind":"external-post","target":"private-feed","visibility":"restricted"}"#,
            ["private-feed", "Visibility: restricted"]),
        (#"""
        {"kind":"standing-grant","automation":"Nightly report","command":"report --publish","expiresInDays":7}
        """#, ["Nightly report", "report --publish", "without asking", "7 days", "revocable"]),
        (
            #"{"kind":"standing-grant","automation":"Daily report","command":"report --check"}"#,
            ["Daily report", "report --check", "Until revoked or the automation changes"]),
    ])
    func `approval review includes authoritative scope terms`(_ json: String, _ required: [String]) throws {
        let scope = try JSONDecoder().decode(ApprovalScope.self, from: Data(json.utf8))
        let presentations: [ApprovalPresentation] = [
            .exec(ExecApprovalPresentation(
                kind: "exec", commandtext: "tool --run", commandpreview: AnyCodable("Run tool"),
                warningtext: AnyCodable("Review the target"),
                host: AnyCodable("execution-host"), nodeid: AnyCodable("node-e\u{301}"),
                agentid: AnyCodable("agent-one"), scope: scope, alloweddecisions: [.allowOnce, .deny])),
            .plugin(PluginApprovalPresentation(
                kind: "plugin", title: "Tool approval", description: "Review the request",
                severity: .critical, pluginid: AnyCodable("example-plugin"), toolname: AnyCodable("tool.run"),
                agentid: AnyCodable("agent-one"), scope: scope, alloweddecisions: [.allowOnce, .deny])),
        ]
        for presentation in presentations {
            let approval = WatchDirectApproval(snapshot: .pending(PendingApprovalSnapshot(
                id: "scope-approval", urlpath: "/approval/scope-approval", createdatms: 0,
                expiresatms: Int.max, presentation: presentation, status: "pending")))
            for term in required + ["agent-one"] {
                #expect(approval.detail.contains(term))
            }
            switch presentation {
            case .exec:
                for term in ["Run tool", "Review the target", "execution-host", "node-e\u{301}"] {
                    #expect(approval.detail.contains(term))
                }
            case .plugin:
                for term in ["critical", "example-plugin", "tool.run"] {
                    #expect(approval.detail.contains(term))
                }
            case .systemAgent:
                Issue.record("Unexpected fixture presentation")
            }
            #expect(approval.decisions == [.allowOnce, .deny])
        }
    }

    @Test func `system agent review preserves the proposal identity`() {
        let approval = WatchDirectApproval(snapshot: .pending(PendingApprovalSnapshot(
            id: "proposal-one", urlpath: "/approval/proposal-one", createdatms: 0,
            expiresatms: Int.max,
            presentation: .systemAgent(SystemAgentApprovalPresentation(
                kind: "system-agent", title: "Change settings", description: "Review proposed changes",
                proposalhash: "proposal-digest", agentid: AnyCodable("settings-agent"),
                alloweddecisions: [AnyCodable("deny")])),
            status: "pending")))
        #expect(approval.detail.contains("proposal-digest"))
        #expect(approval.detail.contains("settings-agent"))
        #expect(approval.decisions == [.deny])
    }

    @Test(arguments: [
        ("exec", "host", "Host"),
        ("exec", "nodeId", "Node"),
        ("exec", "agentId", "Agent"),
        ("exec", "commandPreview", "Command preview"),
        ("exec", "warningText", "Warning"),
        ("plugin", "pluginId", "Plugin"),
        ("plugin", "toolName", "Tool"),
        ("plugin", "agentId", "Agent"),
        ("system-agent", "agentId", "Agent"),
    ])
    func `unsupported nullable context blocks allows without hiding the field`(
        _ kind: String,
        _ field: String,
        _ label: String) throws
    {
        for value in [17, ["unexpected": true], ["unexpected"]] as [Any] {
            let approval = try Self.contextApproval(kind: kind, field: field, value: value)
            #expect(approval.detail.contains("Unsupported"))
            #expect(approval.detail.contains(label))
            #expect(approval.decisions == [.deny])
        }
        let validNull = try Self.contextApproval(kind: kind, field: field, value: NSNull())
        #expect(validNull.decisions == [.allowOnce, .deny])
        let exact = "context-e\u{301}"
        let valid = try Self.contextApproval(kind: kind, field: field, value: exact)
        #expect(Data(valid.detail.utf8).range(of: Data(exact.utf8)) != nil)
        #expect(valid.decisions == [.allowOnce, .deny])
    }

    @Test(arguments: [
        #"{"kind":"external-post","target":"feed","visibility":"future"}"#,
        #"{"kind":"external-post","target":"feed","visibility":17}"#,
        #"{"kind":"external-post","target":"feed","visibility":null}"#,
        #"{"kind":"message-send","target":"team","recipientCount":1,"audience":"future"}"#,
        #"{"kind":"message-send","target":"team","recipientCount":1,"audience":{"external":true}}"#,
    ])
    func `unsupported scope cannot become a restricted or allow-capable review`(_ json: String) throws {
        let scope = try JSONDecoder().decode(ApprovalScope.self, from: Data(json.utf8))
        for decisions in [[.allowOnce, .allowAlways, .deny], [.allowOnce]] as [[ApprovalDecision]] {
            let approval = WatchDirectApproval(snapshot: .pending(PendingApprovalSnapshot(
                id: "unsupported-scope", urlpath: "/approval/unsupported-scope", createdatms: 0,
                expiresatms: Int.max,
                presentation: .exec(ExecApprovalPresentation(
                    kind: "exec", commandtext: "run", scope: scope, alloweddecisions: decisions)),
                status: "pending")))
            #expect(approval.detail.contains("Unsupported"))
            #expect(!approval.detail.contains("Visibility: restricted"))
            #expect(approval.decisions == decisions.filter { $0 == .deny })
        }
    }

    private static func contextApproval(kind: String, field: String, value: Any) throws -> WatchDirectApproval {
        var presentation: [String: Any] = switch kind {
        case "exec":
            ["kind": kind, "commandText": "run"]
        case "plugin":
            ["kind": kind, "title": "Review", "description": "Review request", "severity": "warning"]
        default:
            [
                "kind": kind, "title": "Review", "description": "Review request",
                "proposalHash": String(repeating: "a", count: 64),
            ]
        }
        presentation["allowedDecisions"] = ["allow-once", "deny"]
        presentation[field] = value
        let decoded = try JSONDecoder().decode(
            ApprovalPresentation.self, from: JSONSerialization.data(withJSONObject: presentation))
        return WatchDirectApproval(snapshot: .pending(PendingApprovalSnapshot(
            id: "context", urlpath: "/approval/context", createdatms: 0,
            expiresatms: Int.max, presentation: decoded, status: "pending")))
    }

    private static func pending(expiresAtMs: Int) throws -> PendingApprovalSnapshot {
        PendingApprovalSnapshot(
            id: "approval-e\u{301}", urlpath: "/approval/example", createdatms: 0,
            expiresatms: expiresAtMs,
            presentation: .exec(ExecApprovalPresentation(
                kind: "exec", commandtext: "echo example",
                warningtext: AnyCodable("do not hide the warning"), alloweddecisions: [.deny])),
            status: "pending")
    }
}
