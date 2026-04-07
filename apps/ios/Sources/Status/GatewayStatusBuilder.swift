import Foundation

enum GatewayStatusBuilder {
    @MainActor
    static func build(appModel: NodeAppModel) -> StatusPill.GatewayState {
        if appModel.gatewayServerName != nil { return .connected }
        if appModel.lastGatewayProblem != nil { return .error }

        let text = appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
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
