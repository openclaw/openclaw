import Foundation

enum AmbientAssistantTone: String, CaseIterable, Equatable {
    case ready
    case reading
    case planning
    case waitingForApproval
    case working
    case success
    case blocked
    case error

    var statusLabel: String {
        switch self {
        case .ready:
            "Ready"
        case .reading:
            "Reading"
        case .planning:
            "Planning"
        case .waitingForApproval:
            "Approval"
        case .working:
            "Working"
        case .success:
            "Done"
        case .blocked:
            "Blocked"
        case .error:
            "Error"
        }
    }

    var symbolName: String {
        switch self {
        case .ready:
            "sparkles"
        case .reading:
            "eye"
        case .planning:
            "point.topleft.down.curvedto.point.bottomright.up"
        case .waitingForApproval:
            "checkmark.shield"
        case .working:
            "gearshape.2"
        case .success:
            "checkmark.circle"
        case .blocked:
            "exclamationmark.triangle"
        case .error:
            "xmark.octagon"
        }
    }
}

enum AmbientAssistantAvailability: String, Equatable {
    case available
    case needsPermission
    case needsApproval
    case unavailable
}

enum AmbientAssistantApprovalState: String, Equatable {
    case notRequired
    case required
    case approved
    case blocked
}

struct AmbientAssistantContextSnapshot: Equatable {
    var frontApp: String
    var sessionLabel: String
    var gatewayLabel: String
    var deviceLabel: String
    var permissionSummaries: [String]
    var confidenceLabel: String
}

struct AmbientAssistantCapability: Equatable, Identifiable {
    var id: String
    var title: String
    var detail: String
    var availability: AmbientAssistantAvailability
}

struct AmbientAssistantProposalSummary: Equatable, Identifiable {
    var id: String
    var title: String
    var detail: String
    var approvalState: AmbientAssistantApprovalState
    var tone: AmbientAssistantTone
}

struct AmbientAssistantReceiptSummary: Equatable {
    var summary: String
    var detail: String
    var tone: AmbientAssistantTone
}

struct AmbientAssistantLaneItem: Equatable, Identifiable {
    var id: String
    var title: String
    var detail: String
    var tone: AmbientAssistantTone
}

struct AmbientAssistantSurfaceSnapshot: Equatable {
    var context: AmbientAssistantContextSnapshot
    var capabilities: [AmbientAssistantCapability]
    var proposals: [AmbientAssistantProposalSummary]
    var receipt: AmbientAssistantReceiptSummary
    var subagents: [AmbientAssistantLaneItem]
    var status: AmbientAssistantLaneItem

    static let `default` = AmbientAssistantSurfaceSnapshot(
        context: AmbientAssistantContextSnapshot(
            frontApp: "Current app",
            sessionLabel: "main session",
            gatewayLabel: "Gateway local",
            deviceLabel: "iPhone handoff not checked",
            permissionSummaries: ["Screen: optional", "Accessibility: optional"],
            confidenceLabel: "Local context"),
        capabilities: [
            AmbientAssistantCapability(
                id: "gateway.health",
                title: "Gateway health",
                detail: "Available through local diagnostics",
                availability: .available),
            AmbientAssistantCapability(
                id: "context.screen",
                title: "Screen context",
                detail: "Requires Screen Recording for visual summaries",
                availability: .needsPermission),
            AmbientAssistantCapability(
                id: "handoff.iphone",
                title: "iPhone handoff",
                detail: "Visible now, execution ships in cross-device phase",
                availability: .unavailable),
        ],
        proposals: [
            AmbientAssistantProposalSummary(
                id: "phase1.safe",
                title: "Ask or command Thomas",
                detail: "Prompts and local commands are available now",
                approvalState: .notRequired,
                tone: .ready),
        ],
        receipt: AmbientAssistantReceiptSummary(
            summary: "No recent ambient actions",
            detail: "Receipts will appear after approved assistant actions run",
            tone: .ready),
        subagents: [
            AmbientAssistantLaneItem(id: "context", title: "Context Scout", detail: "Ready", tone: .ready),
            AmbientAssistantLaneItem(id: "planner", title: "Intent Planner", detail: "Command-first in phase 1", tone: .planning),
            AmbientAssistantLaneItem(id: "safety", title: "Safety Clerk", detail: "Ask-first for risky work", tone: .waitingForApproval),
        ],
        status: AmbientAssistantLaneItem(
            id: "status",
            title: "Thomas",
            detail: "Ready for a prompt or slash command",
            tone: .ready))
}
