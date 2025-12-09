import Foundation
import OSLog

struct VoiceWakeForwardConfig: Sendable {
    let enabled: Bool
    let commandTemplate: String
    let timeout: TimeInterval
}

enum VoiceWakeForwarder {
    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake.forward")

    static func prefixedTranscript(_ transcript: String, machineName: String? = nil) -> String {
        let resolvedMachine = machineName
            .flatMap { name -> String? in
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            ?? Host.current().localizedName
            ?? ProcessInfo.processInfo.hostName

        let safeMachine = resolvedMachine.isEmpty ? "this Mac" : resolvedMachine
        return """
        User talked via voice recognition on \(safeMachine) - repeat prompt first \
        + remember some words might be incorrectly transcribed.

        \(transcript)
        """
    }

    static func clearCliCache() {
        // Legacy no-op; CLI caching removed now that we rely on AgentRPC.
    }

    enum VoiceWakeForwardError: LocalizedError, Equatable {
        case rpcFailed(String)
        case disabled

        var errorDescription: String? {
            switch self {
            case let .rpcFailed(message): message
            case .disabled: "Voice wake forwarding disabled"
            }
        }
    }

    @discardableResult
    static func forward(
        transcript: String,
        config: VoiceWakeForwardConfig) async -> Result<Void, VoiceWakeForwardError>
    {
        guard config.enabled else { return .failure(.disabled) }
        let payload = Self.prefixedTranscript(transcript)
        let options = self.parseCommandTemplate(config.commandTemplate)
        let thinking = options.thinking ?? "default"

        let result = await AgentRPC.shared.send(
            text: payload,
            thinking: thinking,
            session: options.session,
            deliver: options.deliver,
            to: options.to)

        if result.ok {
            self.logger.info("voice wake forward ok")
            return .success(())
        }

        let message = result.error ?? "agent rpc unavailable"
        self.logger.error("voice wake forward failed: \(message, privacy: .public)")
        return .failure(.rpcFailed(message))
    }

    static func checkConnection(config: VoiceWakeForwardConfig) async -> Result<Void, VoiceWakeForwardError> {
        guard config.enabled else { return .failure(.disabled) }
        let status = await AgentRPC.shared.status()
        if status.ok { return .success(()) }
        return .failure(.rpcFailed(status.error ?? "agent rpc unreachable"))
    }

    static func shellEscape(_ text: String) -> String {
        // Single-quote based shell escaping.
        let replaced = text.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(replaced)'"
    }

    // MARK: - Template parsing

    struct ForwardOptions {
        var session: String = "main"
        var thinking: String? = "low"
        var deliver: Bool = true
        var to: String?
    }

    private static func parseCommandTemplate(_ template: String) -> ForwardOptions {
        var options = ForwardOptions()
        let parts = self.tokenize(template)
        var idx = 0
        while idx < parts.count {
            let part = parts[idx]
            switch part {
            case "--session", "--session-id":
                if idx + 1 < parts.count { options.session = parts[idx + 1] }
                idx += 1
            case "--thinking":
                if idx + 1 < parts.count { options.thinking = parts[idx + 1] }
                idx += 1
            case "--deliver":
                options.deliver = true
            case "--no-deliver":
                options.deliver = false
            case "--to":
                if idx + 1 < parts.count { options.to = parts[idx + 1] }
                idx += 1
            default:
                break
            }
            idx += 1
        }
        return options
    }

    private static func tokenize(_ text: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var quote: Character?
        var escapeNext = false

        func flush() {
            if !current.isEmpty {
                tokens.append(current)
                current = ""
            }
        }

        for ch in text {
            if escapeNext {
                current.append(ch)
                escapeNext = false
                continue
            }
            if ch == "\\" && quote == "\"" {
                escapeNext = true
                continue
            }
            if ch == "\"" || ch == "'" {
                if quote == ch {
                    quote = nil
                } else if quote == nil {
                    quote = ch
                } else {
                    current.append(ch)
                }
                continue
            }
            if ch.isWhitespace, quote == nil {
                flush()
                continue
            }
            current.append(ch)
        }
        flush()
        return tokens
    }

    #if DEBUG
    static func _testParseCommandTemplate(_ template: String) -> ForwardOptions {
        self.parseCommandTemplate(template)
    }
    #endif
}
