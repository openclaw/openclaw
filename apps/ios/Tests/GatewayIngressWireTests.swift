import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
private final class IngressWireFixture {
    let server: NativeGatewayWebSocketFixture
    let tokens: CloudflareAccessTestTokens
    let application: CloudflareAccessApplication
    let metadata: String
    let stableID: String
    var session: CloudflareAccessSession
    var acceptedToken: String
    var stored: String?
    var rows: [GatewaySettingsStore.GatewayRegistryEntry]
    var holdProbes = false
    var holdMedia = false
    var redirect: URL?

    init(server: NativeGatewayWebSocketFixture) throws {
        self.server = server
        self.tokens = try CloudflareAccessTestTokens()
        self.application = try CloudflareAccessApplication(
            origin: CloudflareAccessOrigin(server.url()),
            issuer: #require(URL(string: "https://example.cloudflareaccess.com")),
            audience: "wire-fixture")
        self.metadata = try self.tokens.token([
            "type": "match", "hostname": "127.0.0.1",
            "auth_domain": "example.cloudflareaccess.com", "aud": self.application.audience,
            "iat": Date().timeIntervalSince1970,
        ])
        self.stableID = "manual|127.0.0.1|\(server.port)"
        let expiresAt = Date().addingTimeInterval(3600)
        self.acceptedToken = try self.tokens.token([
            "iss": self.application.issuer.absoluteString, "aud": [self.application.audience],
            "type": "app", "sub": "wire-first", "exp": expiresAt.timeIntervalSince1970,
        ])
        self.session = CloudflareAccessSession(
            application: self.application,
            subject: "wire-first",
            token: self.acceptedToken,
            expiresAt: expiresAt)
        self.stored = try String(
            data: JSONEncoder().encode(self.session),
            encoding: .utf8)
        self.rows = [.init(
            stableID: self.stableID,
            kind: .manual,
            name: "Wire fixture",
            host: "127.0.0.1",
            port: Int(server.port),
            useTLS: true,
            lastConnectedAtMs: nil)]
        server.httpResponse = { [weak self] request in self?.respond(request) ?? .init(status: 404) }
    }

    var route: GatewayIngressController.Route {
        .init(
            url: self.server.url(),
            stableID: self.stableID,
            tls: self.tls)
    }

    var tls: GatewayTLSParams {
        .init(
            required: true,
            expectedFingerprint: self.server.fingerprint,
            allowTOFU: false,
            storeKey: nil)
    }

    func controller(
        retire: @escaping @MainActor (CloudflareAccessOrigin) async -> Void = { _ in }) -> GatewayIngressController
    {
        let jwks = self.tokens.jwks
        let issuer = self.application.issuer
        return GatewayIngressController(
            persistence: .init(
                load: { _ in self.stored },
                save: { _, value in self.stored = value
                    return true
                },
                delete: { _ in self.stored = nil
                    return true
                }),
            browser: IngressTestBrowser(),
            authenticate: { _, _ in self.session },
            requestFactory: { route in
                let transport = GatewayIngressController.request(for: route)
                return { request, maximumBytes in
                    // Only the external issuer is synthetic. Gateway discovery uses real pinned TLS.
                    if let url = request.url, url.host == issuer.host {
                        let response = try #require(HTTPURLResponse(
                            url: url,
                            statusCode: 200,
                            httpVersion: nil,
                            headerFields: nil))
                        return (jwks, response)
                    }
                    return try await transport(request, maximumBytes)
                }
            },
            customHeaders: { _ in ["X-Existing-Ingress": "preserved"] },
            profiles: { self.rows },
            saveProfileOrigin: { _, origin in self.rows[0].accessOrigin = origin
                return true
            },
            retireTransports: retire)
    }

    func config(
        _ authorization: GatewayIngressAuthorization,
        url: URL? = nil) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url ?? self.server.url(),
            stableID: self.stableID,
            tls: self.tls,
            token: "gateway-pairing-token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: "Wire fixture",
                includeDeviceIdentity: false,
                allowStoredDeviceAuth: false),
            ingressAuthorization: authorization)
    }

    func loader(_ config: GatewayConnectConfig) -> IOSMediaArtifactLoader {
        IOSMediaArtifactLoader(connectionProvider: {
            .init(
                config: config,
                gatewayID: config.effectiveStableID,
                customHeaders: [:])
        })
    }

    func replaceAccount() throws {
        let expiresAt = Date().addingTimeInterval(3600)
        self.acceptedToken = try self.tokens.token([
            "iss": self.application.issuer.absoluteString, "aud": [self.application.audience],
            "type": "app", "sub": "wire-replacement", "exp": expiresAt.timeIntervalSince1970,
        ])
        self.session = CloudflareAccessSession(
            application: self.application,
            subject: "wire-replacement",
            token: self.acceptedToken,
            expiresAt: expiresAt)
    }

    private func respond(_ request: NativeGatewayWebSocketFixture.Request)
        -> NativeGatewayWebSocketFixture.HTTPResponse
    {
        if request.method == "HEAD" {
            return .init(headers: ["Cf-Access-Metadata": self.metadata])
        }
        if request.target.hasPrefix("/api/chat/media/") {
            if let redirect { return .init(
                status: 302,
                headers: ["Location": redirect.absoluteString]) }
            return .init(
                headers: ["Content-Type": "image/png"],
                body: Data([1, 2, 3]),
                holdBody: self.holdMedia)
        }
        if request.headers["cf-access-token"] == self.acceptedToken {
            return .init(holdHeaders: self.holdProbes)
        }
        return .init(
            status: 302,
            headers: [
                "WWW-Authenticate": "Cloudflare-Access resource_metadata=\"" +
                    self.application.origin.url
                    .absoluteString + "/.well-known/cloudflare-access-protected-resource/\"",
            ])
    }

    func close(
        _ ingress: GatewayIngressController,
        model: NodeAppModel? = nil,
        fleet: GatewayOperatorFleet? = nil) async
    {
        self.holdProbes = false
        self.server.releaseHTTPResponses()
        self.server.stop()
        do { try await ingress.forget(stableID: self.stableID) } catch { Issue.record(error) }
        model?.disconnectGateway()
        await model?.waitForGatewaySessionResetIfNeeded()
        await fleet?.retire(origin: self.application.origin)
    }

    static var media: ArtifactsDownloadResult {
        ArtifactsDownloadResult(
            artifact: ArtifactSummary(
                id: "wire-artifact",
                type: "media",
                title: "Fixture",
                mimetype: "image/png",
                sizebytes: 3,
                download: ["mode": AnyCodable("url")]),
            encoding: nil,
            data: nil,
            url: "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full?mediaTicket=fixture")
    }
}

