import ConcurrencyExtras
import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConfigStoreTests {
    @Test(arguments: [true, false])
    func `gateway saves preserve source order and refuse missing source`(_ hasSource: Bool) async throws {
        let initial = #"{"agents":{"ownership":"explicit","entries":{"zmain":{},"alpha":{}}},"browser":{"enabled":true}}"#
        let raw = LockIsolated(initial)
        let received = LockIsolated<[String]>([])
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(data): data
                case let .string(text): Data(text.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(frame["id"] as? String)
                let payload: [String: Any]
                if frame["method"] as? String == "config.get" {
                    let config = try JSONSerialization.jsonObject(with: Data(raw.value.utf8))
                    var snapshot: [String: Any] = ["config": config, "hash": "synthetic-revision"]
                    if hasSource { snapshot["raw"] = raw.value }
                    payload = snapshot
                } else {
                    #expect(frame["method"] as? String == "config.set")
                    let params = try #require(frame["params"] as? [String: Any])
                    #expect(params["baseHash"] as? String == "synthetic-revision")
                    let next = try #require(params["raw"] as? String)
                    raw.withValue { $0 = next }
                    received.withValue { $0.append(next) }
                    payload = ["ok": true]
                }
                let response: [String: Any] = ["type": "res", "id": id, "ok": true, "payload": payload]
                try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: response)))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (URL(string: "ws://127.0.0.1:49343/")!, nil, nil) },
            sessionBox: WebSocketSessionBox(session: session))
        do {
            try await self.withOverrides(.init(isRemoteMode: { true }, notificationCenter: NotificationCenter())) {
                for enabled in [false, true, false] {
                    var document = await ConfigStore.load(gateway: gateway)
                    document.root["browser"] = ["enabled": enabled]
                    if hasSource {
                        try await ConfigStore.save(document)
                    } else {
                        do {
                            try await ConfigStore.save(document)
                            Issue.record("A populated document without its source text must not be saved")
                        } catch {
                            #expect((error as NSError).code == 4)
                        }
                    }
                }
            }
        } catch {
            await gateway.shutdown()
            throw error
        }
        await gateway.shutdown()
        #expect(received.value.count == (hasSource ? 3 : 0))
        for text in received.value {
            let main = try #require(text.range(of: "\"zmain\""))
            let other = try #require(text.range(of: "\"alpha\""))
            #expect(main.lowerBound < other.lowerBound)
        }
    }

    @Test func `load uses remote in remote mode`() async {
        var localHit = false
        var remoteHit = false
        let result = await self.withOverrides(.init(
            isRemoteMode: { true },
            loadLocal: { localHit = true
                return ["local": true]
            },
            loadRemote: { remoteHit = true
                return ["remote": true]
            })) {
                await ConfigStore.load()
            }
        #expect(remoteHit)
        #expect(!localHit)
        #expect(result.root["remote"] as? Bool == true)
    }

    @Test func `load uses local in local mode`() async {
        var localHit = false
        var remoteHit = false
        let result = await self.withOverrides(.init(
            isRemoteMode: { false },
            loadLocal: { localHit = true
                return ["local": true]
            },
            loadRemote: { remoteHit = true
                return ["remote": true]
            })) {
                await ConfigStore.load()
            }
        #expect(localHit)
        #expect(!remoteHit)
        #expect(result.root["local"] as? Bool == true)
    }

    @Test func `save routes to remote in remote mode`() async throws {
        var localHit = false
        var remoteHit = false
        let notificationCenter = NotificationCenter()
        let changeCount = NotificationCount()
        let observer = notificationCenter.addObserver(
            forName: .openclawConfigDidChange,
            object: nil,
            queue: nil)
        { note in changeCount.record(note) }
        defer { notificationCenter.removeObserver(observer) }

        try await self.withOverrides(.init(
            isRemoteMode: { true },
            saveLocal: { _ in localHit = true },
            loadRemote: { [:] },
            saveRemote: { _ in
                remoteHit = true
                // Reproduce a concurrent AppState-style publisher overlapping this save.
                await Task.detached {
                    NotificationCenter.default.post(name: .openclawConfigDidChange, object: nil)
                }.value
            },
            notificationCenter: notificationCenter))
        {
            try await self.saveLoadedDocument(["remote": true])
        }

        #expect(remoteHit)
        #expect(!localHit)
        #expect(changeCount.value == 1)
        #expect(changeCount.allSendersWereNil)
    }

    @Test func `save routes to local in local mode`() async throws {
        var localHit = false
        var remoteHit = false
        try await self.withOverrides(.init(
            isRemoteMode: { false },
            loadLocal: { [:] },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in remoteHit = true }))
        {
            try await self.saveLoadedDocument(["local": true])
        }
        #expect(localHit)
        #expect(!remoteHit)
    }

    @Test func `failed save does not announce config change`() async {
        let failure = NSError(domain: "ConfigStoreTests", code: 1)
        let notificationCenter = NotificationCenter()
        let changeCount = NotificationCount()
        let observer = notificationCenter.addObserver(
            forName: .openclawConfigDidChange,
            object: nil,
            queue: nil)
        { note in changeCount.record(note) }
        defer { notificationCenter.removeObserver(observer) }

        await self.withOverrides(.init(
            isRemoteMode: { true },
            loadRemote: { [:] },
            saveRemote: { _ in
                // Concurrent same-name traffic must not look like a ConfigStore announcement.
                await Task.detached {
                    NotificationCenter.default.post(name: .openclawConfigDidChange, object: nil)
                }.value
                throw failure
            },
            notificationCenter: notificationCenter))
        {
            do {
                try await self.saveLoadedDocument(["remote": true])
                Issue.record("Expected save to fail")
            } catch {
                #expect(error as NSError == failure)
            }
        }

        #expect(changeCount.value == 0)
    }

    @Test func `local save does not fall back to direct write after stale gateway rejection`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: stateDir) }

        let failure = NSError(domain: "Gateway", code: 0, userInfo: [
            NSLocalizedDescriptionKey: "config changed since last load; re-run config.get and retry",
        ])
        try await self.withOverrides(.init(
            isRemoteMode: { false },
            loadLocal: { OpenClawConfigFile.loadDict() },
            saveGateway: { _ in throw failure }), env: [
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                    "auth": [
                        "mode": "token",
                        "token": "test-token", // pragma: allowlist secret
                    ],
                ],
            ])
            let before = try String(contentsOf: configPath, encoding: .utf8)
            var didThrow = false
            do {
                try await self.saveLoadedDocument(["browser": ["enabled": false]])
            } catch {
                didThrow = true
                #expect(error as NSError == failure)
            }

            #expect(didThrow)
            let after = try String(contentsOf: configPath, encoding: .utf8)
            #expect(after == before)
        }
    }

    @Test func `local save can fall back to protected direct write when gateway is unavailable`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: stateDir) }

        try await self.withOverrides(.init(
            isRemoteMode: { false },
            loadLocal: { OpenClawConfigFile.loadDict() },
            saveGateway: { _ in
                throw NSError(domain: "Gateway", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: "gateway not configured",
                ])
            }), env: [
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            try await self.saveLoadedDocument([
                "gateway": ["mode": "local"],
                "browser": ["enabled": false],
            ])

            let data = try Data(contentsOf: configPath)
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            #expect(((root?["browser"] as? [String: Any])?["enabled"] as? Bool) == false)
            #expect((root?["meta"] as? [String: Any]) != nil)
        }
    }

    private func saveLoadedDocument(_ root: [String: Any]) async throws {
        var document = await ConfigStore.load()
        document.root = root
        try await ConfigStore.save(document)
    }

    private func withOverrides<T>(
        _ overrides: ConfigStore.Overrides,
        env: [String: String?] = [:],
        _ body: () async throws -> T) async rethrows -> T
    {
        // Overrides and document origins share process state with other suites.
        // Hold the same lease through async load/save and restore before releasing it.
        try await TestIsolation.withIsolatedState(env: env) {
            await ConfigStore._testSetOverrides(overrides)
            do {
                let result = try await body()
                await ConfigStore._testClearOverrides()
                return result
            } catch {
                await ConfigStore._testClearOverrides()
                throw error
            }
        }
    }
}

private final class NotificationCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var sawNonNilSender = false

    var value: Int {
        self.lock.withLock { self.count }
    }

    var allSendersWereNil: Bool {
        self.lock.withLock { !self.sawNonNilSender }
    }

    func record(_ notification: Notification) {
        self.lock.withLock {
            self.count += 1
            self.sawNonNilSender = self.sawNonNilSender || notification.object != nil
        }
    }
}
