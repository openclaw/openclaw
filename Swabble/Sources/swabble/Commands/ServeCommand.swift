import Commander
import Foundation
import Swabble
import SwabbleKit

@available(macOS 26.0, *)
@MainActor
struct ServeCommand: ParsableCommand {
    @Option(name: .long("config"), help: "Path to config JSON") var configPath: String?
    @Flag(name: .long("no-wake"), help: "Disable wake word") var noWake: Bool = false
    @Option(name: .long("log-format"), help: "Log format text|json") var logFormat: String?
    @Option(name: .long("log-level"), help: "Log level trace|debug|info|warn|error") var logLevel: String?
    @Flag(name: .long("redact-pii"), help: "Enable PII redaction") var redactPii: Bool = false
    @Flag(name: .long("no-redact-pii"), help: "Disable PII redaction") var noRedactPii: Bool = false

    static var commandDescription: CommandDescription {
        CommandDescription(
            commandName: "serve",
            abstract: "Run swabble in the foreground")
    }

    init() {}

    init(parsed: ParsedValues) {
        self.init()
        if parsed.flags.contains("noWake") || parsed.flags.contains("no-wake") { noWake = true }
        if let cfg = parsed.options["config"]?.last { configPath = cfg }
        if let format = parsed.options["logFormat"]?.last ?? parsed.options["log-format"]?.last { logFormat = format }
        if let level = parsed.options["logLevel"]?.last ?? parsed.options["log-level"]?.last { logLevel = level }
        if parsed.flags.contains("redactPii") || parsed.flags.contains("redact-pii") { redactPii = true }
        if parsed.flags.contains("noRedactPii") || parsed.flags.contains("no-redact-pii") { noRedactPii = true }
    }

    mutating func run() async throws {
        var loadedConfig: SwabbleConfig
        do {
            loadedConfig = try ConfigLoader.load(at: configURL)
        } catch {
            loadedConfig = SwabbleConfig()
            try ConfigLoader.save(loadedConfig, at: configURL)
        }

        let forceNoWake = noWake
        let overrideLogFormat = logFormat
        let overrideLogLevel = logLevel
        let forceRedactPii = redactPii
        let forceNoRedactPii = noRedactPii
        let configURL = self.configURL

        let initialConfig = Self.applyRuntimeOverrides(
            to: loadedConfig,
            forceNoWake: forceNoWake,
            overrideLogFormat: overrideLogFormat,
            overrideLogLevel: overrideLogLevel,
            forceRedactPii: forceRedactPii,
            forceNoRedactPii: forceNoRedactPii)

        let runtimeState = ServeRuntimeConfigState(config: initialConfig)
        let executor = HookExecutor(config: initialConfig)

        let startupLogger = Self.makeLogger(from: initialConfig)
        await RuntimeStatusStore.shared.bootstrap(
            config: initialConfig,
            currentAudioDevice: describeAudioDevice(from: initialConfig))

        startupLogger.info(
            event: "serve.start",
            message: "swabble serve starting",
            fields: [
                "wakeEnabled": .bool(initialConfig.wake.enabled),
                "wakeWord": .string(initialConfig.wake.word),
                "logLevel": .string(initialConfig.logging.level),
                "logFormat": .string(initialConfig.logging.format),
                "redactPii": .bool(initialConfig.logging.redactPii)
            ])

        let controlServer = ControlSocketServer(socketURL: SwabbleRuntimePaths.controlSocketURL) { request in
            await Self.handleControlRequest(
                request,
                configURL: configURL,
                runtimeState: runtimeState,
                executor: executor,
                forceNoWake: forceNoWake,
                overrideLogFormat: overrideLogFormat,
                overrideLogLevel: overrideLogLevel,
                forceRedactPii: forceRedactPii,
                forceNoRedactPii: forceNoRedactPii)
        }

        do {
            try controlServer.start()
            startupLogger.info(event: "control.start", message: "Control socket listening", fields: [
                "path": .string(SwabbleRuntimePaths.controlSocketURL.path)
            ])
        } catch {
            startupLogger.warn(
                event: "control.start_failed",
                message: "Control socket unavailable",
                fields: ["error": .string(String(describing: error))])
        }
        defer { controlServer.stop() }

        let pipeline = SpeechPipeline()
        do {
            let stream = try await pipeline.start(
                localeIdentifier: initialConfig.speech.localeIdentifier,
                etiquette: initialConfig.speech.etiquetteReplacements)

            for await seg in stream {
                let cfg = await runtimeState.current()
                let logger = Self.makeLogger(from: cfg)

                if cfg.wake.enabled {
                    guard Self.matchesWake(text: seg.text, cfg: cfg) else { continue }
                    await RuntimeStatusStore.shared.noteWakeEvent()
                }

                let stripped = Self.stripWake(text: seg.text, cfg: cfg)
                let job = HookJob(text: stripped, timestamp: Date())
                try await executor.run(job: job)
                await RuntimeStatusStore.shared.noteTranscriptEvent()
                if cfg.transcripts.enabled {
                    await TranscriptsStore.shared.append(text: stripped, redactPii: cfg.logging.redactPii)
                }

                if seg.isFinal {
                    logger.info(
                        event: "transcript.final",
                        message: "Final transcript received",
                        fields: [
                            "transcript": .string(stripped),
                            "length": .int(stripped.count)
                        ])
                } else {
                    logger.debug(
                        event: "transcript.partial",
                        message: "Partial transcript received",
                        fields: [
                            "transcript": .string(stripped),
                            "length": .int(stripped.count)
                        ])
                }
            }
        } catch {
            let logger = Self.makeLogger(from: await runtimeState.current())
            logger.error(
                event: "serve.error",
                message: "serve loop failed",
                fields: ["error": .string(String(describing: error))])
            throw error
        }
    }

