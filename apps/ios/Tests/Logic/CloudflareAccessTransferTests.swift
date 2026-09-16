import Foundation
import Testing

struct CloudflareAccessTransferTests {
    // Produced by Go 1.26.4, golang.org/x/crypto/nacl/box v0.53.0, matching
    // cloudflared fe70e951a3c52d92abf9f6c4248e32937b2f42fc. All keys are test-only.
    private let secret = Array(UInt8(0)...UInt8(31))
    private let peer = "eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRo="
    private let body = "4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3mUfpSI3NujJScq2SSYTNjPQHWD/4rcDtGZ4aXmZQQKiucDTkbzLbxWfGKrd5AcTTDtoyjAmnEygNkAiq9mC4Ma37GxgCkQhrX0liw7+6uoTpq9n5Rg=="

    @Test func `decrypts the Go transfer fixture with distinct base64 alphabets`() throws {
        let token = try CloudflareAccessTransfer.appToken(
            body: Data(self.body.utf8), servicePublicKey: self.peer, secretKey: self.secret)
        #expect(token == "test-only-app-token")
        #expect(throws: CloudflareAccessError.self) {
            try CloudflareAccessJWT.appClaims(token, application: CloudflareAccessTestTokens.application())
        }
    }

    @MainActor
    @Test func `every browser attempt gets a fresh key and cancellation stops polling`() async throws {
        var urls: [URL] = []
        let application = try CloudflareAccessTestTokens.application()
        let transfer = CloudflareAccessTransfer(client: CloudflareAccessClient(request: { _, _ in
            Issue.record("A cancelled browser must not start a transfer request")
            throw CloudflareAccessError.connectionFailed
        }))
        for _ in 0..<2 {
            await #expect(throws: CancellationError.self) {
                try await transfer.signIn(application: application, openBrowser: { url in
                    urls.append(url)
                    throw CancellationError()
                })
            }
        }
        #expect(urls.count == 2)
        #expect(urls[0] != urls[1])
    }

    @Test(arguments: [0, 24, 108])
    func `rejects nonce MAC and ciphertext tampering`(index: Int) throws {
        var data = try #require(Data(base64Encoded: self.body))
        data[index] ^= 1
        #expect(throws: CloudflareAccessError.self) {
            try CloudflareAccessTransfer.appToken(
                body: Data(data.base64EncodedString().utf8), servicePublicKey: self.peer, secretKey: self.secret)
        }
    }

    @Test func `rejects truncation wrong peer and mixed encoding`() throws {
        let data = try #require(Data(base64Encoded: self.body))
        let cases: [(String, String)] = [
            (data.dropLast().base64EncodedString(), self.peer),
            (self.body, "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8="),
            ("invalid", self.peer),
            (Data(repeating: 0, count: 39).base64EncodedString(), self.peer),
            (self.body, String(self.peer.dropLast())),
            (self.body, self.peer.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")),
            (self.body.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_"), self.peer),
        ]
        for (body, peer) in cases {
            #expect(throws: CloudflareAccessError.self) {
                try CloudflareAccessTransfer.appToken(
                    body: Data(body.utf8),
                    servicePublicKey: peer,
                    secretKey: self.secret)
            }
        }
    }

    @Test(arguments: [
        "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3tnpip9KPq9XQpBI5GjPt0k4=",
        "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaX4yew9i53b9+4rxh5Ix7UWTihTHI/Vzb1WO5a6ObFvXw7ZG9HhfL+6JQZgxuOPpv/heDdWETPVFwnFCVEpX6KUrs=",
        "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3udaJ6+8j8qaBZ7chKhIfXXKQgJRQ6OV5HOolnKdfDc/aXVQJ1Ra+UQCWuNZQcQ5PFktF",
    ])
    func `rejects authenticated malformed transfer payloads`(body: String) {
        #expect(throws: CloudflareAccessError.self) {
            try CloudflareAccessTransfer.appToken(
                body: Data(body.utf8),
                servicePublicKey: "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=",
                secretKey: self.secret)
        }
    }

    @Test(arguments: ["é", "☃", "🦊"])
    func `rejects Unicode before the dependency decoder`(unicode: String) {
        #expect(throws: CloudflareAccessError.self) {
            try CloudflareAccessTransfer.appToken(
                body: Data((unicode + self.body).utf8), servicePublicKey: self.peer, secretKey: self.secret)
        }
        let peer = String(self.peer.dropLast(unicode.utf8.count)) + unicode
        #expect(peer.utf8.count == 44)
        #expect(throws: CloudflareAccessError.self) {
            try CloudflareAccessTransfer.appToken(
                body: Data(self.body.utf8), servicePublicKey: peer, secretKey: self.secret)
        }
    }

    @Test func `browser URL uses the pinned encrypted transfer contract`() throws {
        let application = try CloudflareAccessTestTokens.application()
        let publicKey = "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8="
        let url = try CloudflareAccessTransfer.browserURL(application: application, publicKey: publicKey)
        #expect(application.origin.contains(url))
        #expect(url.path == "/cdn-cgi/access/cli")
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })
        #expect(query["token"] == publicKey)
        #expect(query["aud"] == application.audience)
        #expect(query["send_org_token"] == "true")
        #expect(query["edge_token_transfer"] == "true")
        #expect(query["close_interstitial"] == "true")
        let redirectString = try #require(query["redirect_url"] ?? nil)
        let redirect = try #require(URL(string: redirectString))
        #expect(application.origin.contains(redirect))
        #expect(CloudflareAccessTransfer.transferURL(publicKey: publicKey).host == "login.cloudflareaccess.org")
    }
}
