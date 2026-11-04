import Foundation
import Sodium

/// Matches cloudflared's encrypted token transfer without persisting its ephemeral key pair.
struct CloudflareAccessTransfer: Sendable {
    let client: CloudflareAccessClient
    private let sleep: @Sendable (Duration) async throws -> Void

    init(
        client: CloudflareAccessClient = CloudflareAccessClient(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) })
    {
        self.client = client
        self.sleep = sleep
    }

    func signIn(
        application: CloudflareAccessApplication,
        openBrowser: @MainActor @Sendable (URL) async throws -> Void) async throws -> CloudflareAccessSession
    {
        let sodium = Sodium()
        var secretKey: [UInt8]
        let publicKey: String
        do {
            guard let keyPair = sodium.box.keyPair() else { throw CloudflareAccessError.loginFailed }
            secretKey = keyPair.secretKey
            publicKey = try Self.publicKey(keyPair.publicKey)
        }
        defer { sodium.utils.zero(&secretKey) }
        try Task.checkCancellation()
        try await openBrowser(Self.browserURL(application: application, publicKey: publicKey))

        let deadline = ContinuousClock.now.advanced(by: .seconds(300))
        var request = URLRequest(url: Self.transferURL(publicKey: publicKey))
        request.timeoutInterval = 60
        request.setValue(CloudflareAccessClient.userAgent, forHTTPHeaderField: "User-Agent")
        for _ in 0..<10 {
            try Task.checkCancellation()
            guard ContinuousClock.now < deadline else { throw CloudflareAccessError.timedOut }
            let (data, response) = try await self.client.request(request, 131_072)
            if response.statusCode == 200, !data.isEmpty {
                guard let peer = response.value(forHTTPHeaderField: "service-public-key") else {
                    throw CloudflareAccessError.loginFailed
                }
                let token = try Self.appToken(body: data, servicePublicKey: peer, secretKey: secretKey)
                try Task.checkCancellation()
                return try await self.client.verifiedSession(token: token, application: application)
            }
            // The transfer service long-polls while the browser is open. Never
            // follow a redirect or open another browser for a pending transfer.
            guard response.statusCode < 300 || (400..<500).contains(response.statusCode) else {
                throw CloudflareAccessError.loginFailed
            }
            try await self.sleep(.seconds(1))
        }
        throw CloudflareAccessError.timedOut
    }

    static func browserURL(application: CloudflareAccessApplication, publicKey: String) throws -> URL {
        guard var components = URLComponents(url: application.origin.url, resolvingAgainstBaseURL: false) else {
            throw CloudflareAccessError.invalidApplication
        }
        components.queryItems = [
            URLQueryItem(name: "token", value: publicKey),
            URLQueryItem(name: "aud", value: application.audience),
        ]
        guard let redirect = components.url else { throw CloudflareAccessError.invalidApplication }
        components.path = "/cdn-cgi/access/cli"
        components.queryItems?.append(contentsOf: [
            URLQueryItem(name: "redirect_url", value: redirect.absoluteString),
            URLQueryItem(name: "send_org_token", value: "true"),
            URLQueryItem(name: "edge_token_transfer", value: "true"),
            URLQueryItem(name: "close_interstitial", value: "true"),
        ])
        guard let url = components.url else { throw CloudflareAccessError.invalidApplication }
        return url
    }

    static func transferURL(publicKey: String) -> URL {
        URL(string: "https://login.cloudflareaccess.org/transfer/")!.appendingPathComponent(publicKey)
    }

    static func publicKey(_ bytes: [UInt8]) throws -> String {
        guard bytes.count == 32, let encoded = Sodium().utils.bin2base64(bytes, variant: .URLSAFE) else {
            throw CloudflareAccessError.loginFailed
        }
        return encoded
    }

    static func appToken(body: Data, servicePublicKey: String, secretKey: [UInt8]) throws -> String {
        let sodium = Sodium()
        // These are deliberately different alphabets: cloudflared uses padded
        // base64url for keys, but standard padded base64 for the HTTP body.
        guard body.count <= 131_072, servicePublicKey.utf8.count == 44, secretKey.count == 32,
              let encodedBody = String(data: body, encoding: .utf8),
              self.isBase64(encodedBody, urlSafe: false), self.isBase64(servicePublicKey, urlSafe: true),
              let envelope = sodium.utils.base642bin(encodedBody, variant: .ORIGINAL),
              envelope.count >= 40,
              let peer = sodium.utils.base642bin(servicePublicKey, variant: .URLSAFE), peer.count == 32,
              var plaintext = sodium.box.open(
                  nonceAndAuthenticatedCipherText: envelope,
                  senderPublicKey: peer,
                  recipientSecretKey: secretKey)
        else { throw CloudflareAccessError.loginFailed }
        defer { sodium.utils.zero(&plaintext) }
        struct Payload: Decodable {
            let appToken: String

            enum CodingKeys: String, CodingKey {
                case appToken = "app_token"
            }
        }
        guard let payload = try? JSONDecoder().decode(Payload.self, from: Data(plaintext)),
              !payload.appToken.isEmpty, payload.appToken.utf8.count <= 32768
        else { throw CloudflareAccessError.loginFailed }
        // The org token is intentionally never decoded or retained. The app
        // token still requires signature, audience and identity verification.
        return payload.appToken
    }

    private static func isBase64(_ value: String, urlSafe: Bool) -> Bool {
        // Swift Sodium converts UTF-8 bytes with Int8.init before decoding.
        // Admit only the wire alphabet so hostile Unicode cannot trap there.
        value.utf8.allSatisfy { byte in
            switch byte {
            case 65...90, 97...122, 48...57, 61: true
            case 45, 95: urlSafe
            case 43, 47: !urlSafe
            default: false
            }
        }
    }
}