@MainActor
private func expectRetiredIngress(_ result: Result<some Any, Error>) {
    guard case let .failure(error) = result else {
        Issue.record("Retired ingress operation succeeded")
        return
    }
    #expect(error is CancellationError || error is GatewayExternalAuthorizationError ||
        (error as? URLError)?.code == .cancelled)
}

extension GatewayIngressControllerTests {
    @Test @MainActor
    func `managed to ordinary native reconnect restores Share metadata without sharing Access auth`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "share-ingress-\(UUID().uuidString)")
        defer { state.restore() }
        let server = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [], tls: true)
        defer { server.stop() }
        let fixture = try IngressWireFixture(server: server)
        let previousAgent = GatewaySettingsStore.loadGatewaySelectedAgentId(stableID: fixture.stableID)
        defer { GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: fixture.stableID, agentId: previousAgent) }
        let model = NodeAppModel()
        let ingress = fixture.controller { origin in await model.retireGatewayIngress(for: origin) }
        let defaults = try #require(UserDefaults(suiteName: OpenClawAppGroup.identifier))
        do {
            let authorization = try #require(await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint()))
            var options = fixture.config(authorization).nodeOptions
            options.deviceAuthGatewayID = fixture.stableID
            func config(_ authorization: GatewayIngressAuthorization?) -> GatewayConnectConfig {
                GatewayConnectConfig(
                    url: server.url(),
                    stableID: fixture.stableID,
                    tls: fixture.tls,
                    token: "share-pairing-token",
                    bootstrapToken: nil,
                    password: "share-pairing-password",
                    nodeOptions: options,
                    ingressAuthorization: authorization)
            }
            model.applyGatewayConnectConfig(config(authorization))
            try await waitForIngress {
                model.gatewayConnected && ShareGatewayRelaySettings.loadConfig()?.requiresForegroundSignIn == true
            }
            let managed = try #require(ShareGatewayRelaySettings.loadConfigDiscardingUnscopedDeviceAuth())
            #expect(managed.gatewayStableID == fixture.stableID)
            #expect(managed.token == nil)
            #expect(managed.password == nil)
            #expect(server.roles.contains("node"))
            #expect(server.requests
                .contains { $0.isWebSocket && $0.headers["cf-access-token"] == fixture.acceptedToken })
            #expect(GenericPasswordKeychainStore.loadString(
                service: "ai.openclawfoundation.app.share-gateway-relay",
                account: "credentials.v1",
                accessGroup: OpenClawAppGroup.identifier) == nil)
            let managedMetadata = try #require(defaults.data(forKey: "share.gatewayRelay.config.v1"))
            for secret in [fixture.acceptedToken, "share-pairing-token", "share-pairing-password"] {
                #expect(managedMetadata.range(of: Data(secret.utf8)) == nil)
            }
            model.setSelectedAgentId("share-agent-\(UUID().uuidString.lowercased())")
            let selected = try #require(ShareGatewayRelaySettings.loadConfig())
            #expect(selected.sessionKey != managed.sessionKey)
            #expect(selected.sessionKey == model.mainSessionKey)
            #expect(selected.requiresForegroundSignIn == true)
            #expect(selected.token == nil)
            #expect(selected.password == nil)

            model.disconnectGateway()
            await model.waitForGatewaySessionResetIfNeeded()
            // The same host now admits ordinary requests, such as through existing service headers or WARP.
            server.httpResponse = { _ in .init() }
            let ordinary = try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            #expect(ordinary == nil)
            let before = server.requests.count
            model.applyGatewayConnectConfig(config(ordinary))
            try await waitForIngress {
                model.gatewayConnected && ShareGatewayRelaySettings.loadConfig()?.requiresForegroundSignIn == false
            }
            let restored = try #require(ShareGatewayRelaySettings.loadConfigDiscardingUnscopedDeviceAuth())
            #expect(restored.gatewayStableID == fixture.stableID)
            #expect(restored.gatewayURLString == server.url().absoluteString)
            #expect(restored.token == "share-pairing-token")
            #expect(restored.password == "share-pairing-password")
            let upgrades = server.requests.dropFirst(before).filter(\.isWebSocket)
            #expect(!upgrades.isEmpty)
            #expect(upgrades.allSatisfy { $0.headers["cf-access-token"] == nil })
            let metadata = try #require(defaults.data(forKey: "share.gatewayRelay.config.v1"))
            for secret in [fixture.acceptedToken, "share-pairing-token", "share-pairing-password"] {
                #expect(metadata.range(of: Data(secret.utf8)) == nil)
            }
        } catch {
            await fixture.close(ingress, model: model)
            throw error
        }
        await fixture.close(ingress, model: model)
    }

    @Test @MainActor
    func `pinned native sockets and media use the live grant and sign out joins a held response`() async throws {
        let isolation = GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "wire-ingress-\(UUID().uuidString)")
        defer { state.restore() }
        let server = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [], tls: true)
        defer { server.stop() }
        let fixture = try IngressWireFixture(server: server)
        let model = NodeAppModel()
        let fleet = GatewayOperatorFleet()
        let ingress = fixture.controller { origin in
            await model.retireGatewayIngress(for: origin)
            await fleet.retire(origin: origin)
        }
        var pending: Task<OpenClawChatLoadedMedia, Error>?
        var retirement: Task<Void, Never>?
        do {
            let prepared = try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            let authorization = try #require(prepared)
            let config = fixture.config(authorization)
            model.applyGatewayConnectConfig(config)
            fleet.reconcile(desiredStableIDs: [config.stableID], configs: [config])
            try await waitForIngress {
                server.roles.contains("node") && server.roles.filter { $0 == "operator" }.count == 2
            }
            let loader = fixture.loader(config)
            let loaded = try await loader.load(
                response: IngressWireFixture.media, kind: .image, expectedGatewayID: config.effectiveStableID)
            guard case let .data(media) = loaded else {
                try #require(false, "Expected downloaded media")
                return
            }
            #expect(media.data == Data([1, 2, 3]))
            let protected = server.requests.filter { $0.isWebSocket || $0.target.hasPrefix("/api/chat/media/") }
            #expect(protected.count == 4)
            for request in protected {
                #expect(request.headers["cf-access-token"] == fixture.acceptedToken)
                #expect(request.headers["x-existing-ingress"] == "preserved")
                #expect(request.headers["authorization"] == nil)
                #expect(request.headers["cookie"] == nil)
            }
            for index in 0..<3 {
                #expect(server.capturedAuth(at: index)?.token == "gateway-pairing-token")
            }

            fixture.holdMedia = true
            var mediaFinished = false
            let held = Task {
                defer { mediaFinished = true }
                return try await loader.load(
                    response: IngressWireFixture.media, kind: .image, expectedGatewayID: config.effectiveStableID)
            }
            pending = held
            try await waitForIngress { server.requests.filter { $0.target.hasPrefix("/api/chat/media/") }.count == 2 }
            var retirementFinished = false
            retirement = Task {
                await ingress.signOut(stableID: config.stableID)
                retirementFinished = true
            }
            try await waitForIngress { retirementFinished && mediaFinished }
            await expectRetiredIngress(held.result)
            try await waitForIngress { server.activeConnectionCount == 0 }
            #expect(fixture.stored == nil)
            #expect(fleet._test_runtimeStableIDs().isEmpty)
            let count = server.requests.count
            await #expect(throws: GatewayExternalAuthorizationError.self) {
                try await loader.load(
                    response: IngressWireFixture.media, kind: .image, expectedGatewayID: config.effectiveStableID)
            }
            #expect(server.requests.count == count)
        } catch {
            pending?.cancel()
            await fixture.close(ingress, model: model, fleet: fleet)
            _ = await pending?.result
            await retirement?.value
            throw error
        }
        await fixture.close(ingress, model: model, fleet: fleet)
        _ = await pending?.result
        await retirement?.value
    }

    @Test(arguments: ["signOut", "forget", "replaceAccount"]) @MainActor
    func `held TLS probes cannot admit socket or media work after retirement`(action: String) async throws {
        let server = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [], tls: true)
        defer { server.stop() }
        let fixture = try IngressWireFixture(server: server)
        let ingress = fixture.controller()
        let gateway = GatewayNodeSession()
        var socket: Task<Void, Error>?
        var media: Task<OpenClawChatLoadedMedia, Error>?
        do {
            let prepared = try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            let authorization = try #require(prepared)
            let config = fixture.config(authorization)
            let loader = fixture.loader(config)
            fixture.holdProbes = true
            let initial = server.requests.count
            var socketFinished = false
            var mediaFinished = false
            let pendingSocket = Task {
                defer { socketFinished = true }
                try await gateway.connect(
                    url: config.url,
                    credentials: .init(token: config.token),
                    connectOptions: config.nodeOptions,
                    sessionBox: config.webSocketSessionBox(),
                    extraHeadersProvider: { try await authorization.headers(config.url) },
                    onConnected: {},
                    onDisconnected: { _ in },
                    onInvoke: { .init(id: $0.id, ok: true) })
            }
            socket = pendingSocket
            let pendingMedia = Task {
                defer { mediaFinished = true }
                return try await loader.load(
                    response: IngressWireFixture.media, kind: .image, expectedGatewayID: config.effectiveStableID)
            }
            media = pendingMedia
            try await waitForIngress { server.requests.count == initial + 2 }
            switch action {
            case "forget": try await ingress.forget(stableID: fixture.stableID)
            case "replaceAccount":
                fixture.holdProbes = false
                try fixture.replaceAccount()
                let preparedReplacement = try await ingress.prepare(
                    route: fixture.route, userInitiated: true, admissionCheckpoint: ingress.admissionCheckpoint())
                let replacement = try #require(preparedReplacement)
                #expect(replacement.revision != authorization.revision)
            default: await ingress.signOut(stableID: fixture.stableID)
            }
            fixture.holdProbes = false
            server.releaseHTTPResponses()
            try await waitForIngress { socketFinished && mediaFinished }
            await expectRetiredIngress(pendingSocket.result)
            await expectRetiredIngress(pendingMedia.result)
            await gateway.disconnect()
            #expect(server.requests.allSatisfy { !$0.isWebSocket && !$0.target.hasPrefix("/api/chat/media/") })
        } catch {
            socket?.cancel()
            media?.cancel()
            await fixture.close(ingress)
            await gateway.disconnect()
            _ = await socket?.result
            _ = await media?.result
            throw error
        }
        await fixture.close(ingress)
        await gateway.disconnect()
        _ = await socket?.result
        _ = await media?.result
    }

    @Test @MainActor
    func `native media rejects a foreign TLS authority and never follows its redirect`() async throws {
        let server = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [], tls: true)
        defer { server.stop() }
        let foreign = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [], tls: true)
        defer { foreign.stop() }
        let fixture = try IngressWireFixture(server: server)
        let ingress = fixture.controller()
        do {
            let prepared = try await ingress.prepare(
                route: fixture.route, userInitiated: false, admissionCheckpoint: ingress.admissionCheckpoint())
            let authorization = try #require(prepared)
            let foreignConfig = fixture.config(authorization, url: foreign.url())
            await #expect(throws: CloudflareAccessError.invalidGateway) {
                try await fixture.loader(foreignConfig).load(
                    response: IngressWireFixture.media,
                    kind: .image,
                    expectedGatewayID: foreignConfig.effectiveStableID)
            }
            fixture.redirect = try CloudflareAccessOrigin(foreign.url()).url.appendingPathComponent("media")
            let config = fixture.config(authorization)
            await #expect(throws: IOSMediaArtifactLoader.LoadError.requestFailed(statusCode: 302)) {
                try await fixture.loader(config).load(
                    response: IngressWireFixture.media, kind: .image, expectedGatewayID: config.effectiveStableID)
            }
            #expect(foreign.requests.isEmpty)
            #expect(foreign.activeConnectionCount == 0)
        } catch {
            await fixture.close(ingress)
            throw error
        }
        await fixture.close(ingress)
    }
}
