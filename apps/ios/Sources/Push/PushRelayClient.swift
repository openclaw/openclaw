import CryptoKit
import DeviceCheck
import Foundation
import StoreKit

enum PushRelayError: LocalizedError {
    case relayBaseURLMissing
    case relayMisconfigured(String)
    case invalidResponse(String)
    case requestFailed(status: Int, message: String)
    case unsupportedAppAttest
    case missingReceipt
    case freshAttestationUnacknowledged

    var errorDescription: String? {
        switch self {
        case .relayBaseURLMissing:
            "Push relay base URL missing"
        case let .relayMisconfigured(message):
            message
        case let .invalidResponse(message):
            message
        case let .requestFailed(status, message):
            "Push relay request failed (\(status)): \(message)"
        case .unsupportedAppAttest:
            "App Attest unavailable on this device"
        case .missingReceipt:
            "App Store app transaction missing after refresh"
        case .freshAttestationUnacknowledged:
            "Fresh App Attest enrollment was not acknowledged; key preserved, no automatic recovery"
        }
    }
}

private struct PushRelayChallengeResponse: Decodable {
    var challengeId: String
    var challenge: String
    var expiresAtMs: Int64
}

private struct PushRelayRegisterSignedPayload: Encodable {
    var challengeId: String
    var installationId: String
    var bundleId: String
    var environment: String
    var relayProfile: String
    var apnsEnvironment: String
    var proofPolicy: String
    var distribution: String
    var gateway: PushRelayGatewayIdentity
    var appVersion: String
    var apnsToken: String
}

struct PushRelayReceiptPayload: Encodable {
    var base64: String
}

private struct PushRelayRegisterRequest: Encodable {
    var challengeId: String
    var installationId: String
    var bundleId: String
    var environment: String
    var relayProfile: String
    var apnsEnvironment: String
    var proofPolicy: String
    var distribution: String
    var gateway: PushRelayGatewayIdentity
    var appVersion: String
    var apnsToken: String
    var appAttest: PushRelayAppAttestProof?
    var receipt: PushRelayReceiptPayload?
    var simulatorProof: PushRelaySimulatorProofPayload?
}

struct PushRelayRegisterResponse: Decodable, Sendable {
    var relayHandle: String
    var sendGrant: String
    var expiresAtMs: Int64?
    var tokenSuffix: String?
    var status: String
}

private struct RelayErrorResponse: Decodable {
    var error: String?
    var message: String?
    var reason: String?
}

struct PushRelayAppAttestProof: Encodable, Sendable {
    var keyId: String
    var attestationObject: String?
    var assertion: String
    var clientDataHash: String
    var signedPayloadBase64: String
}

private struct PushRelaySimulatorProofPayload: Encodable {
    var signedPayloadBase64: String
    var hmacSha256Base64Url: String
}

struct PushRelayAppAttestDevice: Sendable {
    var isSupported: @Sendable () -> Bool = { DCAppAttestService.shared.isSupported }
    var generateKey: @Sendable () async throws -> String = { try await DCAppAttestService.shared.generateKey() }
    var attestKey: @Sendable (String, Data) async throws -> Data = {
        try await DCAppAttestService.shared.attestKey($0, clientDataHash: $1)
    }

    var generateAssertion: @Sendable (String, Data) async throws -> Data = {
        try await DCAppAttestService.shared.generateAssertion($0, clientDataHash: $1)
    }
}

final class PushRelayAppAttestService: Sendable {
    private let device: PushRelayAppAttestDevice

    init(device: PushRelayAppAttestDevice = PushRelayAppAttestDevice()) {
        self.device = device
    }

