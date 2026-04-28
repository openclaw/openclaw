import Foundation
import OpenClawKit

enum GatewayStatusBuilder {
    @MainActor
    static func build(appModel: NodeAppModel) -> StatusPill.GatewayState {
        self.build(
            gatewayServerName: appModel.gatewayServerName,
            lastGatewayProblem: appModel.lastGatewayProblem,
            gatewayStatusText: appModel.gatewayStatusText)
    }

    static func build(
        gatewayServerName: String?,
        lastGatewayProblem: GatewayConnectionProblem?,
        gatewayStatusText: String) -> StatusPill.GatewayState
    {
        if gatewayServerName != nil { return .connected }
        if let lastGatewayProblem, lastGatewayProblem.pauseReconnect { return .error }

        let text = gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.localizedCaseInsensitiveContains("connecting") ||
            text.localizedCaseInsensitiveContains("reconnecting")
        {
            return .connecting
        }

        if text.localizedCaseInsensitiveContains("error") {
            return .error
        }

        return .disconnected
    }
}
