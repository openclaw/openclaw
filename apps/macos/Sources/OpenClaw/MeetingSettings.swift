import SwiftUI

struct MeetingSettings: View {
    @Bindable private var detector = MeetingDetector.shared
    @Bindable private var store = MeetingStore.shared
    @State private var selectedMeetingId: UUID?
    @State private var selectedMeeting: StoredMeeting?
    @AppStorage("meetingGoogleDriveSyncEnabled") private var syncEnabled = false
    @AppStorage("meetingGoogleDriveFolderId") private var driveFolderId = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.togglesSection
            Divider()
            self.syncSection
            Divider()
            self.meetingListSection
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear {
            self.store.loadAll()
        }
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

    // MARK: - Meeting list

    @ViewBuilder
    private var meetingListSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Past Meetings")
                    .font(.headline)
                Spacer()
                Text("\(self.store.summaries.count) meetings")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if self.store.summaries.isEmpty {
                Text("No meetings recorded yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 12)
            } else {
                HSplitView {
                    self.meetingsList
                        .frame(minWidth: 260, maxWidth: 320)

                    self.transcriptDetail
                        .frame(minWidth: 300, maxWidth: .infinity)
                }
                .frame(minHeight: 350)
            }
        }
    }

    private var meetingsList: some View {
        List(self.store.summaries, selection: self.$selectedMeetingId) { summary in
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(summary.title)
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        Text(summary.formattedDate)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(summary.formattedDuration)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(summary.segmentCount) segments")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                self.syncStatusIcon(for: summary.id)
            }
            .padding(.vertical, 4)
            .contextMenu {
                if self.store.gogAvailable, self.syncEnabled {
                    Button("Sync to Google Drive") {
                        self.store.retrySyncToGoogleDrive(id: summary.id)
                    }
                    Divider()
                }
                Button("Delete", role: .destructive) {
                    self.store.delete(id: summary.id)
                    if self.selectedMeetingId == summary.id {
                        self.selectedMeetingId = nil
                        self.selectedMeeting = nil
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .onChange(of: self.selectedMeetingId) { _, newId in
            if let newId {
                self.selectedMeeting = self.store.load(id: newId)
            } else {
                self.selectedMeeting = nil
            }
        }
    }

    @ViewBuilder
    private func syncStatusIcon(for meetingId: UUID) -> some View {
        if let status = self.store.syncStatuses[meetingId] {
            switch status {
            case .syncing:
                ProgressView()
                    .controlSize(.small)
            case .synced:
                Image(systemName: "checkmark.icloud.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            case .failed:
                Image(systemName: "exclamationmark.icloud.fill")
                    .foregroundStyle(.red)
                    .font(.caption)
            }
        }
    }

    @ViewBuilder
    private var transcriptDetail: some View {
        if let meeting = self.selectedMeeting {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text(meeting.title)
                        .font(.title3.weight(.semibold))
                        .padding(.bottom, 4)

                    if !meeting.attendees.isEmpty {
                        Text("Attendees: \(meeting.attendees.joined(separator: ", "))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.bottom, 8)
                    }

                    ForEach(Array(meeting.transcript.enumerated()), id: \.offset) { _, segment in
                        HStack(alignment: .top, spacing: 8) {
                            Text(segment.speaker == .me ? "You" : "Other")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(segment.speaker == .me ? .blue : .green)
                                .frame(width: 40, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(segment.text)
                                    .font(.callout)
                                    .textSelection(.enabled)
                                Text(Self.timeFormatter.string(from: segment.timestamp))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .padding()
            }
        } else {
            VStack {
                Spacer()
                Text("Select a meeting to view its transcript")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .medium
        return f
    }()
}