    func createProof(
        challenge: String,
        makeSignedPayload: (String) throws -> Data,
        scope: PushRelayRegistrationStore.AppAttestScope)
    async throws -> PushRelayAppAttestProof {
        guard self.device.isSupported() else {
            throw PushRelayError.unsupportedAppAttest
        }

        let keyID = try await self.loadOrCreateKeyID(scope: scope)
        // Select the real key before encoding. Hash and transmit this one byte sequence.
        let signedPayload = try makeSignedPayload(keyID)
        let attestationObject = try await self.attestKeyIfNeeded(
            keyID: keyID,
            challenge: challenge,
            scope: scope)
        let signedPayloadHash = Data(SHA256.hash(data: signedPayload))
        let assertion: Data
        do {
            assertion = try await self.device.generateAssertion(keyID, signedPayloadHash)
        } catch {
            // Ordinary and activity grants share this key. An assertion error is not key-loss proof.
            if attestationObject != nil { throw PushRelayError.freshAttestationUnacknowledged }
            throw error
        }

        return PushRelayAppAttestProof(
            keyId: keyID,
            attestationObject: attestationObject,
            assertion: assertion.base64EncodedString(),
            clientDataHash: Self.base64URL(signedPayloadHash),
            signedPayloadBase64: signedPayload.base64EncodedString())
    }

    private func loadOrCreateKeyID(
        scope: PushRelayRegistrationStore.AppAttestScope)
    async throws -> String {
        if let existing = PushRelayRegistrationStore.loadAppAttestKeyID(scope: scope),
           !existing.isEmpty
        {
            return existing
        }
        let keyID = try await self.device.generateKey()
        guard PushRelayRegistrationStore.saveAppAttestKeyID(keyID, scope: scope) else {
            throw PushRelayError.relayMisconfigured("Unable to retain App Attest key")
        }
        return keyID
    }

