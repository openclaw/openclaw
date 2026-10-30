import Foundation
import OpenClawChatUI
import OpenClawKit

actor IOSSourceResourceLoader {
    private let gateway: GatewayNodeSession
    private let connectionProvider: IOSMediaArtifactLoader.ConnectionProvider
    private var cached: (
        route: GatewayNodeSessionRoute,
        connection: IOSMediaArtifactLoader.Connection,
        loader: OpenClawChatSourceResources)?

    init(gateway: GatewayNodeSession, connectionProvider: @escaping IOSMediaArtifactLoader.ConnectionProvider) {
        self.gateway = gateway
        self.connectionProvider = connectionProvider
    }

    func invalidate() async {
        let previous = self.cached?.loader
        self.cached = nil
        await previous?.invalidate()
    }

    func loadContext(ifCurrentRoute route: GatewayNodeSessionRoute) async -> OpenClawChatSourceContext? {
        await self.loader(ifCurrentRoute: route)?.loadContext()
    }

    func loadFavicon(host: String, ifCurrentRoute route: GatewayNodeSessionRoute) async -> Data? {
        await self.loader(ifCurrentRoute: route)?.loadFavicon(host: host)
    }

    private func loader(ifCurrentRoute route: GatewayNodeSessionRoute) async -> OpenClawChatSourceResources? {
        guard let connection = await connectionProvider(),
              await gateway.currentGatewayID(ifCurrentRoute: route) == connection.gatewayID,
              await gateway.currentRoute() == route
        else { return nil }
        if let cached, cached.route == route, Self.sameConnection(cached.connection, connection) {
            return cached.loader
        }
        if let previous = self.cached {
            self.cached = nil
            Task { await previous.loader.invalidate() }
        }
        let gateway = self.gateway
        let loader = OpenClawChatSourceResources(
            gatewayURL: connection.config.url,
            nativeControlPageURL: AuthenticatedControlUI.pageURL(config: connection.config, path: "", queryItems: []),
            request: { [weak self] url, maximumBytes in
                guard let self else { throw CancellationError() }
                return try await self.request(
                    url: url, maximumBytes: maximumBytes, connection: connection, route: route)
            },
            loadConfig: {
                try? await gateway.request(
                    method: "config.get", paramsJSON: "{}", ifCurrentRoute: route)
            },
            isCurrent: { [weak self] in
                await self?.isCurrent(connection: connection, route: route) == true
            })
        cached = (route, connection, loader)
        return loader
    }

    private func isCurrent(
        connection: IOSMediaArtifactLoader.Connection,
        route: GatewayNodeSessionRoute) async -> Bool
    {
        guard let current = await connectionProvider(),
              Self.sameConnection(current, connection),
              await gateway.currentRoute() == route
        else { return false }
        return true
    }

    private static func sameConnection(
        _ lhs: IOSMediaArtifactLoader.Connection,
        _ rhs: IOSMediaArtifactLoader.Connection) -> Bool
    {
        lhs.gatewayID == rhs.gatewayID && lhs.config.hasSameConnectionInputs(as: rhs.config) &&
            lhs.customHeaders == rhs.customHeaders
    }

    private func request(
        url: URL,
        maximumBytes: Int,
        connection: IOSMediaArtifactLoader.Connection,
        route: GatewayNodeSessionRoute) async throws -> (Data, URLResponse)
    {
        guard let authorization = await gateway.httpResourceAuthorization(ifCurrentRoute: route),
              authorization.url == connection.config.url
        else { throw CancellationError() }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/json, image/*", forHTTPHeaderField: "Accept")
        if url.scheme?.lowercased() == "https" {
            for (name, value) in GatewayCustomHeaders.sanitized(connection.customHeaders) {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }
        let tls = GatewayTLSParams(
            required: url.scheme == "https",
            expectedFingerprint: authorization.tlsFingerprint ?? connection.config.tls?.expectedFingerprint,
            allowTOFU: false,
            storeKey: connection.config.tls?.storeKey)
        let session = GatewayTLSPinningSession(
            params: tls, allowsRedirects: false, allowsStoredCredentials: false)
        defer { session.finishTasksAndInvalidate() }
        return try await OpenClawChatSourceResources.performAuthenticatedRequest(
            request, bearer: authorization.bearer)
        { request in
            guard await self.isCurrent(connection: connection, route: route) else {
                throw CancellationError()
            }
            let response = try await session.data(for: request, maximumBytes: maximumBytes)
            guard await self.isCurrent(connection: connection, route: route) else {
                throw CancellationError()
            }
            return response
        }
    }
}
