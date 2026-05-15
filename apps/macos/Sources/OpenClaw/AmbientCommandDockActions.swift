import AppKit
import Foundation

struct AmbientCommandDockActionEnvironment {
    var setIntensity: @MainActor (Double) -> Void
    var setDisplayScope: @MainActor (AmbientOverlayDisplayScope) -> Void
    var setAmbientEnabled: @MainActor (Bool) -> Void
    var dismiss: @MainActor () -> Void
    var openCanvas: @MainActor () async -> AmbientCommandResult
    var openChat: @MainActor () async -> AmbientCommandResult
    var openSettings: @MainActor (SettingsTab) -> Void
    var openLogs: @MainActor () -> Void
    var openConfig: @MainActor () -> Void
    var openSessionStore: @MainActor () -> Void
    var openAgentEvents: @MainActor () -> Void
    var restartGateway: @MainActor () -> Void
    var resetGatewayTunnel: @MainActor () async -> AmbientCommandResult
    var runHealthCheck: @MainActor () async -> AmbientCommandResult
    var toggleTalk: @MainActor () async -> AmbientCommandResult
    var toggleVoiceWake: @MainActor () async -> AmbientCommandResult
    var toggleCamera: @MainActor () -> AmbientCommandResult
    var toggleBrowser: @MainActor () -> AmbientCommandResult
    var sendPrompt: @MainActor (String) async -> AmbientCommandResult

    static var live: AmbientCommandDockActionEnvironment {
        AmbientCommandDockActionEnvironment(
            setIntensity: { percent in
                AppStateStore.shared.ambientOverlayIntensity = percent / 100.0
            },
            setDisplayScope: { scope in
                AppStateStore.shared.ambientOverlayDisplayScope = scope
            },
            setAmbientEnabled: { enabled in
                AppStateStore.shared.ambientOverlayEnabled = enabled
            },
            dismiss: {
                AmbientOverlayExperienceController.shared.dismissInteractive(reason: .closeButton)
            },
            openCanvas: {
                let sessionKey = await GatewayConnection.shared.mainSessionKey()
                do {
                    _ = try CanvasManager.shared.show(sessionKey: sessionKey, path: nil)
                    return .success("Canvas opened")
                } catch {
                    return .failure(error.localizedDescription)
                }
            },
            openChat: {
                let sessionKey = await WebChatManager.shared.preferredSessionKey()
                WebChatManager.shared.show(sessionKey: sessionKey)
                return .success("Chat opened")
            },
            openSettings: { tab in
                SettingsTabRouter.request(tab)
                SettingsWindowOpener.shared.open()
            },
            openLogs: {
                DebugActions.openLog()
            },
            openConfig: {
                DebugActions.openConfigFolder()
            },
            openSessionStore: {
                DebugActions.openSessionStore()
            },
            openAgentEvents: {
                DebugActions.openAgentEventsWindow()
            },
            restartGateway: {
                DebugActions.restartGateway()
            },
            resetGatewayTunnel: {
                switch await DebugActions.resetGatewayTunnel() {
                case let .success(message):
                    return .success(message)
                case let .failure(error):
                    return .failure(error.localizedDescription)
                }
            },
            runHealthCheck: {
                await DebugActions.runHealthCheckNow()
                return .success("Health check requested")
            },
            toggleTalk: {
                let next = !AppStateStore.shared.talkEnabled
                await AppStateStore.shared.setTalkEnabled(next)
                return .success(next ? "Talk Mode enabled" : "Talk Mode disabled")
            },
            toggleVoiceWake: {
                let next = !AppStateStore.shared.swabbleEnabled
                await AppStateStore.shared.setVoiceWakeEnabled(next)
                return .success(next ? "Voice Wake enabled" : "Voice Wake disabled")
            },
            toggleCamera: {
                let current = UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? false
                let next = !current
                UserDefaults.standard.set(next, forKey: cameraEnabledKey)
                return .success(next ? "Camera access enabled" : "Camera access disabled")
            },
            toggleBrowser: {
                let next = !OpenClawConfigFile.browserControlEnabled()
                OpenClawConfigFile.setBrowserControlEnabled(next)
                return .success(next ? "Browser control enabled" : "Browser control disabled")
            },
            sendPrompt: { prompt in
                await Self.sendPromptToGateway(prompt)
            })
    }

    static func testing(
        sendPrompt: @escaping @MainActor (String) async -> AmbientCommandResult = { _ in .success("Sent to Thomas") })
        -> AmbientCommandDockActionEnvironment
    {
        AmbientCommandDockActionEnvironment(
            setIntensity: { _ in },
            setDisplayScope: { _ in },
            setAmbientEnabled: { _ in },
            dismiss: {},
            openCanvas: { .success("Canvas opened") },
            openChat: { .success("Chat opened") },
            openSettings: { _ in },
            openLogs: {},
            openConfig: {},
            openSessionStore: {},
            openAgentEvents: {},
            restartGateway: {},
            resetGatewayTunnel: { .success("SSH tunnel reset.") },
            runHealthCheck: { .success("Health check requested") },
            toggleTalk: { .success("Talk Mode enabled") },
            toggleVoiceWake: { .success("Voice Wake enabled") },
            toggleCamera: { .success("Camera access enabled") },
            toggleBrowser: { .success("Browser control enabled") },
            sendPrompt: sendPrompt)
    }

