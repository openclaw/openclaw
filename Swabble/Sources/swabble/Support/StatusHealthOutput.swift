import AVFoundation
import Foundation
import Speech
import Swabble

struct StatusLoggingPayload: Encodable {
    let level: String
    let format: String
    let redactPii: Bool
}

struct StatusPayload: Encodable {
    let wakeEnabled: Bool
    let wakeWord: String
    let lastWakeEventAt: String?
    let lastTranscriptAt: String?
    let currentAudioDevice: String
    let logging: StatusLoggingPayload
    let daemonRunning: Bool
    let recentTranscripts: [String]
}

func buildStatusPayload(configURL: URL?) async -> StatusPayload {
    let cfg = (try? ConfigLoader.load(at: configURL)) ?? SwabbleConfig()
    let runtime = await RuntimeStatusStore.shared.current()
    let recentTranscripts = Array(await TranscriptsStore.shared.latest().suffix(3))

    return StatusPayload(
        wakeEnabled: runtime?.wakeEnabled ?? cfg.wake.enabled,
        wakeWord: runtime?.wakeWord ?? cfg.wake.word,
        lastWakeEventAt: isoTimestamp(runtime?.lastWakeEventAt),
        lastTranscriptAt: isoTimestamp(runtime?.lastTranscriptAt),
        currentAudioDevice: runtime?.currentAudioDevice ?? describeAudioDevice(from: cfg),
        logging: StatusLoggingPayload(
            level: runtime?.loggingLevel ?? cfg.logging.level,
            format: runtime?.loggingFormat ?? cfg.logging.format,
            redactPii: runtime?.loggingRedactPii ?? cfg.logging.redactPii),
        daemonRunning: isDaemonSocketRunning(),
        recentTranscripts: recentTranscripts)
}

func renderStatusText(_ payload: StatusPayload) -> String {
    var lines: [String] = [
        "wake enabled: \(payload.wakeEnabled ? \"yes\" : \"no\")",
        "wake word: \(payload.wakeWord)",
        "last wake event: \(payload.lastWakeEventAt ?? \"never\")",
        "last transcript: \(payload.lastTranscriptAt ?? \"never\")",
        "audio device: \(payload.currentAudioDevice)",
        "logging: level=\(payload.logging.level) format=\(payload.logging.format) redactPii=\(payload.logging.redactPii)",
        "daemon running: \(payload.daemonRunning ? \"yes\" : \"no\")"
    ]

    if payload.recentTranscripts.isEmpty {
        lines.append("transcripts: (none yet)")
    } else {
        lines.append("last transcripts:")
        lines.append(contentsOf: payload.recentTranscripts.map { "- \($0)" })
    }

    return lines.joined(separator: "\n")
}

func renderStatusOutput(format: CommandOutputFormat, configURL: URL?) async -> String {
    let payload = await buildStatusPayload(configURL: configURL)
    switch format {
    case .json:
        return encodeJSONOutput(payload)
    case .text:
        return renderStatusText(payload)
    }
}

struct HealthCheck: Encodable {
    let ok: Bool
    let detail: String
}

struct HealthChecks: Encodable {
    let config: HealthCheck
    let speechAuthorization: HealthCheck
    let microphone: HealthCheck
    let wakeConfig: HealthCheck
    let daemon: HealthCheck
}

struct HealthPayload: Encodable {
    let ok: Bool
    let checks: HealthChecks
}

func buildHealthPayload(configURL: URL?) async -> HealthPayload {
    var cfg = SwabbleConfig()
    var configError: String?
    do {
        cfg = try ConfigLoader.load(at: configURL)
    } catch {
        configError = String(describing: error)
    }

    let auth = await SFSpeechRecognizer.authorizationStatus()
    let speechAuthorized = auth == .authorized

    let session = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.microphone, .external],
        mediaType: .audio,
        position: .unspecified)
    let micCount = session.devices.count
    let micAvailable = micCount > 0

    let wakeWord = cfg.wake.word.trimmingCharacters(in: .whitespacesAndNewlines)
    let wakeAliases = cfg.wake.aliases
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    let wakeConfigValid = configError == nil && (!cfg.wake.enabled || !wakeWord.isEmpty || !wakeAliases.isEmpty)

    let daemonExpected = FileManager.default.fileExists(atPath: SwabbleRuntimePaths.launchdPlistURL.path)
    let daemonRunning = isDaemonSocketRunning()
    let daemonStatusValid = !daemonExpected || daemonRunning

    let checks = HealthChecks(
        config: HealthCheck(ok: configError == nil, detail: configError ?? "Config loaded"),
        speechAuthorization: HealthCheck(ok: speechAuthorized, detail: "status=\(auth)"),
        microphone: HealthCheck(ok: micAvailable, detail: "devices=\(micCount)"),
        wakeConfig: HealthCheck(ok: wakeConfigValid, detail: "enabled=\(cfg.wake.enabled) word=\(wakeWord.isEmpty ? \"(empty)\" : wakeWord) aliases=\(wakeAliases.count)"),
        daemon: HealthCheck(ok: daemonStatusValid, detail: "expected=\(daemonExpected) running=\(daemonRunning)"))

    return HealthPayload(
        ok: checks.config.ok && checks.speechAuthorization.ok && checks.microphone.ok && checks.wakeConfig.ok && checks.daemon.ok,
        checks: checks)
}

func renderHealthText(_ payload: HealthPayload) -> String {
    let checks = payload.checks
    let lines: [String] = [
        payload.ok ? "ok" : "degraded",
        "config: \(checks.config.ok ? \"ok\" : \"fail\") (\(checks.config.detail))",
        "speech: \(checks.speechAuthorization.ok ? \"ok\" : \"fail\") (\(checks.speechAuthorization.detail))",
        "microphone: \(checks.microphone.ok ? \"ok\" : \"fail\") (\(checks.microphone.detail))",
        "wake config: \(checks.wakeConfig.ok ? \"ok\" : \"fail\") (\(checks.wakeConfig.detail))",
        "daemon: \(checks.daemon.ok ? \"ok\" : \"fail\") (\(checks.daemon.detail))"
    ]
    return lines.joined(separator: "\n")
}

func renderHealthOutput(format: CommandOutputFormat, configURL: URL?) async -> String {
    let payload = await buildHealthPayload(configURL: configURL)
    switch format {
    case .json:
        return encodeJSONOutput(payload)
    case .text:
        return renderHealthText(payload)
    }
}
