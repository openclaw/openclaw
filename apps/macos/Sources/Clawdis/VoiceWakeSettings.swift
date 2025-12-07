import AVFoundation
import OSLog
import Speech
import SwiftUI

enum VoiceWakeTestState: Equatable {
    case idle
    case requesting
    case listening
    case hearing(String)
    case detected(String)
    case failed(String)
}

private enum ForwardStatus: Equatable {
    case idle
    case checking
    case ok
    case failed(String)
}

private struct AudioInputDevice: Identifiable, Equatable {
    let uid: String
    let name: String
    var id: String { self.uid }
}

actor MicLevelMonitor {
    private let engine = AVAudioEngine()
    private var update: (@Sendable (Double) -> Void)?
    private var running = false
    private var smoothedLevel: Double = 0

    func start(onLevel: @Sendable @escaping (Double) -> Void) async throws {
        self.update = onLevel
        if self.running { return }
        let input = self.engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 512, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let level = Self.normalizedLevel(from: buffer)
            Task { await self.push(level: level) }
        }
        self.engine.prepare()
        try self.engine.start()
        self.running = true
    }

    func stop() {
        guard self.running else { return }
        self.engine.inputNode.removeTap(onBus: 0)
        self.engine.stop()
        self.running = false
    }

    private func push(level: Double) {
        self.smoothedLevel = (self.smoothedLevel * 0.45) + (level * 0.55)
        guard let update else { return }
        let value = self.smoothedLevel
        Task { @MainActor in update(value) }
    }

    private static func normalizedLevel(from buffer: AVAudioPCMBuffer) -> Double {
        guard let channel = buffer.floatChannelData?[0] else { return 0 }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<frameCount {
            let s = channel[i]
            sum += s * s
        }
        let rms = sqrt(sum / Float(frameCount) + 1e-12)
        let db = 20 * log10(Double(rms))
        let normalized = max(0, min(1, (db + 50) / 50))
        return normalized
    }
}

final class VoiceWakeTester {
    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var isStopping = false
    private var detectionStart: Date?
    private var lastHeard: Date?
    private var holdingAfterDetect = false
    private var detectedText: String?
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake")

    init(locale: Locale = .current) {
        self.recognizer = SFSpeechRecognizer(locale: locale)
    }

    func start(
        triggers: [String],
        micID: String?,
        localeID: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) async throws
    {
        guard self.recognitionTask == nil else { return }
        self.isStopping = false
        let chosenLocale = localeID.flatMap { Locale(identifier: $0) } ?? Locale.current
        let recognizer = SFSpeechRecognizer(locale: chosenLocale)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition unavailable"])
        }

