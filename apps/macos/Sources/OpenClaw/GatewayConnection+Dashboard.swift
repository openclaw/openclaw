import Foundation

extension GatewayConnection {
    /// The authenticated hello owns browser sign-in discovery; no admin-only
    /// config read or endpoint guess may substitute for that server's identity.
    func controlUiBrowserIdentityURL(config: Config) async throws -> URL? {
        var capturedLease = await self.captureServerLease()
        if capturedLease == nil {
            let route = try await self.captureRequiredRoute()
            guard route.matches(config: config) else { throw CancellationError() }
            // Discover on a fresh connection before binding browser authentication
            // to a route. This read-only preflight owns ordinary TLS renewal; route-
            // and socket-bound mutations must never gain recovery or retargeting.
            let lease = try await self.acquireServerLease(
                timeoutMs: 15000, retryTransportFailures: false, preflightRoute: route)
            guard lease.route.matches(config: config),
                  lease.route.authority == route.authority,
                  lease.route.deviceAuthGatewayID == route.deviceAuthGatewayID,
                  lease.route.browserSession == route.browserSession,
                  GatewayTLSRoute.hasSameTrustPolicy(lease.route.tls, route.tls)
            else { throw CancellationError() }
            capturedLease = lease
        }
        guard let lease = capturedLease,
              lease.route.matches(config: config),
              await self.isCurrentServerLease(lease)
        else { throw CancellationError() }
        guard let advertised = self.lastSnapshot?.snapshot.controluiidentityurl else { return nil }
        guard let components = URLComponents(string: advertised),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              let url = components.url
        else { throw URLError(.badURL) }
        return url
    }
}
