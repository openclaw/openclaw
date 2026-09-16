import Foundation

struct CloudflareAccessClient: Sendable {
    typealias Request = @Sendable (URLRequest, Int) async throws -> (Data, HTTPURLResponse)

    let request: Request

    init(request: @escaping Request = Self.send) {
        self.request = request
    }

    /// Check ordinary ingress first: the metadata endpoint returns 200 even before authentication.
    func discover(
        gatewayURL: URL,
        session: CloudflareAccessSession? = nil,
        customHeaders: [String: String] = [:]) async throws
        -> CloudflareAccessApplication?
    {
        let origin = try CloudflareAccessOrigin(gatewayURL)
        guard var components = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false) else {
            throw CloudflareAccessError.invalidGateway
        }
        components.scheme = "https"
        if components.path.isEmpty {
            components.path = "/"
        }
        guard let url = components.url else { throw CloudflareAccessError.invalidGateway }
        var probe = URLRequest(url: url)
        for (name, value) in customHeaders {
            probe.setValue(value, forHTTPHeaderField: name)
        }
        if let token = session?.authorizationHeader(for: url) {
            probe.setValue(token, forHTTPHeaderField: "Cf-Access-Token")
        }
        let (_, response) = try await self.request(probe, 0)
        guard Self.isChallenge(response, origin: origin) else { return nil }

        var metadataRequest = URLRequest(url: url)
        metadataRequest.httpMethod = "HEAD"
        metadataRequest.setValue("true", forHTTPHeaderField: "Cf-Access-Metadata-Request")
        metadataRequest.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        let (_, metadataResponse) = try await self.request(metadataRequest, 0)
        guard metadataResponse.statusCode == 200,
              let token = metadataResponse.value(forHTTPHeaderField: "Cf-Access-Metadata")
        else {
            throw CloudflareAccessError.invalidApplication
        }
        do {
            // Only a constrained Cloudflare issuer can supply the key. The signature then
            // authenticates the hostname and audience before any browser or credential use.
            let metadata = try CloudflareAccessJWT.decode(CloudflareAccessJWT.Metadata.self, token: token)
            let application = try CloudflareAccessJWT.application(metadata: metadata, origin: origin)
            try await CloudflareAccessJWT.verify(token, jwks: self.keys(for: application))
            return application
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw CloudflareAccessError.invalidApplication
        }
    }

    static func isChallenge(_ response: HTTPURLResponse, origin: CloudflareAccessOrigin) -> Bool {
        guard [301, 302, 303, 307, 308, 401, 403].contains(response.statusCode),
              let responseURL = response.url, origin.contains(responseURL),
              let header = response.value(forHTTPHeaderField: "WWW-Authenticate"), header.utf8.count <= 8192
        else { return false }
        let parts = header.split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
        guard parts.count == 2, ["cloudflare-access", "bearer"].contains(parts[0].lowercased()),
              let expression = try? NSRegularExpression(pattern: #"(?:^|[,\s])resource_metadata\s*=\s*"([^"]+)""#),
              let match = expression.firstMatch(
                  in: String(parts[1]),
                  range: NSRange(parts[1].startIndex..., in: parts[1])),
              let range = Range(match.range(at: 1), in: parts[1]),
              let metadataURL = URL(string: String(parts[1][range])),
              metadataURL.scheme?.lowercased() == "https", origin.contains(metadataURL), metadataURL.query == nil
        else { return false }
        // RFC 9728 puts resource paths after the namespace. This is only a
        // challenge hint; signed metadata is still requested from the original URL.
        let namespace = "/.well-known/cloudflare-access-protected-resource"
        return metadataURL.path == namespace || metadataURL.path.hasPrefix(namespace + "/")
    }

    func verifiedSession(token: String, application: CloudflareAccessApplication) async throws
        -> CloudflareAccessSession
    {
        try await CloudflareAccessJWT.verify(token, jwks: self.keys(for: application))
        let claims = try CloudflareAccessJWT.appClaims(token, application: application)
        var identityRequest = URLRequest(url: application.origin.url
            .appendingPathComponent("cdn-cgi/access/get-identity"))
        // Access's identity endpoint consumes its session cookie. This one request
        // has no cookie jar or redirects; native Gateway traffic uses Cf-Access-Token.
        identityRequest.setValue("CF_Authorization=\(token)", forHTTPHeaderField: "Cookie")
        let (data, response) = try await self.request(identityRequest, Self.maximumResponseBytes)
        struct Identity: Decodable {
            let userUUID: String

            enum CodingKeys: String, CodingKey {
                case userUUID = "user_uuid"
            }
        }
        guard response.statusCode == 200,
              let identity = try? JSONDecoder().decode(Identity.self, from: data),
              identity.userUUID == claims.sub
        else { throw CloudflareAccessError.invalidSession }
        try Task.checkCancellation()
        return CloudflareAccessSession(
            application: application,
            subject: claims.sub,
            token: token,
            expiresAt: Date(timeIntervalSince1970: claims.exp))
    }

    private func keys(for application: CloudflareAccessApplication) async throws -> Data {
        guard let host = application.issuer.host,
              try CloudflareAccessJWT.issuer(authDomain: host) == application.issuer
        else { throw CloudflareAccessError.invalidApplication }
        let request = URLRequest(url: application.issuer.appendingPathComponent("cdn-cgi/access/certs"))
        let (data, response) = try await self.request(request, Self.maximumResponseBytes)
        guard response.statusCode == 200 else { throw CloudflareAccessError.invalidApplication }
        return data
    }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void)
        {
            completionHandler(nil)
        }
    }

    static let userAgent = "OpenClaw CloudflareAccess (cloudflared/2026.8.3)"
    static let maximumResponseBytes = 1_048_576

    static func send(_ request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = max(30, request.timeoutInterval)
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse, response.url == request.url else {
                throw CloudflareAccessError.connectionFailed
            }
            var data = Data()
            if maximumBytes > 0 {
                for try await byte in bytes {
                    guard data.count < maximumBytes else { throw CloudflareAccessError.connectionFailed }
                    data.append(byte)
                }
            }
            return (data, response)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw CloudflareAccessError.connectionFailed
        }
    }
}
