import AppKit
import Foundation
import OpenClawChatUI
import Security
import Testing
import XCTest
@testable import OpenClaw

@MainActor
struct AppStateIsolationTests {
    @Test
    func `automatic recovery preserves a named profile port ownership failure`() async throws {
        try #require(AppProfile.current.isActive)
        let configPath = TestIsolation.tempConfigPath()
        let marker = URL(fileURLWithPath: configPath + ".disable-launchagent")
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8).write(to: URL(fileURLWithPath: configPath))
        try Data().write(to: marker)
        defer {
            try? FileManager.default.removeItem(atPath: configPath)
            try? FileManager.default.removeItem(at: marker)
        }
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath, "OPENCLAW_GATEWAY_PORT": nil],
            defaults: [connectionModeKey: "local"])
        {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .local
            let manager = GatewayProcessManager()
            let connection = GatewayConnection(testEndpointProvider: { throw CancellationError() })
            manager.setTestingConnection(connection)
            manager.setTestingSkipControlChannelRefresh(true)
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(#"{"ok":true,"service":{"loaded":false}}"#)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                manager.setTestingDesiredActive(false)
                state.connectionMode = previousMode
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }

            let port = GatewayEnvironment.gatewayPort()
            await PortGuardian.shared.setTestingDescriptor(
                .init(pid: 4242, command: "external-gateway", executablePath: "/tmp/external-gateway"),
                forPort: port)
            #expect(await manager._testAttachExistingGatewayIfAvailable(port: port))
            let failure = manager.lastFailureReason ?? ""
            #expect(failure.contains("already owned by another process"))
            let endpointState = await GatewayEndpointStore.shared.currentState()
            let revision = GatewayEndpointStore.shared.routeRevision
            #expect(endpointState == .unavailable(mode: .local, reason: failure, routeRevision: revision))
            let failureLog = manager.log
            let daemonCalls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()

            for _ in 0..<3 {
                manager.setActive(true, source: .recovery)
                #expect(manager.status == .failed(failure))
                await manager.waitForStartupAttempt()
                #expect(manager.log == failureLog)
                #expect(await GatewayEndpointStore.shared.currentState() == endpointState)
                #expect(GatewayEndpointStore.shared.routeRevision == revision)
                #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot() == daemonCalls)
            }

            // An explicit retry still starts a fresh ownership check; it cannot adopt the rejected listener.
            manager.setActive(true)
            #expect(manager.status == .starting)
            await manager.waitForStartupAttempt()
            #expect(manager.status == .failed(failure))
            #expect(manager.log != failureLog)
            #expect(!GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().contains { $0.first == "install" })

            manager.setTestingDesiredActive(false)
            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            await GatewayEndpointStore.shared.setLocalUnavailableReason(nil)
        }
    }

    @Test
    func `named profile hosting repair requires restart before activation`() async throws {
        try #require(AppProfile.current.isActive)
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath, "OPENCLAW_GATEWAY_PORT": nil],
            defaults: ["gatewayPort": nil, hostsLocalGatewayWithRemotePrimaryKey: false])
        {
            let reservedPort = GatewayEnvironment.gatewayPort()
            #expect(OpenClawConfigFile.saveDict(["gateway": [
                "mode": "remote", "port": reservedPort,
                "remote": [
                    "transport": "ssh",
                    "sshTarget": "operator@gateway.example",
                    "url": "ws://127.0.0.1:\(reservedPort)",
                    "remotePort": 18789,
                ],
            ]]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()
            for _ in 0..<2 {
                do {
                    try state.setHostsLocalGatewayWithRemotePrimary(true)
                    Issue.record("A reserved port change must require a restart")
                } catch PrimaryGatewayControlError.localHostingRequiresRestart {}
                #expect(!state.hostsLocalGatewayWithRemotePrimary)
                #expect(state.localGatewayHostingNotice == nil)
            }
            let root = OpenClawConfigFile.loadDict()
            #expect(OpenClawConfigFile.gatewayPort(root: root) != reservedPort)
            #expect(RemotePortTunnel.localPort(root: root) == reservedPort)
        }
    }

    @Test
    func `preview constructor uses launch namespace and owned config`() async throws {
        // Fail before touching defaults when the bundle was launched without its resource owner.
        let profile = try #require(AppProfile.current.name)
        try #require(profile.hasPrefix("test-"))
        let suiteName = try #require(AppProfile.current.defaultsSuiteName)
        let fm = FileManager()
        let home = try #require(OpenClawEnv.path("HOME"))
        // Check the platform's actual default before any fixture or catalog writes.
        // A profile name alone cannot keep Security away from an operator's Keychain.
        var defaultKeychain: SecKeychain?
        try #require(SecKeychainCopyDefault(&defaultKeychain) == errSecSuccess)
        let keychain = try #require(defaultKeychain)
        var pathBytes = [CChar](repeating: 0, count: 4096)
        var pathLength = UInt32(pathBytes.count)
        try #require(SecKeychainGetPath(keychain, &pathLength, &pathBytes) == errSecSuccess)
        let keychainPath = try #require(String(
            bytes: pathBytes.prefix(Int(pathLength)).map { UInt8(bitPattern: $0) },
            encoding: .utf8))
        let keychainURL = URL(fileURLWithPath: keychainPath).resolvingSymlinksInPath()
        try #require(keychainURL.deletingLastPathComponent().path ==
            URL(fileURLWithPath: home).appendingPathComponent("Library/Keychains").resolvingSymlinksInPath().path)
        let fixture = fm.temporaryDirectory.appendingPathComponent("app-state-\(UUID().uuidString)")
        try fm.createDirectory(at: fixture, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: fixture) }
        let configURL = fixture.appendingPathComponent("openclaw.json")
        let seededKeys = [
            iconAnimationsEnabledKey,
            showDockIconKey,
            talkPhaseSoundsEnabledKey,
            talkShiftToStopEnabledKey,
            heartbeatsEnabledKey,
            iconOverrideKey,
        ]
        var defaults = Dictionary(uniqueKeysWithValues: seededKeys.map { ($0, nil as Any?) })
        defaults[swabbleEnabledKey] = false
        defaults[talkEnabledKey] = false
        defaults[talkRealtimeRelayEnabledKey] = true

        let launchState = try await TestIsolation.withEnvValues([:]) {
            let home = try #require(OpenClawEnv.path("HOME"))
            #expect(OpenClawEnv.path("CFFIXED_USER_HOME") == home)
            let root = URL(fileURLWithPath: home).deletingLastPathComponent()
            #expect(fm.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path ==
                URL(fileURLWithPath: home).resolvingSymlinksInPath().path)
            // Foundation uses Darwin's per-user temp directory independently of TMPDIR.
            // Fixtures there remain test-owned on the disposable worker.
            let tmp = try #require(OpenClawEnv.path("TMPDIR"))
            #expect(URL(fileURLWithPath: tmp).resolvingSymlinksInPath().path ==
                root.appendingPathComponent("tmp").resolvingSymlinksInPath().path)
            #expect(OpenClawPaths.stateDirURL == root.appendingPathComponent("state", isDirectory: true))
            #expect(OpenClawPaths.configURL == OpenClawPaths.stateDirURL.appendingPathComponent("openclaw.json"))
            return OpenClawPaths.stateDirURL
        }

        let fixtureState = try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configURL.path],
            defaults: defaults)
        {
            let preferences = try #require(UserDefaults(suiteName: suiteName))
            // Other tests may already have constructed AppState. Remove only these keys
            // under the cooperative lock instead of assuming this test runs first.
            for key in seededKeys {
                #expect(preferences.object(forKey: key) == nil)
            }
            #expect(!fm.fileExists(atPath: configURL.path))
            let absent = AppState(preview: true)
            #expect(absent.iconAnimationsEnabled)
            #expect(absent.showDockIcon)
            #expect(absent.talkPhaseSoundsEnabled)
            #expect(absent.talkShiftToStopEnabled)
            #expect(absent.heartbeatsEnabled)
            #expect(absent.iconOverride == .system)
            #expect(absent.talkRealtimeRelayEnabled)
            for key in seededKeys.dropLast() {
                #expect(preferences.object(forKey: key) as? Bool == true)
            }
            #expect(preferences.string(forKey: iconOverrideKey) == IconOverrideSelection.system.rawValue)
            #expect(!fm.fileExists(atPath: configURL.path))

            let stateDirectory = OpenClawPaths.stateDirURL
            #expect(stateDirectory != launchState)
            #expect(stateDirectory.path.hasPrefix(fm.temporaryDirectory.path))
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://fixture.example.invalid:9443",
                    ],
                ],
            ]))
            preferences.set(false, forKey: showDockIconKey)
            let configured = AppState(preview: true)
            #expect(!configured.showDockIcon)
            #expect(configured.connectionMode == .remote)
            #expect(configured.remoteTransport == .direct)
            #expect(configured.remoteUrl == "wss://fixture.example.invalid:9443")
            #expect(AppProfile.current.name == profile)

            // Catalog reads commit legacy migration through SecItemAdd on a fresh Keychain.
            let catalog = try await MacGatewayProfileStore().catalogProfiles()
            #expect(catalog.count == 1)
            let migrated = try #require(catalog.first)
            #expect(migrated.profile.url.absoluteString == "wss://fixture.example.invalid:9443/")
            #expect(!migrated.canPromote)
            // A fresh store must read the committed registry, not the first actor's cache.
            #expect(try await MacGatewayProfileStore().catalogProfiles() == catalog)

            // Preview still reads config; malformed input must keep its snapshot and audit in owned paths.
            try Data("{ invalid fixture".utf8).write(to: configURL)
            _ = AppState(preview: true)
            let auditURL = stateDirectory.appendingPathComponent("logs/config-audit.jsonl")
            let audit = try String(contentsOf: auditURL, encoding: .utf8)
            #expect(audit.contains("config.write"))
            #expect(audit.contains("config.observe"))
            #expect(try fm.contentsOfDirectory(atPath: fixture.path).contains {
                $0.hasPrefix("openclaw.json.clobbered.")
            })
            return stateDirectory
        }
        #expect(!fm.fileExists(atPath: fixtureState.path))
        await TestIsolation.withEnvValues([:]) {
            #expect(OpenClawPaths.stateDirURL == launchState)
            #expect(fm.fileExists(atPath: launchState.path))
        }
    }

    @Test
    func `config fixture cleans audit after throwing body`() async throws {
        enum FixtureError: Error {
            case expected
        }
        let fm = FileManager()
        let configPath = TestIsolation.tempConfigPath()
        defer { try? fm.removeItem(atPath: configPath) }
        var fixtureState: URL?
        do {
            try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
                fixtureState = OpenClawPaths.stateDirURL
                #expect(OpenClawConfigFile.saveDict(["gateway": ["mode": "local"]]))
                await Task.yield()
                #expect(fm.fileExists(atPath: OpenClawPaths.stateDirURL
                        .appendingPathComponent("logs/config-audit.jsonl").path))
                throw FixtureError.expected
            }
        } catch FixtureError.expected {}
        let removed = try #require(fixtureState)
        #expect(!fm.fileExists(atPath: removed.path))
    }
}