    private static func sendPromptToGateway(_ prompt: String) async -> AmbientCommandResult {
        let options = await VoiceWakeForwarder.selectedSessionOptions()
        let deliver = options.channel.shouldDeliver(options.deliver)
        let result = await GatewayConnection.shared.sendAgent(GatewayAgentInvocation(
            message: prompt,
            sessionKey: options.sessionKey,
            thinking: options.thinking,
            deliver: deliver,
            to: options.to,
            channel: options.channel,
            voiceWakeTrigger: nil))

        if result.ok {
            return .success("Sent to Thomas")
        }
        return .failure(result.error ?? "agent rpc unavailable")
    }
}

struct AmbientCommandDockActionExecutor {
    var registry: AmbientCommandRegistry = .default
    var environment: AmbientCommandDockActionEnvironment = .live

    @MainActor
    func execute(name rawName: String, arguments: String) async -> AmbientCommandResult {
        let name = self.registry.command(named: rawName)?.name ?? rawName
        let args = arguments.trimmingCharacters(in: .whitespacesAndNewlines)

        switch name {
        case "help":
            return .info(self.helpText())
        case "clear":
            return .success("Cleared")
        case "dismiss":
            self.environment.dismiss()
            return .success("Dismissed")
        case "status":
            return .info("Use /health for a fresh check, /logs for diagnostics, or /restart-gateway if the gateway is stuck.")
        case "canvas":
            return await self.environment.openCanvas()
        case "chat", "main", "new":
            return await self.environment.openChat()
        case "dashboard":
            self.environment.openSettings(.general)
            return .success("Dashboard settings opened")
        case "settings":
            self.environment.openSettings(.general)
            return .success("Settings opened")
        case "agent-events", "actions":
            self.environment.openAgentEvents()
            return .success("Agent Events opened")
        case "talk":
            return await self.environment.toggleTalk()
        case "voice-wake":
            return await self.environment.toggleVoiceWake()
        case "mic":
            self.environment.openSettings(.voiceWake)
            return .success("Voice Wake settings opened")
        case "health":
            return await self.environment.runHealthCheck()
        case "restart-gateway":
            self.environment.restartGateway()
            return .success("Gateway restart requested")
        case "reset-tunnel":
            return await self.environment.resetGatewayTunnel()
        case "logs":
            self.environment.openLogs()
            return .success("Logs opened")
        case "config":
            self.environment.openConfig()
            return .success("Config folder opened")
        case "session-store":
            self.environment.openSessionStore()
            return .success("Session store opened")
        case "sessions", "compact", "reset-session":
            self.environment.openSettings(.sessions)
            return .success("Session settings opened")
        case "approvals":
            self.environment.openSettings(.permissions)
            return .success("Approval settings opened")
        case "browser":
            return self.environment.toggleBrowser()
        case "camera":
            return self.environment.toggleCamera()
        case "ambient":
            return self.setAmbient(args)
        case "display":
            return self.setDisplay(args)
        case "intensity":
            return self.setIntensity(args)
        case "cron":
            self.environment.openSettings(.cron)
            return .success("Cron settings opened")
        case "skills":
            self.environment.openSettings(.skills)
            return .success("Skills settings opened")
        case "nodes":
            self.environment.openSettings(.instances)
            return .success("Instances settings opened")
        default:
            return .failure("Command /\(name) is not wired yet")
        }
    }

    @MainActor
    func sendPrompt(_ prompt: String) async -> AmbientCommandResult {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .none }
        return await self.environment.sendPrompt(trimmed)
    }

    private func helpText() -> String {
        let names = self.registry.commands.map(\.displayName).joined(separator: "  ")
        return "Commands: \(names)"
    }

    @MainActor
    private func setIntensity(_ args: String) -> AmbientCommandResult {
        guard let value = Double(args), (10...100).contains(value) else {
            return .failure("Usage: /intensity 10-100")
        }
        self.environment.setIntensity(value)
        return .success("Ambient intensity set to \(Int(value.rounded()))%")
    }

    @MainActor
    private func setDisplay(_ args: String) -> AmbientCommandResult {
        switch args.lowercased() {
        case "current", "one", "1":
            self.environment.setDisplayScope(.currentDisplay)
            return .success("Ambient display set to current display")
        case "all", "every", "all-displays":
            self.environment.setDisplayScope(.allDisplays)
            return .success("Ambient display set to all displays")
        default:
            return .failure("Usage: /display current|all")
        }
    }

    @MainActor
    private func setAmbient(_ args: String) -> AmbientCommandResult {
        switch args.lowercased() {
        case "on", "enable", "enabled":
            self.environment.setAmbientEnabled(true)
            return .success("Ambient Overlay enabled")
        case "off", "disable", "disabled":
            self.environment.setAmbientEnabled(false)
            return .success("Ambient Overlay disabled")
        case "":
            let next = !AppStateStore.shared.ambientOverlayEnabled
            self.environment.setAmbientEnabled(next)
            return .success(next ? "Ambient Overlay enabled" : "Ambient Overlay disabled")
        default:
            return .failure("Usage: /ambient on|off")
        }
    }
}
