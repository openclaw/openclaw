import Foundation
import OpenClawKit
import OpenClawProtocol

struct WatchDirectRoute: Equatable, Sendable {
    let gatewayID: String
    let setupSentAtMs: Int64?
    let agentID: String
    let sessionKey: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        GatewayStableIdentifier.matches(lhs.gatewayID, rhs.gatewayID)
            && lhs.setupSentAtMs == rhs.setupSentAtMs
            && lhs.agentID.utf8.elementsEqual(rhs.agentID.utf8)
            && lhs.sessionKey.utf8.elementsEqual(rhs.sessionKey.utf8)
    }
}

struct WatchDirectSession: Decodable, Identifiable, Sendable {
    let key: String
    let displayName: String?
    let derivedTitle: String?
    let label: String?
    var id: WatchOpaqueUTF8Key {
        WatchOpaqueUTF8Key(self.key)
    }

    var title: String {
        self.displayName ?? self.derivedTitle ?? self.label ?? self.key
    }
}

struct WatchDirectSessionList: Decodable, Sendable {
    let sessions: [WatchDirectSession]
}

struct WatchDirectHistory: Decodable, Sendable {
    let messages: [OpenClawProtocol.AnyCodable]
    let hasMore: Bool?
    let truncated: Bool?
}

struct WatchDirectMessage: Identifiable, Sendable {
    let id: WatchOpaqueUTF8Key
    let role: String
    let text: String

    init?(_ value: OpenClawProtocol.AnyCodable, fallbackID: String) {
        guard let object = value.dictionaryValue, let role = object["role"]?.stringValue else { return nil }
        let content = object["content"]
        let text = content?.stringValue ?? content?.arrayValue?.compactMap { part in
            guard part.dictionaryValue?["type"]?.stringValue == "text" else { return nil }
            return part.dictionaryValue?["text"]?.stringValue
        }.joined(separator: "\n") ?? ""
        guard !text.isEmpty else { return nil }
        let metadata = object["__openclaw"]?.dictionaryValue
        self.id = WatchOpaqueUTF8Key(metadata?["id"]?.stringValue ?? object["id"]?.stringValue ?? fallbackID)
        self.role = role
        self.text = String(text.prefix(20000))
    }
}

struct WatchDirectSubscription: Decodable, Sendable {
    let subscribed: Bool
    let key: String
    let approvalReplay: SessionApprovalReplay?
}

struct WatchDirectApproval: Identifiable, Sendable {
    var snapshot: ApprovalSnapshot
    var needsReadback = false
    var resolving = false

    var id: WatchOpaqueUTF8Key {
        WatchOpaqueUTF8Key(self.rawID)
    }

    var rawID: String {
        switch self.snapshot {
        case let .pending(value): value.id
        case let .allowed(value): value.id
        case let .denied(value): value.id
        case let .expired(value): value.id
        case let .cancelled(value): value.id
        }
    }

    var presentation: ApprovalPresentation {
        switch self.snapshot {
        case let .pending(value): value.presentation
        case let .allowed(value): value.presentation
        case let .denied(value): value.presentation
        case let .expired(value): value.presentation
        case let .cancelled(value): value.presentation
        }
    }

    var kind: ApprovalKind {
        switch self.presentation {
        case .exec: .exec
        case .plugin: .plugin
        case .systemAgent: .systemAgent
        }
    }

    var title: String {
        switch self.presentation {
        case .exec: String(localized: "Command execution")
        case let .plugin(value): value.title
        case let .systemAgent(value): value.title
        }
    }

    var detail: String {
        self.review.detail
    }

