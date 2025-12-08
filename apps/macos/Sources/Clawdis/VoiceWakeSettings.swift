import AppKit
import AVFoundation
import Speech
import SwiftUI
import UniformTypeIdentifiers

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
    @State private var forwardStatus: VoiceWakeForwardStatus = .idle
    private let fieldLabelWidth: CGFloat = 120
    private let controlWidth: CGFloat = 240

    private struct AudioInputDevice: Identifiable, Equatable {
        let uid: String
        let name: String
        var id: String { self.uid }
    }

    private struct IndexedWord: Identifiable {
        let id: Int
        let value: String
    }

    private var voiceWakeBinding: Binding<Bool> {
        Binding(
            get: { self.state.swabbleEnabled },
            set: { newValue in
                Task { await self.state.setVoiceWakeEnabled(newValue) }
            })
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

                SettingsToggleRow(
                    title: "Hold Cmd+Fn to talk",
                    subtitle: "Push-to-talk mode that starts listening while you hold the hotkey and shows the preview overlay.",
                    binding: self.$state.voicePushToTalkEnabled)
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

                VoiceWakeTestCard(
                    testState: self.$testState,
                    isTesting: self.$isTesting,
                    onToggle: self.toggleTest)

                self.chimeSection

                self.triggerTable

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

    private var triggerTable: some View {
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
    }

    private var chimeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Sounds")
                    .font(.callout.weight(.semibold))
                Spacer()
            }

            self.chimeRow(
                title: "Trigger sound",
                selection: self.$state.voiceWakeTriggerChime)

            self.chimeRow(
                title: "Send sound",
                selection: self.$state.voiceWakeSendChime)
        }
        .padding(.top, 4)
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

    private func chimeRow(title: String, selection: Binding<VoiceWakeChime>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Text(title)
                    .font(.callout.weight(.semibold))
                    .frame(width: self.fieldLabelWidth, alignment: .leading)

                Menu {
                    Button("No Sound") { selection.wrappedValue = .none }
                    Divider()
                    ForEach(VoiceWakeChimeCatalog.systemOptions, id: \.self) { option in
                        Button(VoiceWakeChimeCatalog.displayName(for: option)) {
                            selection.wrappedValue = .system(name: option)
                        }
                    }
                    Divider()
                    Button("Choose file…") { self.chooseCustomChime(for: selection) }
                } label: {
                    HStack(spacing: 6) {
                        Text(selection.wrappedValue.displayLabel)
                        Spacer()
                        Image(systemName: "chevron.down")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: self.controlWidth, alignment: .leading)
                    .padding(6)
                    .background(Color(nsColor: .windowBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.secondary.opacity(0.25), lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }

                Button("Play") {
                    VoiceWakeChimePlayer.play(selection.wrappedValue)
                }
                .keyboardShortcut(.space, modifiers: [.command])
            }

            if case let .custom(displayName, _) = selection.wrappedValue {
                Text("Custom: \(displayName)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func chooseCustomChime(for selection: Binding<VoiceWakeChime>) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.resolvesAliases = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                let bookmark = try url.bookmarkData(
                    options: [.withSecurityScope],
                    includingResourceValuesForKeys: nil,
                    relativeTo: nil)
                selection.wrappedValue = .custom(displayName: url.lastPathComponent, bookmark: bookmark)
            } catch {
                // Ignore failures; user can retry.
            }
        }
    }

    private func sanitizedTriggers() -> [String] {
        sanitizeVoiceWakeTriggers(self.state.swabbleTriggerWords)
    }

    private var micPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Microphone")
                    .font(.callout.weight(.semibold))
                    .frame(width: self.fieldLabelWidth, alignment: .leading)
                Picker("Microphone", selection: self.$state.voiceWakeMicID) {
                    Text("System default").tag("")
                    ForEach(self.availableMics) { mic in
                        Text(mic.name).tag(mic.uid)
                    }
                }
                .labelsHidden()
                .frame(width: self.controlWidth)
            }
            if self.loadingMics {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var localePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Language")
                    .font(.callout.weight(.semibold))
                    .frame(width: self.fieldLabelWidth, alignment: .leading)
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
                .frame(width: self.controlWidth)
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
        let cleanedID = normalizeLocaleIdentifier(locale.identifier)
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

    private var levelMeter: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Text("Live level")
                    .font(.callout.weight(.semibold))
                    .frame(width: self.fieldLabelWidth, alignment: .leading)
                MicLevelBar(level: self.meterLevel)
                    .frame(width: self.controlWidth, alignment: .leading)
                Text(self.levelLabel)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 60, alignment: .trailing)
            }
            if let meterError {
                Text(meterError)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var levelLabel: String {
        let db = (meterLevel * 50) - 50
        return String(format: "%.0f dB", db)
    }

    private func checkForwardConnection() async {
        VoiceWakeForwarder.clearCliCache()
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

    private func forwardConfigChanged() {
        self.forwardStatus = .idle
        VoiceWakeForwarder.clearCliCache()
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