    private var configURL: URL? {
        configPath.map { URL(fileURLWithPath: $0) }
    }

    private static func matchesWake(text: String, cfg: SwabbleConfig) -> Bool {
        let triggers = [cfg.wake.word] + cfg.wake.aliases
        return WakeWordGate.matchesTextOnly(text: text, triggers: triggers)
    }

    private static func stripWake(text: String, cfg: SwabbleConfig) -> String {
        let triggers = [cfg.wake.word] + cfg.wake.aliases
        return WakeWordGate.stripWake(text: text, triggers: triggers)
    }

    private static func makeLogger(from cfg: SwabbleConfig) -> Logger {
        Logger(
            level: LogLevel(configValue: cfg.logging.level) ?? .info,
            format: LogFormat(configValue: cfg.logging.format) ?? .text,
            redactPii: cfg.logging.redactPii)
    }

    private static func applyRuntimeOverrides(
        to cfg: SwabbleConfig,
        forceNoWake: Bool,
        overrideLogFormat: String?,
        overrideLogLevel: String?,
        forceRedactPii: Bool,
        forceNoRedactPii: Bool)
    -> SwabbleConfig {
        var effective = cfg
        if forceNoWake {
            effective.wake.enabled = false
        }
        if let overrideLogFormat {
            effective.logging.format = overrideLogFormat
        }
        if let overrideLogLevel {
            effective.logging.level = overrideLogLevel
        }
        if forceRedactPii {
            effective.logging.redactPii = true
        }
        if forceNoRedactPii {
            effective.logging.redactPii = false
        }
        return effective
    }

    private static func handleControlRequest(
        _ request: ControlSocketRequest,
        configURL: URL?,
        runtimeState: ServeRuntimeConfigState,
        executor: HookExecutor,
        forceNoWake: Bool,
        overrideLogFormat: String?,
        overrideLogLevel: String?,
        forceRedactPii: Bool,
        forceNoRedactPii: Bool)
    async -> ControlSocketResponse {
        switch (request.method.uppercased(), request.routePath) {
        case ("GET", "/status"):
            let output = request.query["output"].map(CommandOutputFormat.init(parsedValue:)) ?? .json
            let body = await renderStatusOutput(format: output, configURL: configURL)
            let contentType = output == .json ? "application/json" : "text/plain"
            return .ok(body: body, contentType: contentType)

        case ("GET", "/health"):
            let output = request.query["output"].map(CommandOutputFormat.init(parsedValue:)) ?? .json
            let body = await renderHealthOutput(format: output, configURL: configURL)
            let contentType = output == .json ? "application/json" : "text/plain"
            return .ok(body: body, contentType: contentType)

        case ("POST", "/reload-config"):
            do {
                let loaded = try ConfigLoader.load(at: configURL)
                let effective = applyRuntimeOverrides(
                    to: loaded,
                    forceNoWake: forceNoWake,
                    overrideLogFormat: overrideLogFormat,
                    overrideLogLevel: overrideLogLevel,
                    forceRedactPii: forceRedactPii,
                    forceNoRedactPii: forceNoRedactPii)

                await runtimeState.replace(with: effective)
                await executor.updateConfig(effective)
                await RuntimeStatusStore.shared.bootstrap(
                    config: effective,
                    currentAudioDevice: describeAudioDevice(from: effective))

                return .ok(body: encodeJSONOutput(ReloadConfigResponse(ok: true, message: "config reloaded")))
            } catch {
                return ControlSocketResponse(
                    statusCode: 500,
                    body: encodeJSONOutput(
                        ReloadConfigResponse(ok: false, message: String(describing: error))))
            }

        default:
            return .notFound()
        }
    }
}

private actor ServeRuntimeConfigState {
    private var config: SwabbleConfig

    init(config: SwabbleConfig) {
        self.config = config
    }

    func current() -> SwabbleConfig {
        config
    }

    func replace(with config: SwabbleConfig) {
        self.config = config
    }
}

private struct ReloadConfigResponse: Encodable {
    let ok: Bool
    let message: String
}
