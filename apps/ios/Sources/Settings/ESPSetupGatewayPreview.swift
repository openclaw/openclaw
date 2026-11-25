import Foundation
import OpenClawKit

/// A short-lived grant from the current operator connection, never a phone connection target.
@MainActor
struct ESPSetupGatewayPreview {
    let code: String
    let link: GatewayConnectDeepLink
    private let authorityGeneration: UInt64
    private let route: GatewayNodeSessionRoute

    static func prepare(appModel: NodeAppModel) async throws -> Self {
        struct Response: Decodable { let setupCode: String }
        let generation = appModel.operatorAuthorityGeneration
        guard let route = await appModel.operatorSession.currentRoute() else { throw CancellationError() }
        try Self.checkAuthority(appModel, generation: generation)
        let data = try await appModel.operatorSession.request(
            method: "device.pair.setupCode",
            paramsJSON: #"{"includeQr":false,"bootstrapProfile":"voice-node"}"#,
            timeoutSeconds: 20,
            ifCurrentRoute: route)
        let code = try JSONDecoder().decode(Response.self, from: data).setupCode
        guard code.utf8.count <= 4096, let link = GatewayConnectDeepLink.fromSetupCode(code) else {
            throw ESPSetupError.unavailable("The Gateway returned an invalid or expired setup code. Prepare a new one.")
        }
        let preview = Self(code: code, link: link, authorityGeneration: generation, route: route)
        try await preview.authorize(appModel: appModel)
        return preview
    }

    func authorize(appModel: NodeAppModel) async throws {
        let current = await appModel.operatorSession.currentRoute()
        try Self.checkAuthority(appModel, generation: self.authorityGeneration)
        guard current == self.route, GatewayConnectDeepLink.fromSetupCode(self.code) != nil else {
            throw ESPSetupError.unavailable("The Gateway connection or setup code changed. Prepare a new setup code.")
        }
    }

    private static func checkAuthority(_ appModel: NodeAppModel, generation: UInt64) throws {
        try Task.checkCancellation()
        guard appModel.operatorAuthorityGeneration == generation,
              appModel.isOperatorGatewayConnected, appModel.hasOperatorAdminScope
        else {
            throw ESPSetupError
                .unavailable(
                    "Connect this phone to the Gateway with operator.admin access, then prepare a new setup code.")
        }
    }
}