    private func attestKeyIfNeeded(
        keyID: String,
        challenge: String,
        scope: PushRelayRegistrationStore.AppAttestScope)
    async throws -> String? {
        if PushRelayRegistrationStore.loadAttestedKeyID(scope: scope) == keyID {
            return nil
        }
        let challengeData = Data(challenge.utf8)
        let clientDataHash = Data(SHA256.hash(data: challengeData))
        let attestation = try await self.device.attestKey(keyID, clientDataHash)
        // Apple treats App Attest key attestation as a one-time operation. Save the
        // attested marker immediately so later receipt/network failures do not cause a
        // permanently broken re-attestation loop on the same key.
        guard PushRelayRegistrationStore.saveAttestedKeyID(keyID, scope: scope) else {
            throw PushRelayError.freshAttestationUnacknowledged
        }
        return attestation.base64EncodedString()
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private final class PushRelayReceiptProvider: Sendable {
    func loadReceiptBase64() async throws -> String {
        do {
            let result = try await AppTransaction.shared
            return try Self.appTransactionBase64(result)
        } catch {
            let refreshed = try await AppTransaction.refresh()
            return try Self.appTransactionBase64(refreshed)
        }
    }

    private static func appTransactionBase64(
        _ result: StoreKit.VerificationResult<AppTransaction>) throws -> String
    {
        let jws = result.jwsRepresentation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !jws.isEmpty else {
            throw PushRelayError.missingReceipt
        }
        return Data(jws.utf8).base64EncodedString()
    }
}

private final class PushRelaySimulatorProofProvider {
    func createProof(signedPayload: Data) throws -> PushRelaySimulatorProofPayload {
        #if targetEnvironment(simulator)
        guard let secret = ProcessInfo.processInfo.environment["OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !secret.isEmpty
        else {
            throw PushRelayError.relayMisconfigured("Simulator push proof secret missing")
        }
        let signedPayloadBase64 = signedPayload.base64EncodedString()
        let signature = HMAC<SHA256>.authenticationCode(
            for: Data(signedPayloadBase64.utf8),
            using: SymmetricKey(data: Data(secret.utf8)))
        return PushRelaySimulatorProofPayload(
            signedPayloadBase64: signedPayloadBase64,
            hmacSha256Base64Url: Self.base64URL(Data(signature)))
        #else
        throw PushRelayError.relayMisconfigured("Simulator proof is only available in iOS Simulator")
        #endif
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

struct PushRelayRegistrationInput: Sendable {
    var installationId: String
    var bundleId: String
    var appVersion: String
    var environment: PushAPNsEnvironment
    var relayProfile: PushRelayProfile
    var proofPolicy: PushProofPolicy
    var distribution: PushDistributionMode
    var apnsTokenHex: String
    var gatewayIdentity: PushRelayGatewayIdentity
}

/// Actor isolation alone cannot serialize App Attest counters across awaited HTTP responses.
private actor PushRelayEnrollmentGate {
    private var held = false
    private var waiters: [(UUID, CheckedContinuation<Void, any Error>)] = []

    func withPermit<T: Sendable>(_ operation: @Sendable () async throws -> T) async throws -> T {
        try await self.acquire()
        do {
            try Task.checkCancellation()
            let result = try await operation()
            self.release()
            return result
        } catch {
            self.release()
            throw error
        }
    }

    private func acquire() async throws {
        try Task.checkCancellation()
        guard self.held else {
            self.held = true
            return
        }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.waiters.append((id, continuation))
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    private func cancel(_ id: UUID) {
        guard let index = self.waiters.firstIndex(where: { $0.0 == id }) else { return }
        self.waiters.remove(at: index).1.resume(throwing: CancellationError())
    }

    private func release() {
        if self.waiters.isEmpty {
            self.held = false
        } else {
            self.waiters.removeFirst().1.resume()
        }
    }
}

/// The existing registration manager owns this client and its one enrollment gate.
final class PushRelayClient: @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let jsonDecoder = JSONDecoder()
    private let jsonEncoder = JSONEncoder()
    private let appAttest: PushRelayAppAttestService
    private let loadReceipt: @Sendable () async throws -> String
    private let simulatorProofProvider = PushRelaySimulatorProofProvider()
    private let enrollment = PushRelayEnrollmentGate()

    init(
        baseURL: URL,
        session: URLSession = .shared,
        appAttest: PushRelayAppAttestService = PushRelayAppAttestService(),
        loadReceipt: (@Sendable () async throws -> String)? = nil)
    {
        self.baseURL = baseURL
        self.session = session
        self.appAttest = appAttest
        let receiptProvider = PushRelayReceiptProvider()
        self.loadReceipt = loadReceipt ?? { try await receiptProvider.loadReceiptBase64() }
    }

    var normalizedBaseURLString: String {
        Self.normalizeBaseURLString(self.baseURL)
    }

    func register(_ input: PushRelayRegistrationInput) async throws -> PushRelayRegisterResponse {
        try await self.enrollment.withPermit { try await self.registerEnrolled(input) }
    }

    private func registerEnrolled(_ input: PushRelayRegistrationInput) async throws -> PushRelayRegisterResponse {
        GatewayDiagnostics.pushRelay.stage(
            "registration start origin=\(self.normalizedBaseURLString) "
                + "apns=\(input.environment.rawValue) "
                + "profile=\(input.relayProfile.rawValue) "
                + "proof=\(input.proofPolicy.rawValue)")
        let challenge: PushRelayChallengeResponse
        do {
            GatewayDiagnostics.pushRelay.stage("challenge request start")
            challenge = try await self.fetchChallenge()
            GatewayDiagnostics.pushRelay.stage("challenge received")
        } catch {
            GatewayDiagnostics.pushRelay.failed("challenge request", error: error)
            throw error
        }
        let signedPayload = PushRelayRegisterSignedPayload(
            challengeId: challenge.challengeId,
            installationId: input.installationId,
            bundleId: input.bundleId,
            environment: input.environment.rawValue,
            relayProfile: input.relayProfile.rawValue,
            apnsEnvironment: input.environment.rawValue,
            proofPolicy: input.proofPolicy.rawValue,
            distribution: input.distribution.rawValue,
            gateway: input.gatewayIdentity,
            appVersion: input.appVersion,
            apnsToken: input.apnsTokenHex)
        let appAttestScope = PushRelayRegistrationStore.AppAttestScope(
            relayOrigin: self.normalizedBaseURLString,
            apnsEnvironment: input.environment.rawValue,
            relayProfile: input.relayProfile.rawValue,
            proofPolicy: input.proofPolicy.rawValue)
        let appAttest: PushRelayAppAttestProof?
        do {
            GatewayDiagnostics.pushRelay.stage("app attest proof start")
            appAttest = try await self.createAppAttestProofIfNeeded(
                proofPolicy: input.proofPolicy,
                challenge: challenge.challenge,
                makeSignedPayload: { _ in try self.jsonEncoder.encode(signedPayload) },
                scope: appAttestScope)
            GatewayDiagnostics.pushRelay.stage("app attest proof complete included=\(appAttest != nil)")
        } catch {
            GatewayDiagnostics.pushRelay.failed("app attest proof", error: error)
            throw error
        }
        do {
            let receipt: PushRelayReceiptPayload?
            do {
                GatewayDiagnostics.pushRelay.stage("receipt proof start")
                receipt = try await self.createReceiptIfNeeded(proofPolicy: input.proofPolicy)
                GatewayDiagnostics.pushRelay.stage("receipt proof complete included=\(receipt != nil)")
            } catch {
                GatewayDiagnostics.pushRelay.failed("receipt proof", error: error)
                throw error
            }
            let simulatorProof: PushRelaySimulatorProofPayload?
            do {
                simulatorProof = try self.createSimulatorProofIfNeeded(
                    proofPolicy: input.proofPolicy,
                    makeSignedPayload: { try self.jsonEncoder.encode(signedPayload) })
                GatewayDiagnostics.pushRelay.stage("simulator proof complete included=\(simulatorProof != nil)")
            } catch {
                GatewayDiagnostics.pushRelay.failed("simulator proof", error: error)
                throw error
            }
            let requestBody = PushRelayRegisterRequest(
                challengeId: signedPayload.challengeId,
                installationId: signedPayload.installationId,
                bundleId: signedPayload.bundleId,
                environment: signedPayload.environment,
                relayProfile: signedPayload.relayProfile,
                apnsEnvironment: signedPayload.apnsEnvironment,
                proofPolicy: signedPayload.proofPolicy,
                distribution: signedPayload.distribution,
                gateway: signedPayload.gateway,
                appVersion: signedPayload.appVersion,
                apnsToken: signedPayload.apnsToken,
                appAttest: appAttest,
                receipt: receipt,
                simulatorProof: simulatorProof)

            let endpoint = self.baseURL.appending(path: "v1/push/register")
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.timeoutInterval = 20
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try self.jsonEncoder.encode(requestBody)

            let data: Data
            let response: URLResponse
            do {
                GatewayDiagnostics.pushRelay.stage("register request start")
                try Task.checkCancellation()
                (data, response) = try await self.session.data(for: request)
            } catch {
                GatewayDiagnostics.pushRelay.failed("register request", error: error)
                throw error
            }
            let status = Self.statusCode(from: response)
            GatewayDiagnostics.pushRelay.stage("register response status=\(status)")
            guard (200..<300).contains(status) else {
                let relayError = PushRelayError.requestFailed(
                    status: status,
                    message: Self.decodeErrorMessage(data: data))
                GatewayDiagnostics.pushRelay.stage("register response failed status=\(status)")
                throw relayError
            }
            do {
                let decoded = try self.decode(PushRelayRegisterResponse.self, from: data)
                GatewayDiagnostics.pushRelay.stage("registration response decoded")
                return decoded
            } catch {
                GatewayDiagnostics.pushRelay.failed("registration response decode", error: error)
                throw error
            }
        } catch {
            if appAttest?.attestationObject != nil { throw PushRelayError.freshAttestationUnacknowledged }
            throw error
        }
    }

    private func createAppAttestProofIfNeeded(
        proofPolicy: PushProofPolicy,
        challenge: String,
        makeSignedPayload: (String) throws -> Data,
        scope: PushRelayRegistrationStore.AppAttestScope)
    async throws -> PushRelayAppAttestProof? {
        guard proofPolicy != .internalSimulator else { return nil }
        return try await self.appAttest.createProof(
            challenge: challenge,
            makeSignedPayload: makeSignedPayload,
            scope: scope)
    }

    private func createReceiptIfNeeded(
        proofPolicy: PushProofPolicy)
    async throws -> PushRelayReceiptPayload? {
        switch proofPolicy {
        case .appleStrict:
            return try await PushRelayReceiptPayload(base64: self.loadReceipt())
        case .appleDevelopment:
            guard let receiptBase64 = try? await self.loadReceipt() else {
                return nil
            }
            return PushRelayReceiptPayload(base64: receiptBase64)
        case .internalSimulator:
            return nil
        }
    }

    private func createSimulatorProofIfNeeded(
        proofPolicy: PushProofPolicy,
        makeSignedPayload: () throws -> Data)
    throws -> PushRelaySimulatorProofPayload? {
        guard proofPolicy == .internalSimulator else { return nil }
        return try self.simulatorProofProvider.createProof(signedPayload: makeSignedPayload())
    }

    func performActivityOperation(
        _ operation: PushRelayActivityOperation,
        input: PushRelayActivityInput) async throws -> PushRelayActivityOutcome
    {
        try await self.enrollment.withPermit {
            try await self.performActivityOperationEnrolled(operation, input: input)
        }
    }

    private func performActivityOperationEnrolled(
        _ operation: PushRelayActivityOperation,
        input: PushRelayActivityInput) async throws -> PushRelayActivityOutcome
    {
        // Validate before spending a challenge or touching the shared App Attest key.
        try PushRelayActivityRequest.validate(operation: operation, input: input)
        let challenge = try await self.fetchChallenge()
        let envelope = try PushRelayActivityRequest(
            operation: operation, input: input, challengeId: challenge.challengeId)
        let scope = PushRelayRegistrationStore.AppAttestScope(
            relayOrigin: self.normalizedBaseURLString,
            apnsEnvironment: input.environment.rawValue,
            relayProfile: input.relayProfile.rawValue,
            proofPolicy: input.proofPolicy.rawValue)
        var freshAttestation = false
        var submitted = false
        do {
            let proof = try await self.appAttest.createProof(
                challenge: challenge.challenge,
                makeSignedPayload: { try envelope.signedPayload(keyId: $0, challenge: challenge.challenge) },
                scope: scope)
            freshAttestation = proof.attestationObject != nil
            var body = envelope
            body.appAttest = proof
            body.receipt = try await self.createReceiptIfNeeded(proofPolicy: input.proofPolicy)
            let route = operation.name == "revoke" ? "revoke" : "register"
            var request = URLRequest(url: self.baseURL.appending(path: "v1/push/activity/\(route)"))
            request.httpMethod = "POST"
            request.timeoutInterval = 20
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try self.jsonEncoder.encode(body)
            try Task.checkCancellation()
            submitted = true
            let (data, response) = try await self.session.data(for: request)
            guard data.count <= 16 * 1024 else {
                throw PushRelayError.invalidResponse("Activity relay response too large")
            }
            let outcome = try self.jsonDecoder.decode(PushRelayActivityResponse.self, from: data).outcome(
                httpStatus: Self.statusCode(from: response),
                operation: operation,
                input: input,
                relayOrigin: self.normalizedBaseURLString)
            if freshAttestation, [.unauthorized, .rateLimited, .unavailable].contains(outcome) {
                return .freshAttestationUnacknowledged
            }
            return outcome
        } catch {
            // A lost response is not permission to create again, replace the key, or reuse a grant.
            if freshAttestation { return .freshAttestationUnacknowledged }
            if case PushRelayError.freshAttestationUnacknowledged = error {
                return .freshAttestationUnacknowledged
            }
            if submitted { return .operationOutcomeUnknown }
            throw error
        }
    }

    private func fetchChallenge() async throws -> PushRelayChallengeResponse {
        let endpoint = self.baseURL.appending(path: "v1/push/challenge")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await self.session.data(for: request)
        let status = Self.statusCode(from: response)
        guard (200..<300).contains(status) else {
            throw PushRelayError.requestFailed(
                status: status,
                message: Self.decodeErrorMessage(data: data))
        }
        return try self.decode(PushRelayChallengeResponse.self, from: data)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try self.jsonDecoder.decode(type, from: data)
        } catch {
            throw PushRelayError.invalidResponse(error.localizedDescription)
        }
    }

    private static func statusCode(from response: URLResponse) -> Int {
        (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    private static func normalizeBaseURLString(_ url: URL) -> String {
        var absolute = url.absoluteString
        while absolute.hasSuffix("/") {
            absolute.removeLast()
        }
        return absolute
    }

    private static func decodeErrorMessage(data: Data) -> String {
        if let decoded = try? JSONDecoder().decode(RelayErrorResponse.self, from: data) {
            let message = decoded.message ?? decoded.reason ?? decoded.error ?? ""
            if !message.isEmpty {
                return message
            }
        }
        let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? "unknown relay error" : raw
    }
}
