import Foundation
import XCTest
@testable import OpenClawMLXTTSRuntime

@MainActor
final class MLXTTSModelConfigPreflightTests: XCTestCase {
    private let repo = "fixture/model"

    func testValidObjectsAndArraysDoNotRecover() async throws {
        for json in [#"{"model_type":"qwen3_tts"}"#, "[]"] {
            let config = try self.makeConfig(Data(json.utf8))
            defer { try? FileManager.default.removeItem(at: config.deletingLastPathComponent()) }
            let calls = PreflightCalls()
            try await MLXTTSModelConfigPreflight.prepare(
                repo: self.repo,
                resolveConfig: { repo in await calls.resolve(repo, config: config) },
                recoverModel: { repo in await calls.recover(repo) })
            await self.assertCalls(calls, resolved: [self.repo], recovered: [])
        }
    }

    func testMalformedEmptyAndScalarConfigsRecoverExactlyOnce() async throws {
        for json in ["{broken", "", "null", #""scalar""#] {
            let data = Data(json.utf8)
            let config = try self.makeConfig(data)
            defer { try? FileManager.default.removeItem(at: config.deletingLastPathComponent()) }
            let calls = PreflightCalls()
            try await MLXTTSModelConfigPreflight.prepare(
                repo: self.repo,
                resolveConfig: { repo in await calls.resolve(repo, config: config) },
                recoverModel: { repo in await calls.recover(repo) })
            await self.assertCalls(calls, resolved: [self.repo], recovered: [self.repo])
            XCTAssertEqual(try Data(contentsOf: config), data)
        }
    }

    func testResolverAndAuthenticationFailuresPropagateWithoutRecovery() async {
        for failure in [PreflightError.resolver, .authentication] {
            let calls = PreflightCalls()
            do {
                try await MLXTTSModelConfigPreflight.prepare(
                    repo: self.repo,
                    resolveConfig: { repo in
                        await calls.recordResolve(repo)
                        throw failure
                    },
                    recoverModel: { repo in await calls.recover(repo) })
                XCTFail("expected resolver failure")
            } catch {
                XCTAssertEqual(error as? PreflightError, failure)
            }
            await self.assertCalls(calls, resolved: [self.repo], recovered: [])
        }
    }

    func testConfigReadFailurePropagatesWithoutRecovery() async throws {
        let config = try self.makeConfig(nil)
        defer { try? FileManager.default.removeItem(at: config.deletingLastPathComponent()) }
        let calls = PreflightCalls()
        do {
            try await MLXTTSModelConfigPreflight.prepare(
                repo: self.repo,
                resolveConfig: { repo in await calls.resolve(repo, config: config) },
                recoverModel: { repo in await calls.recover(repo) })
            XCTFail("expected missing config read failure")
        } catch {
            XCTAssertEqual((error as NSError).domain, NSCocoaErrorDomain)
            XCTAssertEqual((error as NSError).code, NSFileReadNoSuchFileError)
        }
        await self.assertCalls(calls, resolved: [self.repo], recovered: [])
    }

    func testRecoveryFailurePropagatesAfterOneAttempt() async throws {
        let config = try self.makeConfig(Data("{broken".utf8))
        defer { try? FileManager.default.removeItem(at: config.deletingLastPathComponent()) }
        let calls = PreflightCalls()
        do {
            try await MLXTTSModelConfigPreflight.prepare(
                repo: self.repo,
                resolveConfig: { repo in await calls.resolve(repo, config: config) },
                recoverModel: { repo in
                    await calls.recover(repo)
                    throw PreflightError.recovery
                })
            XCTFail("expected recovery failure")
        } catch {
            XCTAssertEqual(error as? PreflightError, .recovery)
        }
        await self.assertCalls(calls, resolved: [self.repo], recovered: [self.repo])
    }

    func testCancellationBeforeRecoveryDoesNotRecover() async throws {
        let config = try self.makeConfig(Data("{broken".utf8))
        defer { try? FileManager.default.removeItem(at: config.deletingLastPathComponent()) }
        let calls = PreflightCalls()
        let repo = self.repo
        let task = Task {
            try await MLXTTSModelConfigPreflight.prepare(
                repo: repo,
                resolveConfig: { repo in
                    await calls.recordResolve(repo)
                    withUnsafeCurrentTask { $0?.cancel() }
                    return config
                },
                recoverModel: { repo in await calls.recover(repo) })
        }
        do {
            try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        await self.assertCalls(calls, resolved: [self.repo], recovered: [])
    }

    func testExistingLocalConfigsBypassRemotePreflightIncludingTilde() async throws {
        let data = Data("{local parsing belongs to the model loader".utf8)
        let config = try self.makeConfig(data)
        defer { try? FileManager.default.removeItem(at: config.deletingLastPathComponent()) }
        let directory = config.deletingLastPathComponent()
        let homeDepth = FileManager.default.homeDirectoryForCurrentUser.pathComponents.count - 1
        let parents = Array(repeating: "..", count: homeDepth).joined(separator: "/")
        for repo in [directory.path, "~/\(parents)\(directory.path)"] {
            let calls = PreflightCalls()
            try await MLXTTSModelConfigPreflight.prepare(
                repo: repo,
                resolveConfig: { repo in
                    await calls.recordResolve(repo)
                    throw PreflightError.resolver
                },
                recoverModel: { repo in await calls.recover(repo) })
            await self.assertCalls(calls, resolved: [], recovered: [])
            XCTAssertEqual(try Data(contentsOf: config), data)
        }
    }

    private func makeConfig(_ data: Data?) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("mlx-config-preflight-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let config = directory.appendingPathComponent("config.json")
        if let data {
            try data.write(to: config)
        }
        return config
    }

    private func assertCalls(_ calls: PreflightCalls, resolved: [String], recovered: [String]) async {
        let snapshot = await calls.snapshot
        XCTAssertEqual(snapshot.resolved, resolved)
        XCTAssertEqual(snapshot.recovered, recovered)
    }
}

private enum PreflightError: Error, Equatable {
    case resolver
    case authentication
    case recovery
}

private actor PreflightCalls {
    private var resolved: [String] = []
    private var recovered: [String] = []

    func resolve(_ repo: String, config: URL) -> URL {
        self.resolved.append(repo)
        return config
    }

    func recordResolve(_ repo: String) {
        self.resolved.append(repo)
    }

    func recover(_ repo: String) {
        self.recovered.append(repo)
    }

    var snapshot: (resolved: [String], recovered: [String]) {
        (self.resolved, self.recovered)
    }
}
