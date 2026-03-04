import SwiftUI

struct MeetingMenuItems: View {
    @Bindable private var detector = MeetingDetector.shared

    var body: some View {
        if self.detector.meetingDetectionEnabled {
            if let session = self.detector.currentSession {
                self.activeMeetingSection(session: session)
            } else {
                Button {
                    Task { await self.detector.startMeeting() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "record.circle")
                        Text("Start Meeting Notes")
                        Spacer()
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .controlSize(.regular)
            }

            Button {
                MeetingNotesWindowController.shared.show()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "list.bullet.rectangle")
                    Text("Past Meetings")
                }
            }

        }
    }

    @ViewBuilder
    private func activeMeetingSection(session: MeetingSession) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "record.circle.fill")
                .foregroundStyle(.red)
            Text(session.title)
                .lineLimit(1)
        }

        Button {
            Task { await self.detector.stopMeeting() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "stop.circle.fill")
                Text("Stop Meeting Notes")
                Spacer()
            }
        }
        .buttonStyle(.borderedProminent)
        .tint(.orange)
        .controlSize(.regular)
    }
}
