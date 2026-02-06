import Foundation
import os.log

/// Speech synthesizer that wraps `/usr/bin/say`.
///
/// The `say` command uses the Carbon SpeechSynthesis framework under the hood,
/// which has access to the enhanced Siri neural voices configured in
/// System Settings > Accessibility > Spoken Content. These premium voices are
/// NOT available through `AVSpeechSynthesizer`.
///
/// When no voice is specified, `say` uses the system's Spoken Content default
/// voice — which is typically the enhanced Siri neural voice if downloaded.
@MainActor
public final class TalkSayCommandSynthesizer {
    public enum SpeakError: Error {
        case canceled
        case processError(String)
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.say")

    public static let shared = TalkSayCommandSynthesizer()

    private var currentProcess: Process?
    private var currentToken = UUID()

    public var isSpeaking: Bool { self.currentProcess?.isRunning == true }

    private init() {}

    public func stop() {
        self.currentToken = UUID()
        if let proc = self.currentProcess, proc.isRunning {
            proc.terminate()
        }
        self.currentProcess = nil
    }

    /// Speak text using the `say` command.
    /// - Parameters:
    ///   - text: The text to speak.
    ///   - voice: Optional voice name (e.g. "Samantha"). When nil, uses the
    ///     system's Spoken Content default voice (enhanced Siri if configured).
    ///   - rate: Speech rate in words per minute. Default is ~175 wpm.
    public func speak(text: String, voice: String? = nil, rate: Int? = nil) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        self.stop()
        let token = UUID()
        self.currentToken = token

        var args: [String] = []
        if let voice, !voice.isEmpty {
            args.append(contentsOf: ["-v", voice])
        }
        if let rate {
            args.append(contentsOf: ["-r", String(rate)])
        }
        // Text passed as a direct argument (Process uses execve, no shell escaping needed)
        args.append(trimmed)

        self.logger.info("say launch: /usr/bin/say chars=\(trimmed.count, privacy: .public)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        process.arguments = args

        let stderrPipe = Pipe()
        process.standardError = stderrPipe

        self.currentProcess = process

        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                process.terminationHandler = { [weak self] proc in
                    let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                    let stderrStr = String(data: stderrData, encoding: .utf8) ?? ""
                    Task { @MainActor in
                        guard let self else { return }
                        self.currentProcess = nil
                        self.logger.info("say exited status=\(proc.terminationStatus, privacy: .public) reason=\(proc.terminationReason.rawValue, privacy: .public) stderr=\(stderrStr, privacy: .public)")
                        guard self.currentToken == token else {
                            cont.resume(throwing: SpeakError.canceled)
                            return
                        }
                        if proc.terminationStatus == 0 {
                            cont.resume(returning: ())
                        } else if proc.terminationReason == .uncaughtSignal {
                            cont.resume(throwing: SpeakError.canceled)
                        } else {
                            cont.resume(throwing: SpeakError.processError(
                                "say exited with status \(proc.terminationStatus): \(stderrStr)"))
                        }
                    }
                }

                do {
                    try process.run()
                    self.logger.info("say process started pid=\(process.processIdentifier, privacy: .public)")
                } catch {
                    self.logger.error("say process failed to launch: \(error.localizedDescription, privacy: .public)")
                    self.currentProcess = nil
                    cont.resume(throwing: error)
                }
            }
        }, onCancel: {
            Task { @MainActor in
                self.stop()
            }
        })

        if self.currentToken != token {
            throw SpeakError.canceled
        }
    }
}
