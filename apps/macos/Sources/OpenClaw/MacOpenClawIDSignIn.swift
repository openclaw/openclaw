import AppKit
import AuthenticationServices
import CryptoKit
import Foundation
import OpenClawKit

/// Where this build signs in and finds claws. The issuer and client id only authenticate the person
/// to Discovery; claw access always comes from an owner approval, the recovery kit or an invite.
struct MacOpenClawIDConfiguration: Equatable {
    static let callbackScheme = "ai.openclaw.mac"
    static let redirectURI = "ai.openclaw.mac:/oauth/callback"
    static let stagingIssuer = "https://openclaw-id-staging.services-91b.workers.dev/api/auth"
    static let stagingClientID = "DulSrXtaYtPaLEnzEyHGuAHpVNWmaNbf"
    static let stagingDiscovery = "https://openclaw-discovery-staging.services-91b.workers.dev"

    let issuer: URL
    let clientID: String
    let discoveryOrigin: URL

    /// Build config (`OpenClawIDIssuer`, `OpenClawIDClientID`, `OpenClawIDDiscoveryURL` in Info.plist)
    /// over the staging defaults. An empty client id means this build has no native sign-in.
    static func current(info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> Self? {
        let value = { (key: String, fallback: String) in (info[key] as? String) ?? fallback }
        let clientID = value("OpenClawIDClientID", Self.stagingClientID).trimmingCharacters(in: .whitespaces)
        guard !clientID.isEmpty,
              let issuer = URL(string: value("OpenClawIDIssuer", Self.stagingIssuer)), issuer.scheme == "https",
              let discovery = try? OpenClawIDNodeEnrollmentLink.discoveryOrigin(
                  value("OpenClawIDDiscoveryURL", Self.stagingDiscovery))
        else { return nil }
        return .init(issuer: issuer, clientID: clientID, discoveryOrigin: discovery)
    }
}

enum MacOpenClawIDSignInError: Error, Equatable {
    case cancelled, stateMismatch, issuerMismatch, refused, malformed
}

/// Native OpenClaw ID sign-in: ASWebAuthenticationSession with PKCE S256 and a state check against
/// the issuer's authorization endpoint. Returns the ID token, which is only exchanged for a
/// Discovery account session and never stored.
@MainActor
final class MacOpenClawIDSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let configuration: MacOpenClawIDConfiguration
    private let http: any OpenClawIDNodeEnrollmentHTTP
    private var session: ASWebAuthenticationSession?

    init(configuration: MacOpenClawIDConfiguration, http: any OpenClawIDNodeEnrollmentHTTP = OpenClawIDNodeEnrollmentURLSession()) {
        self.configuration = configuration
        self.http = http
    }

    func cancel() {
        self.session?.cancel()
        self.session = nil
    }

    func signIn() async throws -> String {
        let metadata = try await self.metadata()
        let verifier = Self.base64URL(Self.random(32))
        let state = Self.base64URL(Self.random(16))
        let nonce = Self.base64URL(Self.random(16))
        guard var url = URLComponents(url: metadata.authorization, resolvingAgainstBaseURL: false) else {
            throw MacOpenClawIDSignInError.malformed
        }
        url.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: self.configuration.clientID),
            .init(name: "redirect_uri", value: MacOpenClawIDConfiguration.redirectURI),
            .init(name: "scope", value: "openid profile email"),
            .init(name: "state", value: state),
            .init(name: "nonce", value: nonce),
            .init(name: "code_challenge", value: Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))),
            .init(name: "code_challenge_method", value: "S256"),
        ]
        guard let authorize = url.url else { throw MacOpenClawIDSignInError.malformed }
        let callback = try await self.authenticate(authorize)
        let code = try Self.code(from: callback, state: state, issuer: self.configuration.issuer)
        let idToken = try await self.exchange(code: code, verifier: verifier, endpoint: metadata.token)
        guard Self.nonce(of: idToken) == nonce else { throw MacOpenClawIDSignInError.stateMismatch }
        return idToken
    }

    /// Checks the callback's path, state and (RFC 9207) issuer, and returns the authorization code.
    static func code(from callback: URL, state: String, issuer: URL) throws -> String {
        guard let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              parts.scheme == MacOpenClawIDConfiguration.callbackScheme, parts.path == "/oauth/callback"
        else { throw MacOpenClawIDSignInError.malformed }
        let items = Dictionary((parts.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard items["state"] == state else { throw MacOpenClawIDSignInError.stateMismatch }
        if let iss = items["iss"], iss != issuer.absoluteString { throw MacOpenClawIDSignInError.issuerMismatch }
        if items["error"] != nil { throw MacOpenClawIDSignInError.refused }
        guard let code = items["code"], !code.isEmpty else { throw MacOpenClawIDSignInError.malformed }
        return code
    }

    /// The token's `nonce` claim, read without verification: Discovery verifies the token itself.
    static func nonce(of idToken: String) -> String? {
        let parts = idToken.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var text = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        guard let data = Data(base64Encoded: text),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return claims["nonce"] as? String
    }

    private func metadata() async throws -> (authorization: URL, token: URL) {
        struct Metadata: Decodable { let issuer: String
            let authorization_endpoint: URL
            let token_endpoint: URL
        }
        let issuer = self.configuration.issuer.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: issuer + "/.well-known/openid-configuration") else {
            throw MacOpenClawIDSignInError.malformed
        }
        let response = try await self.http.send(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        guard response.status == 200,
              let metadata = try? JSONDecoder().decode(Metadata.self, from: response.body)
        else { throw MacOpenClawIDSignInError.malformed }
        guard metadata.issuer == self.configuration.issuer.absoluteString,
              metadata.authorization_endpoint.scheme == "https", metadata.token_endpoint.scheme == "https",
              metadata.token_endpoint.host == self.configuration.issuer.host
        else { throw MacOpenClawIDSignInError.issuerMismatch }
        return (metadata.authorization_endpoint, metadata.token_endpoint)
    }

    private func authenticate(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url, callbackURLScheme: MacOpenClawIDConfiguration.callbackScheme)
            { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                    continuation.resume(throwing: MacOpenClawIDSignInError.cancelled)
                } else {
                    continuation.resume(throwing: MacOpenClawIDSignInError.refused)
                }
            }
            session.presentationContextProvider = self
            self.session = session
            guard session.start() else {
                self.session = nil
                continuation.resume(throwing: MacOpenClawIDSignInError.refused)
                return
            }
        }
    }

    private func exchange(code: String, verifier: String, endpoint: URL) async throws -> String {
        var form = URLComponents()
        form.queryItems = [
            .init(name: "grant_type", value: "authorization_code"),
            .init(name: "code", value: code),
            .init(name: "redirect_uri", value: MacOpenClawIDConfiguration.redirectURI),
            .init(name: "client_id", value: self.configuration.clientID),
            .init(name: "code_verifier", value: verifier),
        ]
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.httpBody = Data((form.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8)
        let response = try await self.http.send(request)
        struct Tokens: Decodable { let id_token: String? }
        guard response.status == 200, let token = try? JSONDecoder().decode(Tokens.self, from: response.body).id_token
        else { throw MacOpenClawIDSignInError.refused }
        return token
    }

    nonisolated func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor() }
    }

    private static func random(_ count: Int) -> Data {
        var bytes = Data(count: count)
        _ = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        return bytes
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