@MainActor
final class ProfileChatPreferencesTests: XCTestCase {
    func testFullChatPreferencesBelongToNamedProfile() async throws {
        let profile = try XCTUnwrap(AppProfile.current.name)
        try #require(profile.hasPrefix("test-"))
        let favoritesKey = "openclaw.chat.modelFavorites"
        let recentsKey = "openclaw.chat.modelRecents"
        let reasoningKey = OpenClawChatWindowShell.assistantReasoningDefaultsKey
        let toolActivityKey = OpenClawChatWindowShell.assistantToolActivityDefaultsKey
        let autosaveName = "ProfileChatPreferences-\(UUID().uuidString)"
        try await TestIsolation.withIsolatedState(defaults: [
            favoritesKey: ["fixture/profile"],
            recentsKey: [String](),
            reasoningKey: true,
            toolActivityKey: true,
        ]) {
            let defaultDefaults = UserDefaults.standard
            let originalValues = [
                favoritesKey, recentsKey, reasoningKey, toolActivityKey, "NSWindow Frame \(autosaveName)",
            ].map {
                ($0, defaultDefaults.object(forKey: $0))
            }
            defer {
                for (key, value) in originalValues {
                    if let value {
                        defaultDefaults.set(value, forKey: key)
                    } else {
                        defaultDefaults.removeObject(forKey: key)
                    }
                }
            }
            defaultDefaults.set(["fixture/default"], forKey: favoritesKey)
            defaultDefaults.set(["fixture/default"], forKey: recentsKey)
            defaultDefaults.set(true, forKey: reasoningKey)
            defaultDefaults.set(true, forKey: toolActivityKey)

            _ = AppKitTestSupport.application
            XCTAssertTrue(AppKitTestSupport.didSetActivationPolicy)
            let transport = ProfileModelPickerTransport()
            let controller = WebChatSwiftUIWindowController(
                sessionKey: ProfileModelPickerTransport.sessionKey,
                transport: transport,
                windowTitle: "Profile chat preferences fixture",
                windowAutosaveName: autosaveName)
            defer { controller.close() }
            controller.show()
            let window = try XCTUnwrap(controller._testWindow)
            for (title, key, otherTitle, otherKey, otherEnabled) in [
                ("Show Reasoning", reasoningKey, "Show Tool Activity", toolActivityKey, true),
                ("Show Tool Activity", toolActivityKey, "Show Reasoning", reasoningKey, false),
            ] {
                let threadButton = try await self.threadMenuButton(in: window)
                var previousStates: [NSControl.StateValue] = []
                try await AppKitTestSupport.openMenu(threadButton, in: window) { menu in
                    let index = try XCTUnwrap(menu.items.firstIndex { $0.title == title })
                    let other = try XCTUnwrap(menu.items.first { $0.title == otherTitle })
                    try #require(menu.items[index].isEnabled)
                    previousStates = [menu.items[index].state, other.state]
                    menu.performActionForItem(at: index)
                }
                XCTAssertEqual(previousStates, [.on, otherEnabled ? .on : .off])
                XCTAssertEqual(AppDefaults.standard.object(forKey: key) as? Bool, false)
                XCTAssertEqual(AppDefaults.standard.object(forKey: otherKey) as? Bool, otherEnabled)
                XCTAssertEqual(defaultDefaults.object(forKey: reasoningKey) as? Bool, true)
                XCTAssertEqual(defaultDefaults.object(forKey: toolActivityKey) as? Bool, true)
                let reopenedStates = try await self.threadPreferenceStates(
                    in: window,
                    captureName: key == reasoningKey ? "thread-reasoning" : "thread-tool-activity")
                XCTAssertEqual(reopenedStates, [.off, key == reasoningKey ? .on : .off])
            }

            let button = try await self.loadedModelMenuButton(in: window, selection: "profile")
            var initiallyPinned = false
            var modelCaptureError: Error?
            try await AppKitTestSupport.openMenu(button, in: window) { menu in
                initiallyPinned = menu.items.contains { $0.title == "Unpin model" }
                let index = try XCTUnwrap(menu.items.firstIndex { $0.title == "fixture/fresh" })
                try #require(menu.items[index].isEnabled)
                // Capture errors must not skip the preference actions and assertions.
                do {
                    try AppKitTestSupport.record(
                        menu: menu, content: window.contentView, name: "model-initial")
                } catch {
                    modelCaptureError = error
                }
                menu.performActionForItem(at: index)
            }
            XCTAssertNil(modelCaptureError)
            XCTAssertTrue(initiallyPinned)

            // Wait for the accepted selection in either domain so the baseline reaches the ownership assertions.
            let selectedButton = try await self.loadedModelMenuButton(in: window, selection: "fresh") {
                [AppDefaults.standard, defaultDefaults].contains {
                    $0.stringArray(forKey: recentsKey)?.first == "fixture/fresh"
                }
            }
            let selectedModels = await transport.selectedModels
            XCTAssertEqual(selectedModels, ["fixture/fresh"])
            XCTAssertEqual(AppDefaults.standard.stringArray(forKey: recentsKey), ["fixture/fresh"])
            XCTAssertEqual(defaultDefaults.stringArray(forKey: recentsKey), ["fixture/default"])
            try await AppKitTestSupport.openMenu(selectedButton, in: window) { menu in
                let index = try XCTUnwrap(menu.items.firstIndex { $0.title == "Pin model" })
                try #require(menu.items[index].isEnabled)
                menu.performActionForItem(at: index)
            }
            XCTAssertEqual(AppDefaults.standard.stringArray(forKey: favoritesKey), ["fixture/profile", "fixture/fresh"])
            XCTAssertEqual(defaultDefaults.stringArray(forKey: favoritesKey), ["fixture/default"])

            controller.close()
            let reopened = WebChatSwiftUIWindowController(
                sessionKey: ProfileModelPickerTransport.sessionKey,
                transport: transport,
                windowTitle: "Profile chat preferences fixture",
                windowAutosaveName: autosaveName)
            defer { reopened.close() }
            reopened.show()
            let reopenedWindow = try XCTUnwrap(reopened._testWindow)
            let reopenedButton = try await self.loadedModelMenuButton(in: reopenedWindow, selection: "fresh")
            var restoredPin = false
            try await AppKitTestSupport.openMenu(reopenedButton, in: reopenedWindow) { menu in
                restoredPin = menu.items.contains { $0.title == "Unpin model" }
            }
            XCTAssertTrue(restoredPin)
            XCTAssertEqual(AppDefaults.standard.stringArray(forKey: recentsKey), ["fixture/fresh"])
            XCTAssertEqual(defaultDefaults.stringArray(forKey: recentsKey), ["fixture/default"])
            let restoredThreadStates = try await self.threadPreferenceStates(
                in: reopenedWindow, captureName: "thread-restored")
            XCTAssertEqual(restoredThreadStates, [.off, .off])
            XCTAssertEqual(defaultDefaults.object(forKey: reasoningKey) as? Bool, true)
            XCTAssertEqual(defaultDefaults.object(forKey: toolActivityKey) as? Bool, true)
        }
    }

