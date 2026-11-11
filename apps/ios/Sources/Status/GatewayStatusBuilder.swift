import Foundation
import OpenClawKit

enum GatewayDisplayState: Equatable {
    case connected
    case connecting
    case error
    case disconnected
}

/// In-flight connection work the model owns; any later status write clears it.
enum GatewayConnectionProgress: Equatable {
    case connecting
    case reconnecting
    case verifyingTLS
    case awaitingTrust
}

enum GatewayStatusBuilder {
    @MainActor
    static func buildChat(appModel: NodeAppModel) -> GatewayDisplayState {
        if appModel.isOperatorGatewayConnected || appModel.isLocalChatFixtureEnabled {
            return .connected
        }
        let state = self.build(appModel: appModel)
        return state == .connected ? .disconnected : state
    }

    @MainActor
    static func build(appModel: NodeAppModel) -> GatewayDisplayState {
        self.build(
            gatewayServerName: appModel.gatewayServerName,
            lastGatewayProblem: appModel.lastGatewayProblem,
            connectionProgress: appModel.gatewayConnectionProgress,
            gatewayStatusText: appModel.gatewayStatusText)
    }

    static func build(
        gatewayServerName: String?,
        lastGatewayProblem: GatewayConnectionProblem?,
        connectionProgress: GatewayConnectionProgress? = nil,
        gatewayStatusText: String) -> GatewayDisplayState
    {
        if lastGatewayProblem != nil { return .error }
        if gatewayServerName != nil { return .connected }
        switch connectionProgress {
        case .awaitingTrust:
            // The connect is paused on the user's certificate decision.
            return .error
        case .connecting, .reconnecting, .verifyingTLS:
            return .connecting
        case nil:
            break
        }

        let text = gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.localizedCaseInsensitiveContains("connecting") {
            return .connecting
        }

        if text.localizedCaseInsensitiveContains("error") {
            return .error
        }

        return .disconnected
    }
}