    /// The generated protocol leaves nullable strings and some enums as AnyCodable.
    /// Render and authorize from one projection so unsupported context cannot enable an allow.
    private var review: (detail: String, decisions: [ApprovalDecision]) {
        var unsupported: [String] = []
        func read(
            _ value: OpenClawProtocol.AnyCodable?,
            field: String,
            nullable: Bool = true,
            nonempty: Bool = false,
            choices: [String]? = nil) -> String?
        {
            guard let value else { return nil }
            if nullable, value.value is NSNull { return nil }
            guard let text = value.stringValue,
                  !nonempty || !text.isEmpty,
                  choices?.contains(text) != false
            else {
                unsupported.append(field)
                return nil
            }
            return text
        }
        let text: [String?]
        let context: [(String, String?)]
        let scope: ApprovalScope?
        let decisions: [ApprovalDecision]
        switch self.presentation {
        case let .exec(value):
            text = [
                read(value.commandpreview, field: String(localized: "Command preview")),
                value.commandtext,
                read(value.warningtext, field: String(localized: "Warning")),
            ]
            context = [
                (String(localized: "Host"), read(value.host, field: String(localized: "Host"))),
                (String(localized: "Node"), read(value.nodeid, field: String(localized: "Node"), nonempty: true)),
                (String(localized: "Agent"), read(value.agentid, field: String(localized: "Agent"), nonempty: true)),
            ]
            scope = value.scope
            decisions = value.alloweddecisions
        case let .plugin(value):
            text = [value.description, value.detail, value.externalresolution?.label]
            context = [
                (String(localized: "Severity"), value.severity.rawValue),
                (String(localized: "Plugin"), read(value.pluginid, field: String(localized: "Plugin"), nonempty: true)),
                (String(localized: "Tool"), read(value.toolname, field: String(localized: "Tool"), nonempty: true)),
                (String(localized: "Agent"), read(value.agentid, field: String(localized: "Agent"), nonempty: true)),
            ]
            scope = value.scope
            decisions = value.alloweddecisions
        case let .systemAgent(value):
            text = [value.description]
            context = [
                (String(localized: "Agent"), read(value.agentid, field: String(localized: "Agent"), nonempty: true)),
                (String(localized: "Proposal"), value.proposalhash),
            ]
            scope = nil
            decisions = value.alloweddecisions.compactMap {
                read($0, field: String(localized: "Decision"), nullable: false, choices: ["allow-once", "deny"])
                    .flatMap(ApprovalDecision.init(rawValue:))
            }
        }
        let metadata = context.compactMap { label, value in value.map { "\(label): \($0)" } }
        var lines = text.compactMap(\.self) + metadata
        switch scope {
        case let .messageSend(value):
            lines += [
                String(localized: "Target: \(value.target)"),
                String(localized: "Recipients: \(value.recipientcount)"),
            ]
            if let audience = read(
                value.audience,
                field: String(localized: "Audience"),
                nullable: false,
                choices: ["internal", "external"])
            {
                lines.append(String(localized: "Audience: \(audience)"))
            }
            let recipients = value.recipients ?? []
            lines.append(contentsOf: recipients)
            if value.recipientcount > recipients.count {
                lines.append(String(localized: "\(value.recipientcount - recipients.count) more recipients"))
            }
        case let .payment(value):
            lines += [
                String(localized: "Amount: \(value.amount) \(value.currency)"),
                String(localized: "Pay to: \(value.target)"),
            ]
        case let .externalPost(value):
            lines.append(String(localized: "Post to: \(value.target)"))
            if let visibility = read(
                value.visibility,
                field: String(localized: "Visibility"),
                nullable: false,
                choices: ["public", "restricted"])
            {
                lines.append(String(localized: "Visibility: \(visibility)"))
            }
        case let .standingGrant(value):
            lines += [
                String(localized: "Automation: \(value.automation)"),
                String(localized: "Always allow runs this exact command without asking:"),
                value.command,
                value.expiresindays.map { String(localized: "Expires in \($0) days; revocable") }
                    ?? String(localized: "Until revoked or the automation changes"),
            ]
        case nil:
            break
        }
        if !unsupported.isEmpty {
            let fields = unsupported.joined(separator: ", ")
            lines
                .append(
                    String(
                        localized: "Unsupported approval context: \(fields). Review on the Gateway before allowing."))
        }
        return (lines.joined(separator: "\n"), unsupported.isEmpty ? decisions : decisions.filter { $0 == .deny })
    }

    var decisions: [ApprovalDecision] {
        guard case let .pending(pending) = self.snapshot,
              pending.expiresatms > Int(Date().timeIntervalSince1970 * 1000),
              !self.needsReadback, !self.resolving
        else { return [] }
        return self.review.decisions
    }

    var status: String {
        if self.needsReadback { return String(localized: "Checking current decision...") }
        if self.resolving { return String(localized: "Sending decision...") }
        switch self.snapshot {
        case .pending: return String(localized: "Pending")
        case .allowed: return String(localized: "Allowed")
        case .denied: return String(localized: "Denied")
        case .expired: return String(localized: "Expired")
        case .cancelled: return String(localized: "Cancelled")
        }
    }
}
