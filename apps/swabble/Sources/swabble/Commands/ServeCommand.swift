import Commander
import Foundation
import Swabble
import SwabbleKit

@available(macOS 26.0, *)
@MainActor
struct ServeCommand: CLICommand {
    @Option(name: .long("config"), help: "Path to config JSON") var configPath: String?
    @Flag(name: .long("no-wake"), help: "Disable wake word") var noWake: Bool = false

    static var commandDescription: CommandDescription {
        CommandDescription(
            commandName: "serve",
            abstract: "Run swabble in the foreground")
    }

    init() {}

    init(parsed: ParsedValues) {
        self.init()
        if parsed.flags.contains("noWake") { self.noWake = true }
        if let cfg = parsed.options["configPath"]?.last { self.configPath = cfg }
    }

    mutating func run() async throws {
        var cfg: SwabbleConfig
        do {
            cfg = try ConfigLoader.load(at: self.configURL)
        } catch {
            cfg = SwabbleConfig()
            try ConfigLoader.save(cfg, at: self.configURL)
        }
        if self.noWake {
            cfg.wake.enabled = false
        }

        let logger = Logger(level: LogLevel(configValue: cfg.logging.level) ?? .info)
        logger.info("swabble serve starting (wake: \(cfg.wake.enabled ? cfg.wake.word : "disabled"))")
        let pipeline = SpeechPipeline()
        do {
            let stream = try await pipeline.start(
                localeIdentifier: cfg.speech.localeIdentifier,
                etiquette: cfg.speech.etiquetteReplacements)
            try await Self.consumeTranscripts(stream, config: cfg, logger: logger)
        } catch {
            logger.error("serve error: \(error)")
            throw error
        }
    }

    static func consumeTranscripts(
        _ stream: AsyncStream<SpeechSegment>,
        config cfg: SwabbleConfig,
        logger: Logger) async throws
    {
        let executor = HookExecutor(config: cfg)
        let triggers = [cfg.wake.word] + cfg.wake.aliases
        for await seg in stream {
            if cfg.wake.enabled {
                guard WakeWordGate.matchesTextOnly(text: seg.text, triggers: triggers) else { continue }
            }
            let stripped = WakeWordGate.stripWake(text: seg.text, triggers: triggers)
            if stripped.count >= cfg.hook.minCharacters {
                let job = HookJob(text: stripped, timestamp: Date())
                try await executor.run(job: job)
            }
            if cfg.transcripts.enabled {
                await TranscriptsStore.shared.append(text: stripped)
            }
            if seg.isFinal {
                logger.info("final: \(stripped)")
            } else {
                logger.debug("partial: \(stripped)")
            }
        }
    }

    private var configURL: URL? {
        self.configPath.map { URL(fileURLWithPath: $0) }
    }
}
