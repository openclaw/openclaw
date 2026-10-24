import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct BrowserControlSettingTests {
    /// Config with Gateway-style compare-and-swap: a save based on an older read is rejected.
    @MainActor
    final class RevisionedConfig {
        var enabled: Bool
        var revision = 0
        var holdReads = false
        var holdWrites = false
        var held: [CheckedContinuation<Void, Never>] = []

        init(enabled: Bool) {
            self.enabled = enabled
        }

        func read() async -> [String: Any] {
            let root: [String: Any] = ["browser": ["enabled": self.enabled], "revision": self.revision]
            if self.holdReads { await withCheckedContinuation { self.held.append($0) } }
            return root
        }

        func write(_ root: [String: Any]) async throws {
            if self.holdWrites { await withCheckedContinuation { self.held.append($0) } }
            guard root["revision"] as? Int == self.revision else {
                throw NSError(domain: "ConfigStore", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "config changed since last load; re-run config.get and retry",
                ])
            }
            self.revision += 1
            self.enabled = (root["browser"] as? [String: Any])?["enabled"] as? Bool ?? true
        }

        func release() {
            self.holdReads = false
            self.holdWrites = false
            let held = self.held
            self.held = []
            held.forEach { $0.resume() }
        }
    }

    @Test func `overlapping clicks persist and show the newest choice`() async throws {
        let config = RevisionedConfig(enabled: true)
        try await self.withConfig(config) {
            let setting = BrowserControlSetting()
            await setting.load()
            config.holdWrites = true

            // AppKit can deliver queued clicks in one turn, before any save has started.
            setting.toggle()
            setting.toggle()
            try await self.waitUntil { config.held.count == 1 }
            setting.toggle()
            setting.toggle()
            // Give a second, independent save the chance to read the same revision.
            for _ in 0..<50 {
                await Task.yield()
            }
            #expect(config.held.count == 1)
            config.release()

            try await self.waitUntil { config.revision == 2 }
            #expect(config.enabled)
            #expect(setting.enabled)
        }
    }

    @Test func `a read in flight when the user clicks does not undo the click`() async throws {
        let config = RevisionedConfig(enabled: true)
        try await self.withConfig(config) {
            let setting = BrowserControlSetting()
            config.holdReads = true
            // A connection-mode reload has read the pre-click value but not published it yet.
            let reload = Task { await setting.load() }
            try await self.waitUntil { config.held.count == 1 }

            setting.toggle()
            config.release()
            await reload.value

            try await self.waitUntil { config.revision == 1 }
            #expect(!config.enabled)
            #expect(!setting.enabled)
        }
    }

    private func withConfig(_ config: RevisionedConfig, _ body: () async throws -> Void) async throws {
        // ConfigStore overrides are process-wide; hold the shared lease as ConfigStoreTests does.
        try await TestIsolation.withIsolatedState {
            await ConfigStore._testSetOverrides(.init(
                isRemoteMode: { true },
                loadRemote: { await config.read() },
                saveRemote: { try await config.write($0) }))
            do {
                try await body()
            } catch {
                await ConfigStore._testClearOverrides()
                throw error
            }
            await ConfigStore._testClearOverrides()
        }
    }

    private func waitUntil(
        sourceLocation: SourceLocation = #_sourceLocation,
        _ condition: () -> Bool) async throws
    {
        for _ in 0..<400 where !condition() {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        #expect(condition(), sourceLocation: sourceLocation)
    }
}