        guard Self.hasPrivacyStrings else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 3,
                userInfo: [
                    NSLocalizedDescriptionKey: """
                    Missing mic/speech privacy strings. Rebuild the mac app (scripts/restart-mac.sh) \
                    to include usage descriptions.
                    """,
                ])
        }

        let granted = try await Self.ensurePermissions()
        guard granted else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Microphone or speech permission denied"])
        }

        self.configureSession(preferredMicID: micID)

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        let request = self.recognitionRequest

        let inputNode = self.audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        self.audioEngine.prepare()
        try self.audioEngine.start()
        DispatchQueue.main.async {
            onUpdate(.listening)
        }

        self.detectionStart = Date()
        self.lastHeard = self.detectionStart

        guard let request = recognitionRequest else { return }

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString ?? ""
            let matched = Self.matches(text: text, triggers: triggers)
            let isFinal = result?.isFinal ?? false
            let errorMessage = error?.localizedDescription
            Task { @MainActor [weak self] in
                guard let self, !self.isStopping else { return }
                self.handleResult(
                    matched: matched,
                    text: text,
                    isFinal: isFinal,
                    errorMessage: errorMessage,
                    onUpdate: onUpdate)
            }
        }
    }

    func stop() {
        self.isStopping = true
        self.audioEngine.stop()
        self.recognitionRequest?.endAudio()
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
    }

    @MainActor
    private func handleResult(
        matched: Bool,
        text: String,
        isFinal: Bool,
        errorMessage: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void)
    {
        if !text.isEmpty {
            self.lastHeard = Date()
        }
        if matched, !text.isEmpty {
            self.holdingAfterDetect = true
            self.detectedText = text
            self.logger.info("voice wake detected; forwarding (len=\(text.count))")
            AppStateStore.shared.triggerVoiceEars()
            let config = AppStateStore.shared.voiceWakeForwardConfig
            Task.detached {
                await VoiceWakeForwarder.forward(transcript: text, config: config)
            }
            onUpdate(.detected(text))
            self.holdUntilSilence(onUpdate: onUpdate)
            return
        }
        if let errorMessage {
            self.stop()
            onUpdate(.failed(errorMessage))
            return
        }
        if isFinal {
            self.stop()
            onUpdate(text.isEmpty ? .failed("No speech detected") : .failed("No trigger heard: “\(text)”"))
        } else {
            onUpdate(text.isEmpty ? .listening : .hearing(text))
        }
    }

    private func holdUntilSilence(onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let start = self.detectionStart ?? Date()
            let deadline = start.addingTimeInterval(10)
            while !self.isStopping {
                let now = Date()
                if now >= deadline { break }
                if let last = self.lastHeard, now.timeIntervalSince(last) >= 1 {
                    break
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            if !self.isStopping {
                self.stop()
                if let detectedText {
                    self.logger.info("voice wake hold finished; len=\(detectedText.count)")
                    onUpdate(.detected(detectedText))
                }
            }
        }
    }

    private func configureSession(preferredMicID: String?) {
        _ = preferredMicID
    }

    private static func matches(text: String, triggers: [String]) -> Bool {
        let lowered = text.lowercased()
        return triggers.contains { lowered.contains($0.lowercased()) }
    }

    private nonisolated static func ensurePermissions() async throws -> Bool {
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            let granted = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
            guard granted else { return false }
        } else if speechStatus != .authorized {
            return false
        }

        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        switch micStatus {
        case .authorized: return true

        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }

        default:
            return false
        }
    }

    private static var hasPrivacyStrings: Bool {
        let speech = Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") as? String
        let mic = Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String
        return speech?.isEmpty == false && mic?.isEmpty == false
    }
}

struct VoiceWakeSettings: View {
    @ObservedObject var state: AppState
    @State private var testState: VoiceWakeTestState = .idle
    @State private var tester = VoiceWakeTester()
    @State private var isTesting = false
    @State private var availableMics: [AudioInputDevice] = []
    @State private var loadingMics = false
    @State private var meterLevel: Double = 0
    @State private var meterError: String?
    private let meter = MicLevelMonitor()
    @State private var availableLocales: [Locale] = []
    @State private var showForwardAdvanced = false
    @State private var forwardStatus: ForwardStatus = .idle

    private var voiceWakeBinding: Binding<Bool> {
        Binding(
            get: { self.state.swabbleEnabled },
            set: { newValue in
                Task { await self.state.setVoiceWakeEnabled(newValue) }
            })
    }

    private struct IndexedWord: Identifiable {
        let id: Int
        let value: String
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 14) {
                SettingsToggleRow(
                    title: "Enable Voice Wake",
                    subtitle: "Listen for a wake phrase (e.g. \"Claude\") before running voice commands. "
                        + "Voice recognition runs fully on-device.",
                    binding: self.voiceWakeBinding)
                    .disabled(!voiceWakeSupported)

                if !voiceWakeSupported {
                    Label("Voice Wake requires macOS 26 or newer.", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.yellow)
                        .padding(8)
                        .background(Color.secondary.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                self.localePicker
                self.micPicker
                self.levelMeter

                self.forwardSection

                self.testCard

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Trigger words")
                            .font(.callout.weight(.semibold))
                        Spacer()
                        Button {
                            self.addWord()
                        } label: {
                            Label("Add word", systemImage: "plus")
                        }
                        .disabled(self.state.swabbleTriggerWords
                            .contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }))

                        Button("Reset defaults") { self.state.swabbleTriggerWords = defaultVoiceWakeTriggers }
                    }

