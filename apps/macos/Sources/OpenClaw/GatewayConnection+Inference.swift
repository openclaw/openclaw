import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension GatewayConnection {
    struct ConfiguredInferenceModels {
        let primaryModel: String?
        let utilityModel: String?

        var setupModel: String? {
            self.primaryModel ?? self.utilityModel
        }

        var setupModelTarget: OnboardingAISetupModel.ModelTarget? {
            self.primaryModel == nil && self.utilityModel != nil ? .utility : nil
        }
    }

    func configuredInferenceModels(
        ifCurrentRoute route: Route,
        timeoutMs: Double = 15000) async throws -> ConfiguredInferenceModels
    {
        let data = try await request(
            OpenClawChatGatewayRequests.agentsList(timeoutMs: timeoutMs),
            ifCurrentRoute: route)
        guard await self.isCurrentRoute(route) else {
            throw CancellationError()
        }
        return try Self.decodeConfiguredInferenceModels(data)
    }

    static func decodeConfiguredInferenceModels(_ data: Data) throws -> ConfiguredInferenceModels {
        let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
        let agent = result.agents.first(where: { $0.id == result.defaultid })
        let primary = agent?.model?["primary"]?.value as? String
        // This preflight resumes setup receipts; verification owns readiness and
        // the utility-versus-primary dashboard handoff.
        let primaryModel = primary?.trimmingCharacters(in: .whitespacesAndNewlines)
        let utilityModel = agent?.utilitymodel?.trimmingCharacters(in: .whitespacesAndNewlines)
        return ConfiguredInferenceModels(
            primaryModel: primaryModel?.isEmpty == false ? primaryModel : nil,
            utilityModel: utilityModel?.isEmpty == false ? utilityModel : nil)
    }
}
