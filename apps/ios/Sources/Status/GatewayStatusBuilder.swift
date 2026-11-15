import Foundation
import OpenClawKit

enum GatewayDisplayState: Equatable {
    case connected
    case connecting
    case error
    case disconnected
}

/// Preconnect work before a route commits: the controller's handoff, a TLS probe, or the user's
/// certificate decision. Session phases own every state after the route commits.
enum GatewayConnectionProgress: Equatable {
    case connecting
    case verifyingTLS
    case awaitingTrust

    var statusText: String {
        switch self {
        case .connecting: String(localized: "Connecting…")
        case .verifyingTLS: String(localized: "Verifying gateway TLS fingerprint…")
        case .awaitingTrust: String(localized: "Verify gateway TLS fingerprint")
        }
    }
}

/// What a connection surface shows, in precedence order: a problem, a one-off notice, a live
/// connection, preconnect progress, then the condition of the session the surface follows. A notice
/// keeps its session's state, so an action's failure stays readable while connected; a node
/// transition clears it. A notice and progress never coexist.
enum GatewayStatusSource: Equatable {
    case problem(GatewayConnectionProblem)
    case progress(GatewayConnectionProgress)
    /// A notice reports an action; the session it sits on still decides the state.
    case notice(String, GatewaySessionPhase)
    case phase(GatewaySessionPhase)

    var displayState: GatewayDisplayState {
        switch self {
        case .problem, .progress(.awaitingTrust):
            // The connect is paused on a problem or on the user's certificate decision.
            .error
        case .progress(.connecting), .progress(.verifyingTLS):
            .connecting
        case let .notice(_, phase), let .phase(phase):
            switch phase {
            case .idle: .disconnected
            case .connecting: .connecting
            case .connected: .connected
            case .paused: .error
            }
        }
    }

    var statusText: String {
        switch self {
        case let .problem(problem): problem.localizedStatusText
        case let .progress(progress): progress.statusText
        case let .notice(notice, _): notice
        case let .phase(phase): GatewayStatusBuilder.statusText(phase)
        }
    }
}

/// Every connection surface derives from the session phases, the retained problem, and preconnect
/// progress. Gateway surfaces follow the node session; chat and operator surfaces follow the operator.
enum GatewayStatusBuilder {
    @MainActor
    static func build(appModel: NodeAppModel) -> GatewayDisplayState {
        self.source(for: appModel.connection.node, appModel: appModel).displayState
    }

    @MainActor
    static func buildChat(appModel: NodeAppModel) -> GatewayDisplayState {
        if appModel.isLocalChatFixtureEnabled { return .connected }
        return self.buildChat(
            connection: appModel.connection,
            lastGatewayProblem: appModel.lastGatewayProblem,
            progress: appModel.gatewayConnectionProgress)
    }

    /// The one precedence every surface maps from. Any pause, the operator's included, stops both
    /// loops and needs attention.
    static func source(
        for phase: GatewaySessionPhase,
        connection: GatewayConnection,
        lastGatewayProblem: GatewayConnectionProblem?,
        progress: GatewayConnectionProgress?,
        notice: String?) -> GatewayStatusSource
    {
        if let problem = lastGatewayProblem ?? connection.pausedProblem { return .problem(problem) }
        if let notice { return .notice(notice, phase) }
        if phase.connectedInfo != nil { return .phase(phase) }
        if let progress { return .progress(progress) }
        return .phase(phase)
    }

    @MainActor
    static func source(for phase: GatewaySessionPhase, appModel: NodeAppModel) -> GatewayStatusSource {
        self.source(
            for: phase,
            connection: appModel.connection,
            lastGatewayProblem: appModel.lastGatewayProblem,
            progress: appModel.gatewayConnectionProgress,
            notice: appModel.gatewayStatusText)
    }

    /// The node session's state.
    static func build(
        connection: GatewayConnection,
        lastGatewayProblem: GatewayConnectionProblem?,
        progress: GatewayConnectionProgress?) -> GatewayDisplayState
    {
        self.source(
            for: connection.node,
            connection: connection,
            lastGatewayProblem: lastGatewayProblem,
            progress: progress,
            notice: nil).displayState
    }

    /// The operator session's state. Bootstrap pairing runs no operator loop, so an idle operator
    /// follows the node attempt; a connected node alone cannot serve chat.
    static func buildChat(
        connection: GatewayConnection,
        lastGatewayProblem: GatewayConnectionProblem?,
        progress: GatewayConnectionProgress?) -> GatewayDisplayState
    {
        let gateway = self.build(connection: connection, lastGatewayProblem: lastGatewayProblem, progress: progress)
        switch connection.operator {
        case .connected:
            return .connected
        case .idle:
            return gateway == .connected ? .disconnected : gateway
        case .connecting, .paused:
            return gateway == .error ? .error : .connecting
        }
    }

    /// One session's condition, as the Quick Setup rows show it.
    static func statusText(_ phase: GatewaySessionPhase) -> String {
        switch phase {
        case .idle: String(localized: "Offline")
        case .connecting(reconnect: true): String(localized: "Reconnecting…")
        case .connecting(reconnect: false): String(localized: "Connecting…")
        case .connected: String(localized: "Connected")
        case let .paused(problem): problem.localizedStatusText
        }
    }
}