                    Table(self.indexedWords) {
                        TableColumn("Word") { row in
                            TextField("Wake word", text: self.binding(for: row.id))
                                .textFieldStyle(.roundedBorder)
                        }
                        TableColumn("") { row in
                            Button {
                                self.removeWord(at: row.id)
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.borderless)
                            .help("Remove trigger word")
                        }
                        .width(36)
                    }
                    .frame(minHeight: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.secondary.opacity(0.25), lineWidth: 1))

                    Text(
                        "Clawdis reacts when any trigger appears in a transcription. "
                            + "Keep them short to avoid false positives.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
        }
        .task { await self.loadMicsIfNeeded() }
        .task { await self.loadLocalesIfNeeded() }
        .task { await self.restartMeter() }
        .onChange(of: self.state.voiceWakeMicID) { _, _ in
            Task { await self.restartMeter() }
        }
        .onDisappear {
            Task { await self.meter.stop() }
        }
    }

    private var indexedWords: [IndexedWord] {
        self.state.swabbleTriggerWords.enumerated().map { IndexedWord(id: $0.offset, value: $0.element) }
    }

    private var testCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Test Voice Wake")
                    .font(.callout.weight(.semibold))
                Spacer()
                Button(action: self.toggleTest) {
                    Label(
                        self.isTesting ? "Stop" : "Start test",
                        systemImage: self.isTesting ? "stop.circle.fill" : "play.circle")
                }
                .buttonStyle(.borderedProminent)
                .tint(self.isTesting ? .red : .accentColor)
            }

            HStack(spacing: 8) {
                self.statusIcon
                VStack(alignment: .leading, spacing: 4) {
                    Text(self.statusText)
                        .font(.subheadline)
                    if case let .detected(text) = testState {
                        Text("Heard: \(text)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer()
            }
            .padding(10)
            .background(.quaternary.opacity(0.2))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .padding(.vertical, 2)
    }

    private var statusIcon: some View {
        switch self.testState {
        case .idle:
            AnyView(Image(systemName: "waveform").foregroundStyle(.secondary))

        case .requesting:
            AnyView(ProgressView().controlSize(.small))

        case .listening, .hearing:
            AnyView(
                Image(systemName: "ear.and.waveform")
                    .symbolEffect(.pulse)
                    .foregroundStyle(Color.accentColor))

        case .detected:
            AnyView(Image(systemName: "checkmark.circle.fill").foregroundStyle(.green))

        case .failed:
            AnyView(Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow))
        }
    }

    private var statusText: String {
        switch self.testState {
        case .idle:
            "Press start, say a trigger word, and wait for detection."

        case .requesting:
            "Requesting mic & speech permission…"

        case .listening:
            "Listening… say your trigger word."

        case let .hearing(text):
            "Heard: \(text)"

        case .detected:
            "Voice wake detected!"

        case let .failed(reason):
            reason
        }
    }

    private func addWord() {
        self.state.swabbleTriggerWords.append("")
    }

    private func removeWord(at index: Int) {
        guard self.state.swabbleTriggerWords.indices.contains(index) else { return }
        self.state.swabbleTriggerWords.remove(at: index)
    }

    private func binding(for index: Int) -> Binding<String> {
        Binding(
            get: {
                guard self.state.swabbleTriggerWords.indices.contains(index) else { return "" }
                return self.state.swabbleTriggerWords[index]
            },
            set: { newValue in
                guard self.state.swabbleTriggerWords.indices.contains(index) else { return }
                self.state.swabbleTriggerWords[index] = newValue
            })
    }

    private func toggleTest() {
        guard voiceWakeSupported else {
            self.testState = .failed("Voice Wake requires macOS 26 or newer.")
            return
        }
        if self.isTesting {
            self.tester.stop()
            self.isTesting = false
            self.testState = .idle
            return
        }

        let triggers = self.sanitizedTriggers()
        self.isTesting = true
        self.testState = .requesting
        Task { @MainActor in
            do {
                try await self.tester.start(
                    triggers: triggers,
                    micID: self.state.voiceWakeMicID.isEmpty ? nil : self.state.voiceWakeMicID,
                    localeID: self.state.voiceWakeLocaleID,
                    onUpdate: { newState in
                        DispatchQueue.main.async { [self] in
                            self.testState = newState
                            if case .detected = newState { self.isTesting = false }
                            if case .failed = newState { self.isTesting = false }
                        }
                    })
                try await Task.sleep(nanoseconds: 10 * 1_000_000_000)
                if self.isTesting {
                    self.tester.stop()
                    self.testState = .failed("Timeout: no trigger heard")
                    self.isTesting = false
                }
            } catch {
                self.tester.stop()
                self.testState = .failed(error.localizedDescription)
                self.isTesting = false
            }
        }
    }

    private func sanitizedTriggers() -> [String] {
        let cleaned = self.state.swabbleTriggerWords
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return cleaned.isEmpty ? defaultVoiceWakeTriggers : cleaned
    }

    private var micPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("Microphone") {
                Picker("Microphone", selection: self.$state.voiceWakeMicID) {
                    Text("System default").tag("")
                    ForEach(self.availableMics) { mic in
                        Text(mic.name).tag(mic.uid)
                    }
                }
                .labelsHidden()
                .frame(width: 260)
            }
            if self.loadingMics {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var localePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("Recognition language") {
                Picker("Language", selection: self.$state.voiceWakeLocaleID) {
                    let current = Locale(identifier: Locale.current.identifier)
                    Text("\(self.friendlyName(for: current)) (System)").tag(Locale.current.identifier)
                    ForEach(self.availableLocales.map(\.identifier), id: \.self) { id in
                        if id != Locale.current.identifier {
                            Text(self.friendlyName(for: Locale(identifier: id))).tag(id)
                        }
                    }
                }
                .labelsHidden()
                .frame(width: 260)
            }

            if !self.state.voiceWakeAdditionalLocaleIDs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Additional languages")
                        .font(.footnote.weight(.semibold))
                    ForEach(
                        Array(self.state.voiceWakeAdditionalLocaleIDs.enumerated()),
                        id: \.offset)
                    { idx, localeID in
                        HStack(spacing: 8) {
                            Picker("Extra \(idx + 1)", selection: Binding(
                                get: { localeID },
                                set: { newValue in
                                    guard self.state
                                        .voiceWakeAdditionalLocaleIDs.indices
                                        .contains(idx) else { return }
                                    self.state
                                        .voiceWakeAdditionalLocaleIDs[idx] =
                                        newValue
                                })) {
                                    ForEach(self.availableLocales.map(\.identifier), id: \.self) { id in
                                        Text(self.friendlyName(for: Locale(identifier: id))).tag(id)
                                    }
                                }
                                .labelsHidden()
                                    .frame(width: 220)

                            Button {
                                guard self.state.voiceWakeAdditionalLocaleIDs.indices.contains(idx) else { return }
                                self.state.voiceWakeAdditionalLocaleIDs.remove(at: idx)
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.borderless)
                            .help("Remove language")
                        }
                    }

                    Button {
                        if let first = availableLocales.first {
                            self.state.voiceWakeAdditionalLocaleIDs.append(first.identifier)
                        }
                    } label: {
                        Label("Add language", systemImage: "plus")
                    }
                    .disabled(self.availableLocales.isEmpty)
                }
                .padding(.top, 4)
            } else {
                Button {
                    if let first = availableLocales.first {
                        self.state.voiceWakeAdditionalLocaleIDs.append(first.identifier)
                    }
                } label: {
                    Label("Add additional language", systemImage: "plus")
                }
                .buttonStyle(.link)
                .disabled(self.availableLocales.isEmpty)
                .padding(.top, 4)
            }

            Text("Languages are tried in order. Models may need a first-use download on macOS 26.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @MainActor
    private func loadMicsIfNeeded() async {
        guard self.availableMics.isEmpty, !self.loadingMics else { return }
        self.loadingMics = true
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        self.availableMics = discovery.devices.map { AudioInputDevice(uid: $0.uniqueID, name: $0.localizedName) }
        self.loadingMics = false
    }

    @MainActor
    private func loadLocalesIfNeeded() async {
        guard self.availableLocales.isEmpty else { return }
        self.availableLocales = Array(SFSpeechRecognizer.supportedLocales()).sorted { lhs, rhs in
            self.friendlyName(for: lhs)
                .localizedCaseInsensitiveCompare(self.friendlyName(for: rhs)) == .orderedAscending
        }
    }

    private func friendlyName(for locale: Locale) -> String {
        let cleanedID = self.normalizedLocaleIdentifier(locale.identifier)
        let cleanLocale = Locale(identifier: cleanedID)

        if let langCode = cleanLocale.language.languageCode?.identifier,
           let lang = cleanLocale.localizedString(forLanguageCode: langCode),
           let regionCode = cleanLocale.region?.identifier,
           let region = cleanLocale.localizedString(forRegionCode: regionCode)
        {
            return "\(lang) (\(region))"
        }
        if let langCode = cleanLocale.language.languageCode?.identifier,
           let lang = cleanLocale.localizedString(forLanguageCode: langCode)
        {
            return lang
        }
        return cleanLocale.localizedString(forIdentifier: cleanedID) ?? cleanedID
    }

    private func normalizedLocaleIdentifier(_ raw: String) -> String {
        var trimmed = raw
        if let at = trimmed.firstIndex(of: "@") {
            trimmed = String(trimmed[..<at])
        }
        if let u = trimmed.range(of: "-u-") {
            trimmed = String(trimmed[..<u.lowerBound])
        }
        if let t = trimmed.range(of: "-t-") {
            trimmed = String(trimmed[..<t.lowerBound])
        }
        return trimmed
    }

    private var levelMeter: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent {
                HStack(spacing: 10) {
                    MicLevelBar(level: self.meterLevel)
                    Text(self.levelLabel)
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            } label: {
                Text("Live level")
                    .font(.callout.weight(.semibold))
            }
            if let meterError {
                Text(meterError)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var forwardSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: self.$state.voiceWakeForwardEnabled) {
                Text("Forward wake to host (SSH)")
            }
            if self.state.voiceWakeForwardEnabled {
                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("SSH target") {
                        TextField("steipete@peters-mac-studio-1", text: self.$state.voiceWakeForwardTarget)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 280)
                            .onChange(of: self.state.voiceWakeForwardTarget) { _, _ in self.forwardStatus = .idle }
                    }

                    self.forwardStatusRow

                    DisclosureGroup(isExpanded: self.$showForwardAdvanced) {
                        VStack(alignment: .leading, spacing: 10) {
                            LabeledContent("Identity file") {
                                TextField(
                                    "/Users/you/.ssh/voicewake_ed25519",
                                    text: self.$state.voiceWakeForwardIdentity)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(width: 320)
                                    .onChange(of: self.state.voiceWakeForwardIdentity) { _, _ in
                                        self.forwardStatus = .idle
                                    }
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Remote command template")
                                    .font(.callout.weight(.semibold))
                                TextField(
                                    "clawdis-mac agent --message \"${text}\" --thinking low",
                                    text: self.$state.voiceWakeForwardCommand,
                                    axis: .vertical)
                                    .textFieldStyle(.roundedBorder)
                                    .onChange(of: self.state.voiceWakeForwardCommand) { _, _ in
                                        self.forwardStatus = .idle
                                    }
                                Text(
                                    "${text} is replaced with the transcript."
                                        + "\nIt is also piped to stdin if you prefer $(cat).")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(.top, 4)
                    } label: {
                        Text("Advanced")
                            .font(.callout.weight(.semibold))
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var forwardStatusRow: some View {
        HStack(spacing: 10) {
            switch self.forwardStatus {
            case .idle:
                Image(systemName: "circle.dashed")
                    .foregroundStyle(.secondary)
            case .checking:
                ProgressView().controlSize(.small)
            case .ok:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case let .failed(message):
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                    .help(message)
            }

            Button("Check connection") {
                Task { await self.checkForwardConnection() }
            }
            .disabled(self.state.voiceWakeForwardTarget.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if case let .failed(message) = self.forwardStatus {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(5)
            }
        }
    }

    private var levelLabel: String {
        let db = (meterLevel * 50) - 50
        return String(format: "%.0f dB", db)
    }

    private func checkForwardConnection() async {
        self.forwardStatus = .checking
        let config = AppStateStore.shared.voiceWakeForwardConfig
        let result = await VoiceWakeForwarder.checkConnection(config: config)
        await MainActor.run {
            switch result {
            case .success:
                self.forwardStatus = .ok
            case let .failure(error):
                self.forwardStatus = .failed(error.localizedDescription)
            }
        }
    }

    @MainActor
    private func restartMeter() async {
        self.meterError = nil
        await self.meter.stop()
        do {
            try await self.meter.start { [weak state] level in
                Task { @MainActor in
                    guard state != nil else { return }
                    self.meterLevel = level
                }
            }
        } catch {
            self.meterError = error.localizedDescription
        }
    }
}

struct MicLevelBar: View {
    let level: Double
    let segments: Int = 12

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<self.segments, id: \.self) { idx in
                let fill = self.level * Double(self.segments) > Double(idx)
                RoundedRectangle(cornerRadius: 2)
                    .fill(fill ? self.segmentColor(for: idx) : Color.gray.opacity(0.35))
                    .frame(width: 14, height: 10)
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.gray.opacity(0.25), lineWidth: 1))
    }

    private func segmentColor(for idx: Int) -> Color {
        let fraction = Double(idx + 1) / Double(self.segments)
        if fraction < 0.65 { return .green }
        if fraction < 0.85 { return .yellow }
        return .red
    }
}

extension VoiceWakeTester: @unchecked Sendable {}
