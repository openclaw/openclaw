import SwiftUI

struct MeetingSettings: View {
    @Bindable private var detector = MeetingDetector.shared
    @Bindable private var store = MeetingStore.shared
    @AppStorage("meetingGoogleDriveSyncEnabled") private var syncEnabled = false
    @AppStorage("meetingGoogleDriveFolderId") private var driveFolderId = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.togglesSection
            Divider()
            self.engineSection
            Divider()
            self.syncSection
            Divider()
            self.pastMeetingsButton
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - Toggles

    @ViewBuilder
    private var togglesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Meeting Notes")
                .font(.headline)

            Toggle(isOn: self.$detector.meetingDetectionEnabled) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Enable meeting detection")
                    Text("Automatically detect meetings via calendar events and microphone activity.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .onChange(of: self.detector.meetingDetectionEnabled) { _, enabled in
                if enabled {
                    self.detector.start()
                } else {
                    self.detector.stop()
                }
            }

            Toggle(isOn: self.$detector.adHocDetectionEnabled) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Auto-detect ad-hoc calls")
                    Text("Prompt to transcribe when microphone activates outside a scheduled meeting.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(!self.detector.meetingDetectionEnabled)

            HStack(spacing: 12) {
                Button("Grant Calendar Access") {
                    Task { await self.detector.requestCalendarAccess() }
                }
                .disabled(self.detector.calendarAccessGranted)

                if self.detector.calendarAccessGranted {
                    Label("Calendar access granted", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
            }
        }
    }

    // MARK: - Transcription Engine

    @ViewBuilder
    private var engineSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Transcription Engine")
                .font(.headline)

            Picker("Engine:", selection: self.$detector.transcriptionEngine) {
                ForEach(TranscriptionEngine.allCases) { engine in
                    Text(engine.displayName).tag(engine)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 300)

            if self.detector.transcriptionEngine == .whisper {
                self.whisperOptions
            }
        }
    }

    @AppStorage("whisperModelSize") private var whisperModelSize = "openai_whisper-base.en"
    @State private var downloadedModels: Set<String> = WhisperTranscriber.scanDownloadedModels().0
    @State private var downloadStarted = false

    private var whisperModels: [String] { WhisperTranscriber.supportedModels }

    /// Show a short display name: "openai_whisper-base.en" → "base.en"
    private func modelDisplayName(_ model: String) -> String {
        if let range = model.range(of: "whisper-") {
            return String(model[range.upperBound...])
        }
        return model
    }

    @ViewBuilder
    private var whisperOptions: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Picker("Model:", selection: self.$whisperModelSize) {
                    ForEach(self.whisperModels, id: \.self) { model in
                        HStack {
                            Text(self.modelDisplayName(model))
                            if self.downloadedModels.contains(model) {
                                Image(systemName: "arrow.down.circle.fill")
                                    .foregroundStyle(.green)
                                    .font(.caption2)
                            }
                        }
                        .tag(model)
                    }
                }
                .frame(maxWidth: 300)

                self.modelStatusView
            }
            .onChange(of: self.whisperModelSize) { _, newModel in
                self.downloadStarted = false
                if self.downloadedModels.contains(newModel) {
                    Task { await self.detector.whisperTranscriber.downloadModel(named: newModel) }
                } else {
                    Task { await self.detector.whisperTranscriber.resetState() }
                }
            }

            Text("Whisper runs locally on your device. Larger models are more accurate but use more memory.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var selectedModelIsDownloaded: Bool {
        self.downloadedModels.contains(self.whisperModelSize)
    }

    private func rescanDownloadedModels() {
        self.downloadedModels = WhisperTranscriber.scanDownloadedModels().0
    }

    /// Whether the actor's modelState refers to the currently selected model.
    private var stateIsForCurrentModel: Bool {
        self.detector.whisperTranscriber.currentModelName == self.whisperModelSize
    }

    /// The effective state for the currently selected model in the picker.
    private var effectiveModelState: WhisperModelState {
        if self.stateIsForCurrentModel {
            return self.detector.whisperModelState
        }
        // Actor hasn't caught up yet — show downloading(0) if user already clicked
        if self.downloadStarted {
            return .downloading(0)
        }
        return .idle
    }

    @ViewBuilder
    private var modelStatusView: some View {
        switch self.effectiveModelState {
        case .idle where self.selectedModelIsDownloaded:
            // Already on disk but not loaded yet — auto-load
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading model...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .onAppear {
                Task { await self.detector.whisperTranscriber.downloadModel(named: self.whisperModelSize) }
            }
        case .idle:
            Button("Download Model") {
                self.downloadStarted = true
                Task {
                    await self.detector.whisperTranscriber.downloadModel(named: self.whisperModelSize)
                    self.rescanDownloadedModels()
                    self.downloadStarted = false
                }
            }
        case .downloading(let progress):
            HStack(spacing: 6) {
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .frame(width: 80)
                Text("\(Int(progress * 100))%")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        case .loading:
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading model...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .ready:
            Label("Ready", systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        case .error(let message):
            HStack(spacing: 6) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(1)
                Button("Retry") {
                    Task {
                        await self.detector.whisperTranscriber.downloadModel(named: self.whisperModelSize)
                        self.rescanDownloadedModels()
                    }
                }
                .controlSize(.small)
            }
        }
    }

    // MARK: - Google Drive Sync

    @ViewBuilder
    private var syncSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Google Drive Sync")
                .font(.headline)

            if self.store.gogAvailable {
                Toggle(isOn: self.$syncEnabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sync meetings to Google Drive")
                        Text("Automatically upload meeting notes after saving.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if self.syncEnabled {
                    HStack(spacing: 8) {
                        Text("Drive Folder ID:")
                            .font(.callout)
                        TextField("e.g. 1ABC...xyz", text: self.$driveFolderId)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 300)
                    }
                }
            } else {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("gog CLI not found")
                            .font(.callout)
                        Text("Install with: brew install steipete/tap/gogcli")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.yellow)
                }
            }
        }
    }

    // MARK: - Past Meetings

    @ViewBuilder
    private var pastMeetingsButton: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Past Meetings")
                .font(.headline)
            Button("View Past Meetings...") {
                MeetingNotesWindowController.shared.show()
            }
        }
    }
}
