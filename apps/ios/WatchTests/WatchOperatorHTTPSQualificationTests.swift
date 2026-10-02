import CryptoKit
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit
@testable import OpenClawWatchApp

private enum QualificationError: Error {
    case input, persistence, result
}

private struct QualificationInput: Decodable {
    let run: String
    let phase: String
    let nonce: String
    let expiresAt: Double
    let endpoint: URL?
    let gatewayID: String?
    let deviceID: String?
    let token: String?
    let replacementToken: String?
    let controlToken: String?
}

private actor QualificationConnection {
    private var closed = false
    func didClose() {
        self.closed = true
    }

    func requireOpen() throws {
        guard !self.closed else { throw QualificationError.result }
    }
}

private final class QualificationControlDelegate: NSObject, URLSessionDelegate {
    private let invalidation = AsyncStream<Void>.makeStream()

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: (any Error)?) {
        self.invalidation.continuation.finish()
    }

    func close(_ session: URLSession) async {
        session.finishTasksAndInvalidate()
        // A cancelled phase must still join the final URLSession delegate callback.
        let stream = self.invalidation.stream
        await Task.detached {
            for await _ in stream {}
        }.value
    }
}

/// Inputs are a private app-container contract, never launch arguments, defaults, or product flags.
@Suite(.serialized)
@MainActor
struct WatchOperatorHTTPSQualificationTests {
    private nonisolated static let scopes = ["operator.read", "operator.talk"]
    private static var directory: URL {
        URL.cachesDirectory.appendingPathComponent("OpenClawQualification", isDirectory: true)
    }

    @Test(.enabled(if: FileManager.default.fileExists(
        atPath: URL.cachesDirectory.appendingPathComponent("OpenClawQualification/input.json").path)))
    func qualification() async throws {
        let file = Self.directory.appendingPathComponent("input.json")
        let bytes = try Self.readPrivate(file)
        let input = try JSONDecoder().decode(QualificationInput.self, from: bytes)
        guard UUID(uuidString: input.run) != nil, UUID(uuidString: input.nonce) != nil,
              ["identity", "negative", "positive", "voice"].contains(input.phase),
              input.expiresAt > Date().timeIntervalSince1970,
              input.expiresAt <= Date().timeIntervalSince1970 + 180
        else { throw QualificationError.input }
        // Consume before any side effect. A stale test invocation cannot replay a phase.
        try FileManager.default.removeItem(at: file)
        Self.diagnostic("consumed", input: input)
        let state = Self.directory.appendingPathComponent(input.run, isDirectory: true)
        try FileManager.default.createDirectory(
            at: state,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        var result: [String: Any] = ["run": input.run, "phase": input.phase, "nonce": input.nonce, "ok": false]
        do {
            let value = try await DeviceIdentityStore.withStateDirectory(state) {
                try await Self.execute(input)
            }
            result.merge(value) { _, new in new }
            result["ok"] = true
            result["ownersJoined"] = true
            try Self.writeResult(result)
            Self.diagnostic("written", input: input)
        } catch {
            // Never emit descriptions, userInfo, paths, credentials, or raw request/response bodies.
            result["errors"] = Self.failures(error)
            result["ownersJoined"] = true
            try Self.writeResult(result)
            Self.diagnostic("written", input: input)
            throw QualificationError.result
        }
    }

    private static func diagnostic(_ event: String, input: QualificationInput) {
        /// Shared with Node: UTF-8 NUL-terminated fields; NSNumber decimal strings retain all inode bits.
        func fingerprint(_ domain: String, _ values: [String]) -> String {
            let fields = ["openclaw.watch.bridge.v1", input.nonce.lowercased(), domain] + values
            let bytes = Data((fields.joined(separator: "\0") + "\0").utf8)
            return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        }
        func directory(_ url: URL, domain: String) -> String {
            guard let attributes = try? FileManager.default.attributesOfItem(
                atPath: url.resolvingSymlinksInPath().path),
                attributes[.type] as? FileAttributeType == .typeDirectory,
                let device = attributes[.systemNumber] as? NSNumber,
                let inode = attributes[.systemFileNumber] as? NSNumber,
                let deviceValue = UInt64(device.stringValue), let inodeValue = UInt64(inode.stringValue),
                String(deviceValue) == device.stringValue, String(inodeValue) == inode.stringValue
            else { return "unavailable" }
            return fingerprint(domain, [device.stringValue, inode.stringValue])
        }
        let fields = [
            "OPENCLAW_WATCH_BRIDGE", "1", event,
            fingerprint("phase", [input.run.lowercased(), input.phase]),
            directory(Self.directory, domain: "directory"),
            directory(URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true), domain: "home"),
            Bundle.main.bundleIdentifier.map { fingerprint("bundle", [$0]) } ?? "unavailable",
        ]
        let bytes = Data((fields.joined(separator: "\t") + "\n").utf8)
        guard bytes.count <= 1024 else { return }
        // At most consumed + written. Missing forwarding is unavailable, never owner acknowledgement.
        try? FileHandle.standardOutput.write(contentsOf: bytes)
    }

