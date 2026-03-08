import Foundation
import Testing
import OpenClawKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConfigStoreTests {
    private func withOverrides<T>(
        _ overrides: ConfigStore.Overrides,
        operation: () async throws -> T) async throws -> T
    {
        await ConfigStore._testSetOverrides(overrides)
        do {
            let result = try await operation()
            await ConfigStore._testClearOverrides()
            return result
        } catch {
            await ConfigStore._testClearOverrides()
            throw error
        }
    }

    @Test func loadUsesRemoteInRemoteMode() async throws {
        var localHit = false
        var remoteHit = false
        let result = try await self.withOverrides(.init(
            isRemoteMode: { true },
            loadLocal: { localHit = true; return ["local": true] },
            loadRemote: { remoteHit = true; return ["remote": true] }))
        {
            await ConfigStore.load()
        }

        #expect(remoteHit)
        #expect(!localHit)
        #expect(result["remote"] as? Bool == true)
    }

    @Test func loadUsesLocalInLocalMode() async throws {
        var localHit = false
        var remoteHit = false
        let result = try await self.withOverrides(.init(
            isRemoteMode: { false },
            loadLocal: { localHit = true; return ["local": true] },
            loadRemote: { remoteHit = true; return ["remote": true] }))
        {
            await ConfigStore.load()
        }

        #expect(localHit)
        #expect(!remoteHit)
        #expect(result["local"] as? Bool == true)
    }

    @Test func saveRoutesToRemoteInRemoteMode() async throws {
        var localHit = false
        var remoteHit = false
        try await self.withOverrides(.init(
            isRemoteMode: { true },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in remoteHit = true }))
        {
            try await ConfigStore.save(["remote": true])
        }

        #expect(remoteHit)
        #expect(!localHit)
    }

    @Test func saveAttemptsGatewayFirstInLocalMode() async throws {
        var localHit = false
        var gatewayHit = false
        try await self.withOverrides(.init(
            isRemoteMode: { false },
            saveLocal: { _ in localHit = true },
            saveToGateway: { _ in gatewayHit = true }))
        {
            try await ConfigStore.save(["local": true])
        }

        #expect(gatewayHit)
        #expect(!localHit)
    }

    @Test func saveFallsBackToLocalOnTransportFailure() async throws {
        var localHit = false
        var gatewayHit = false
        try await self.withOverrides(.init(
            isRemoteMode: { false },
            saveLocal: { _ in localHit = true },
            saveToGateway: { _ in
                gatewayHit = true
                throw URLError(.cannotConnectToHost)
            }))
        {
            try await ConfigStore.save(["local": true])
        }

        #expect(gatewayHit)
        #expect(localHit)
    }

    @Test func saveDoesNotFallbackForGatewayInvalidRequest() async {
        var localHit = false
        do {
            try await self.withOverrides(.init(
                isRemoteMode: { false },
                saveLocal: { _ in localHit = true },
                saveToGateway: { _ in
                    throw GatewayResponseError(
                        method: "config.set",
                        code: "INVALID_REQUEST",
                        message: "config changed since last load",
                        details: nil)
                }))
            {
                try await ConfigStore.save(["local": true])
            }
            Issue.record("Expected save to throw gateway invalid request")
        } catch is GatewayResponseError {
            #expect(!localHit)
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }

    @Test func saveDoesNotFallbackForGatewayDecodingError() async {
        var localHit = false
        do {
            try await self.withOverrides(.init(
                isRemoteMode: { false },
                saveLocal: { _ in localHit = true },
                saveToGateway: { _ in
                    throw GatewayDecodingError(method: "config.set", message: "bad payload")
                }))
            {
                try await ConfigStore.save(["local": true])
            }
            Issue.record("Expected save to throw gateway decoding error")
        } catch is GatewayDecodingError {
            #expect(!localHit)
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }
}
