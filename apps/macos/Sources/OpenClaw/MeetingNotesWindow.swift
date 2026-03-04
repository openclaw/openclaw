import AppKit
import SwiftUI

@MainActor
final class MeetingNotesWindowController {
    static let shared = MeetingNotesWindowController()
    private var window: NSWindow?

    func show() {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: MeetingNotesView())
        let window = NSWindow(contentViewController: hosting)
        window.title = "Meeting Notes"
        window.setContentSize(NSSize(width: 900, height: 600))
        window.styleMask = [.titled, .closable, .resizable, .miniaturizable]
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }
}

struct MeetingNotesView: View {
    @Bindable private var store = MeetingStore.shared
    @State private var selectedMeetingIds: Set<UUID> = []
    @State private var selectedMeeting: StoredMeeting?
    @AppStorage("meetingGoogleDriveSyncEnabled") private var syncEnabled = false

    var body: some View {
        Group {
            if self.store.summaries.isEmpty {
                VStack {
                    Spacer()
                    Text("No meetings recorded yet.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
            } else {
                HSplitView {
                    self.meetingsList
                        .frame(minWidth: 260, maxWidth: 320)

                    self.transcriptDetail
                        .frame(minWidth: 300, maxWidth: .infinity)
                }
            }
        }
        .frame(minWidth: 700, minHeight: 400)
        .onAppear {
            self.store.loadAll()
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Text("\(self.store.summaries.count) meetings")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ToolbarItem(placement: .automatic) {
                Button {
                    self.deleteSelected()
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .keyboardShortcut(.delete, modifiers: [])
                .disabled(self.selectedMeetingIds.isEmpty)
            }
        }
    }

    private var meetingsList: some View {
        List(self.store.summaries, selection: self.$selectedMeetingIds) { summary in
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
                let count = self.selectedMeetingIds.contains(summary.id) ? self.selectedMeetingIds.count : 1
                Button("Delete\(count > 1 ? " \(count) Meetings" : "")", role: .destructive) {
                    if self.selectedMeetingIds.contains(summary.id) {
                        self.deleteSelected()
                    } else {
                        self.store.delete(id: summary.id)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .onChange(of: self.selectedMeetingIds) { _, newIds in
            if newIds.count == 1, let id = newIds.first {
                self.selectedMeeting = self.store.load(id: id)
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
        } else if self.selectedMeetingIds.count > 1 {
            VStack {
                Spacer()
                Text("\(self.selectedMeetingIds.count) meetings selected")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
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

    private func deleteSelected() {
        let ids = self.selectedMeetingIds
        guard !ids.isEmpty else { return }
        self.selectedMeetingIds = []
        self.selectedMeeting = nil
        for id in ids {
            self.store.delete(id: id)
        }
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .medium
        return f
    }()
}
