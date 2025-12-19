import ClawdisKit
import Foundation
import Network
import OSLog

@MainActor
final class MacNodeModeCoordinator {
    static let shared = MacNodeModeCoordinator()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "mac-node")
    private var task: Task<Void, Never>?
    private let runtime = MacNodeRuntime()
    private let session = MacNodeBridgeSession()
    private var tunnel: RemotePortTunnel?

    func start() {
        guard self.task == nil else { return }
        self.task = Task { [weak self] in
            await self?.run()
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
        Task { await self.session.disconnect() }
        self.tunnel?.terminate()
        self.tunnel = nil
    }

    private func run() async {
        var retryDelay: UInt64 = 1_000_000_000
        var lastCameraEnabled: Bool? = nil
        let defaults = UserDefaults.standard
        while !Task.isCancelled {
            if await MainActor.run(body: { AppStateStore.shared.isPaused }) {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                continue
            }

            let cameraEnabled = defaults.object(forKey: cameraEnabledKey) as? Bool ?? false
            if lastCameraEnabled == nil {
                lastCameraEnabled = cameraEnabled
            } else if lastCameraEnabled != cameraEnabled {
                lastCameraEnabled = cameraEnabled
                await self.session.disconnect()
                try? await Task.sleep(nanoseconds: 200_000_000)
            }

            guard let endpoint = await self.resolveBridgeEndpoint(timeoutSeconds: 5) else {
                try? await Task.sleep(nanoseconds: min(retryDelay, 5_000_000_000))
                retryDelay = min(retryDelay * 2, 10_000_000_000)
                continue
            }

            retryDelay = 1_000_000_000
            do {
                try await self.session.connect(
                    endpoint: endpoint,
                    hello: self.makeHello(),
                    onConnected: { [weak self] serverName in
                        self?.logger.info("mac node connected to \(serverName, privacy: .public)")
                    },
                    onInvoke: { [weak self] req in
                        guard let self else {
                            return BridgeInvokeResponse(
                                id: req.id,
                                ok: false,
                                error: ClawdisNodeError(code: .unavailable, message: "UNAVAILABLE: node not ready"))
                        }
                        return await self.runtime.handleInvoke(req)
                    })
            } catch {
                if await self.tryPair(endpoint: endpoint, error: error) {
                    continue
                }
                self.logger.error("mac node bridge connect failed: \(error.localizedDescription, privacy: .public)")
                try? await Task.sleep(nanoseconds: min(retryDelay, 5_000_000_000))
                retryDelay = min(retryDelay * 2, 10_000_000_000)
            }
        }
    }

    private func makeHello() -> BridgeHello {
        let token = MacNodeTokenStore.loadToken()
        let caps = self.currentCaps()
        let commands = self.currentCommands(caps: caps)
        return BridgeHello(
            nodeId: Self.nodeId(),
            displayName: InstanceIdentity.displayName,
            token: token,
            platform: "macos",
            version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            deviceFamily: "Mac",
            modelIdentifier: InstanceIdentity.modelIdentifier,
            caps: caps,
            commands: commands)
    }

    private func currentCaps() -> [String] {
        var caps: [String] = [ClawdisCapability.canvas.rawValue, ClawdisCapability.screen.rawValue]
        if UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? false {
            caps.append(ClawdisCapability.camera.rawValue)
        }
        return caps
    }

    private func currentCommands(caps: [String]) -> [String] {
        var commands: [String] = [
            ClawdisCanvasCommand.show.rawValue,
            ClawdisCanvasCommand.hide.rawValue,
            ClawdisCanvasCommand.navigate.rawValue,
            ClawdisCanvasCommand.evalJS.rawValue,
            ClawdisCanvasCommand.snapshot.rawValue,
            ClawdisCanvasA2UICommand.push.rawValue,
            ClawdisCanvasA2UICommand.pushJSONL.rawValue,
            ClawdisCanvasA2UICommand.reset.rawValue,
            MacNodeScreenCommand.record.rawValue,
        ]

        let capsSet = Set(caps)
        if capsSet.contains(ClawdisCapability.camera.rawValue) {
            commands.append(ClawdisCameraCommand.snap.rawValue)
            commands.append(ClawdisCameraCommand.clip.rawValue)
        }

        return commands
    }

    private func tryPair(endpoint: NWEndpoint, error: Error) async -> Bool {
        let text = error.localizedDescription.uppercased()
        guard text.contains("NOT_PAIRED") || text.contains("UNAUTHORIZED") else { return false }

        do {
            let token = try await MacNodeBridgePairingClient().pairAndHello(
                endpoint: endpoint,
                hello: self.makeHello(),
                silent: true,
                onStatus: { [weak self] status in
                    self?.logger.info("mac node pairing: \(status, privacy: .public)")
                })
            if !token.isEmpty {
                MacNodeTokenStore.saveToken(token)
            }
            return true
        } catch {
            self.logger.error("mac node pairing failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private static func nodeId() -> String {
        "mac-\(InstanceIdentity.instanceId)"
    }

    private func resolveBridgeEndpoint(timeoutSeconds: Double) async -> NWEndpoint? {
        let mode = await MainActor.run(body: { AppStateStore.shared.connectionMode })
        if mode == .remote {
            do {
                if self.tunnel == nil || self.tunnel?.process.isRunning == false {
                    self.tunnel = try await RemotePortTunnel.create(remotePort: 18790)
                }
                if let localPort = self.tunnel?.localPort,
                   let port = NWEndpoint.Port(rawValue: localPort)
                {
                    return .hostPort(host: "127.0.0.1", port: port)
                }
            } catch {
                self.logger.error("mac node bridge tunnel failed: \(error.localizedDescription, privacy: .public)")
                self.tunnel?.terminate()
                self.tunnel = nil
            }
        } else if let tunnel = self.tunnel {
            tunnel.terminate()
            self.tunnel = nil
        }
        return await Self.discoverBridgeEndpoint(timeoutSeconds: timeoutSeconds)
    }

    private static func discoverBridgeEndpoint(timeoutSeconds: Double) async -> NWEndpoint? {
        final class DiscoveryState: @unchecked Sendable {
            let lock = NSLock()
            var resolved = false
            var browsers: [NWBrowser] = []
            var continuation: CheckedContinuation<NWEndpoint?, Never>?

            func finish(_ endpoint: NWEndpoint?) {
                lock.lock()
                defer { lock.unlock() }
                if resolved { return }
                resolved = true
                for browser in browsers {
                    browser.cancel()
                }
                continuation?.resume(returning: endpoint)
                continuation = nil
            }
        }

        return await withCheckedContinuation { cont in
            let state = DiscoveryState()
            state.continuation = cont

            let params = NWParameters.tcp
            params.includePeerToPeer = true

            for domain in ClawdisBonjour.bridgeServiceDomains {
                let browser = NWBrowser(
                    for: .bonjour(type: ClawdisBonjour.bridgeServiceType, domain: domain),
                    using: params)
                browser.browseResultsChangedHandler = { results, _ in
                    if let result = results.first(where: { if case .service = $0.endpoint { true } else { false } }) {
                        state.finish(result.endpoint)
                    }
                }
                browser.stateUpdateHandler = { browserState in
                    if case .failed = browserState {
                        state.finish(nil)
                    }
                }
                state.browsers.append(browser)
                browser.start(queue: DispatchQueue(label: "com.steipete.clawdis.macos.bridge-discovery.\(domain)"))
            }

            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                state.finish(nil)
            }
        }
    }
}

enum MacNodeTokenStore {
    private static let suiteName = "com.steipete.clawdis.shared"
    private static let tokenKey = "mac.node.bridge.token"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    static func loadToken() -> String? {
        let raw = defaults.string(forKey: tokenKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return raw?.isEmpty == false ? raw : nil
    }

    static func saveToken(_ token: String) {
        defaults.set(token, forKey: tokenKey)
    }
}