    private static func execute(_ input: QualificationInput) async throws -> [String: Any] {
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary),
              let publicKey = DeviceIdentityStore.publicKeyBase64Url(identity)
        else { throw QualificationError.persistence }
        if input.phase == "identity" {
            return [
                "deviceID": identity.deviceId, "publicKey": publicKey,
                "platform": InstanceIdentity.platformString, "deviceFamily": InstanceIdentity.deviceFamily,
            ]
        }
        guard let endpoint = input.endpoint, endpoint.scheme == "https", endpoint.host == "localhost",
              endpoint.port != nil, endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil, endpoint.path.isEmpty,
              let gatewayID = input.gatewayID, !gatewayID.isEmpty,
              input.deviceID == identity.deviceId, let token = input.token, !token.isEmpty
        else { throw QualificationError.input }
        if input.phase == "voice" {
            return try await self.voice(
                input,
                endpoint: endpoint,
                gatewayID: gatewayID,
                identity: identity,
                token: token)
        }
        if input.phase == "negative" {
            guard DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId, role: "operator", token: token, scopes: self.scopes,
                gatewayID: gatewayID, profile: .primary)
            else { throw QualificationError.persistence }
        }
        guard let stored = DeviceAuthStore.loadToken(
            deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID, profile: .primary),
            stored.token == token, stored.role == "operator", stored.scopes == self.scopes,
            stored.gatewayID == gatewayID
        else { throw QualificationError.persistence }
        // The default initializer is the behavior under qualification: no pinning/session injection.
        let session = try GatewayOperatorHTTPSession(endpoint: endpoint, gatewayID: gatewayID)
        let observation = QualificationConnection()
        do {
            let hello = try await session.connect(
                options: self.options(gatewayID),
                consumeHello: { hello, current in
                    guard current(), hello.auth["deviceToken"] == nil,
                          hello.auth["method"]?.stringValue == "device-token",
                          hello.auth["role"]?.stringValue == "operator",
                          hello.auth["scopes"]?.arrayValue?.compactMap(\.stringValue) == self.scopes
                    else { throw QualificationError.result }
                },
                consumeEvent: { _, current in
                    guard current() else { throw QualificationError.result }
                },
                onClosed: { _ in await observation.didClose() })
            guard input.phase == "positive", let connectionID = hello.server["connId"]?.stringValue,
                  UUID(uuidString: connectionID) != nil else { throw QualificationError.result }
            _ = try await session.request(
                method: "agents.list", params: AnyCodable([String: String]()), timeoutMs: 10000,
                consume: { response, current in
                    guard current(), response.ok, let payload = response.payload else {
                        throw QualificationError.result
                    }
                    let agents = try JSONDecoder().decode(AgentsListResult.self, from: JSONEncoder().encode(payload))
                    guard agents.agents.contains(where: { $0.id == "proof" }) else { throw QualificationError.result }
                })
            _ = try await session.request(
                method: "sessions.list", params: AnyCodable(["agentId": "proof", "limit": 5] as [String: Any]),
                timeoutMs: 10000, consume: { response, current in
                    guard current(), response.ok,
                          let sessions = response.payload?.dictionaryValue?["sessions"]?.arrayValue, sessions.isEmpty
                    else { throw QualificationError.result }
                })
            try await observation.requireOpen()
            await session.disconnect()
            guard DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID, profile: .primary) == stored
            else { throw QualificationError.persistence }
            return [
                "connectionID": connectionID,
                "tokenlessHello": true,
                "unchangedStoredGrant": true,
                "methods": ["agents.list", "sessions.list"],
            ]
        } catch {
            await session.disconnect()
            guard input.phase == "negative", let failure = error as? GatewayTLSValidationError,
                  failure.failure.kind == .untrustedCertificate, !failure.failure.systemTrustOk,
                  failure.failure.host == "localhost", failure.failure.port == endpoint.port
            else { throw error }
            guard DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID, profile: .primary) == stored
            else { throw QualificationError.persistence }
            return ["untrustedCertificateRejected": true, "unchangedStoredGrant": true, "errors": self.failures(error)]
        }
    }

    private static func voice(
        _ input: QualificationInput, endpoint: URL, gatewayID: String, identity: DeviceIdentity, token: String)
        async throws -> [String: Any]
    {
        guard let replacement = input.replacementToken, !replacement.isEmpty, replacement != token,
              let controlToken = input.controlToken, !controlToken.isEmpty
        else { throw QualificationError.input }
        let controller = WatchGatewayController()
        let delegate = QualificationControlDelegate()
        let control = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        func request(_ action: String) async throws -> [String: Any] {
            var request = URLRequest(url: endpoint.appendingPathComponent(action))
            request.setValue("Bearer \(controlToken)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 25
            let (data, response) = try await control.data(for: request)
            guard data.count <= 4096, (response as? HTTPURLResponse)?.statusCode == 200,
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { throw QualificationError.result }
            return value
        }
        do {
            let setup = try JSONSerialization.data(withJSONObject: [
                "url": endpoint.absoluteString.replacingOccurrences(of: "https://", with: "wss://"),
                "bootstrapToken": "qualification-only",
            ])
            await controller.configure(
                setupCode: String(decoding: setup, as: UTF8.self),
                sentAtMs: Int64(Date().timeIntervalSince1970 * 1000))
            guard let configuration = controller.configuration, configuration.gatewayID == gatewayID,
                  controller.isInstalled(configuration) else { throw QualificationError.persistence }
            try await controller.installOperatorGrant(
                token: token, scopes: self.scopes, configuration: configuration, isCurrent: { true })
            controller.voiceCall.start(connection: configuration.voiceConnection, isCurrent: {
                controller.isInstalled(configuration)
            })
            // The peer returns only after observing the actual connect frame, or its bounded deadline.
            let observed = try await request("connected")
            guard observed["oldConnectObserved"] as? Bool == true else {
                let state = controller.voiceCall.state
                await controller.voiceCall.end().value
                await controller.forget()
                await delegate.close(control)
                return [
                    "voiceQualified": false,
                    "oldConnectObserved": false,
                    "startupOutcome": state == .preparingAudio ? "audio-pending" :
                        state == .failed ? "startup-failed" : "connect-not-observed",
                ]
            }
            guard controller.voiceCall.state == .connectingGateway else { throw QualificationError.result }
            try await controller.installOperatorGrant(
                token: replacement, scopes: self.scopes, configuration: configuration, isCurrent: { true })
            // installOperatorGrant must join the real audio/gateway/startup owner BEFORE fixture release.
            guard controller.voiceCall.state == .idle,
                  DeviceAuthStore.loadToken(
                      deviceId: identity.deviceId,
                      role: "operator",
                      gatewayID: gatewayID,
                      profile: .primary)?.token == replacement
            else { throw QualificationError.persistence }
            let released = try await request("release")
            guard let outcome = released["oldHelloOutcome"] as? String,
                  ["sent", "closed"].contains(outcome) else { throw QualificationError.result }
            controller.voiceCall.start(connection: configuration.voiceConnection, isCurrent: {
                controller.isInstalled(configuration)
            })
            // A post-hello RPC proves the fresh real controller consumed its tokenless hello.
            // The peer holds that RPC so no provider session or synthetic audio is needed.
            let fresh = try await request("fresh")
            guard fresh["freshAuthenticated"] as? Bool == true else { throw QualificationError.result }
            await controller.voiceCall.end().value
            guard controller.voiceCall.state == .idle,
                  DeviceAuthStore.loadToken(
                      deviceId: identity.deviceId,
                      role: "operator",
                      gatewayID: gatewayID,
                      profile: .primary)?.token == replacement
            else { throw QualificationError.persistence }
            let final = try await request("status")
            guard final["freshAuthenticated"] as? Bool == true else { throw QualificationError.result }
            await controller.forget()
            await delegate.close(control)
            return [
                "voiceQualified": true,
                "oldConnectObserved": true,
                "retirementJoined": true,
                "durableReplacement": true,
                "freshAuthenticated": true,
                "freshRetirementJoined": true,
                "oldHelloOutcome": outcome,
            ]
        } catch {
            await controller.voiceCall.end().value
            await controller.forget()
            await delegate.close(control)
            throw error
        }
    }

    private static func options(_ gatewayID: String) -> GatewayConnectOptions {
        GatewayConnectOptions(
            role: "operator", scopes: self.scopes, scopesAreExplicit: true, caps: [], commands: [], permissions: [:],
            clientId: "openclaw-watchos", clientMode: "node", clientDisplayName: "Hosted Watch qualification",
            deviceIdentityProfile: .primary, deviceAuthGatewayID: gatewayID)
    }

    private static func readPrivate(_ file: URL) throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              ((attributes[.size] as? NSNumber)?.intValue ?? 16385) <= 16384,
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600
        else { throw QualificationError.input }
        let bytes = try Data(contentsOf: file)
        guard bytes.count <= 16384 else { throw QualificationError.input }
        return bytes
    }

    private static func writeResult(_ result: [String: Any]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        guard bytes.count <= 16384 else { throw QualificationError.result }
        let file = Self.directory.appendingPathComponent("result.json")
        try bytes.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    private static func failures(_ error: any Error) -> [[String: Any]] {
        var result: [[String: Any]] = []
        var current: NSError? = error as NSError
        while let value = current, result.count < 8 {
            let domain = [NSURLErrorDomain, NSOSStatusErrorDomain].contains(value.domain) ? value.domain : "other"
            result.append(["domain": domain, "code": value.code])
            current = value.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return result
    }
}