    private func threadMenuButton(in window: NSWindow) async throws -> AnyObject {
        try await AppKitTestSupport.waitForAccessibilityElement(in: window, description: "Thread menu") { elements in
            elements.first {
                let role = $0.accessibilityRole?()
                let names: [String?] = [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)]
                return (role == .button || role == .popUpButton || role == .menuButton) &&
                    (names.contains("Thread") || names.contains("More"))
            }
        }
    }

    private func threadPreferenceStates(
        in window: NSWindow,
        captureName: String) async throws -> [NSControl.StateValue]
    {
        let button = try await self.threadMenuButton(in: window)
        var states: [NSControl.StateValue] = []
        try await AppKitTestSupport.openMenu(button, in: window) { menu in
            states = try ["Show Reasoning", "Show Tool Activity"].map { title in
                let item = try XCTUnwrap(menu.items.first { $0.title == title })
                return item.state
            }
            try AppKitTestSupport.record(menu: menu, content: window.contentView, name: captureName)
        }
        return states
    }

    private func loadedModelMenuButton(
        in window: NSWindow,
        selection: String,
        when ready: () -> Bool = { true }) async throws -> AnyObject
    {
        try await AppKitTestSupport.waitForAccessibilityElement(
            in: window,
            description: "loaded Model menu for \(selection)")
        { elements in
            let loaded = elements.contains {
                let value: Any? = $0.accessibilityValue?()
                return [$0.accessibilityLabel?(), value as? String]
                    .contains("What would you like to work on?")
            }
            guard loaded, ready() else { return nil }
            return elements.first {
                let value: Any? = $0.accessibilityValue?()
                return $0.accessibilityIdentifier?() == "chat-composer-inline-model" &&
                    AppKitTestSupport.accessibilityName(of: $0) == "Model" && value as? String == selection
            }
        }
    }
}

private actor ProfileModelPickerTransport: OpenClawChatTransport {
    static let sessionKey = "agent:fixture:main"
    private var model = "fixture/profile"
    private(set) var selectedModels: [String] = []

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data("""
        {"sessionKey":"\(sessionKey)","messages":[],"thinkingLevel":"off"}
        """.utf8))
    }

    func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data("""
        {"sessions":[{"key":"\(Self.sessionKey)","model":"\(self.model)"}]}
        """.utf8))
    }

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
        ["profile", "default", "fresh"].map {
            OpenClawChatModelChoice(modelID: $0, name: $0, provider: "fixture", available: true, contextWindow: nil)
        }
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        guard sessionKey == Self.sessionKey, let model else {
            throw NSError(domain: "ProfileModelPickerTransport", code: 1)
        }
        self.model = model
        self.selectedModels.append(model)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw NSError(domain: "ProfileModelPickerTransport", code: 2)
    }
}
