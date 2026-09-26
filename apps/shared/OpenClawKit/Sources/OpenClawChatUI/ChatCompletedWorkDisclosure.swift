import SwiftUI

struct ChatCompletedWorkDisclosure<Content: View>: View {
    let work: ChatTranscriptRow.CompletedWork
    @ViewBuilder let messageContent: (OpenClawChatMessage) -> Content
    // periphery:ignore - Read and written through $isExpanded; Xcode 27 omits the projected-binding reference.
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: self.$isExpanded) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(self.work.messages) { message in
                    self.messageContent(message)
                }
            }
            .padding(.top, 8)
        } label: {
            Text(self.label)
                .font(OpenClawChatTypography.caption)
                #if os(iOS)
                .foregroundStyle(Color.secondary)
                .frame(minHeight: 44)
                #else
                .foregroundStyle(.secondary)
                #endif
        }
        .accessibilityIdentifier("chat-completed-work-\(self.work.anchorID)")
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var label: String {
        guard let milliseconds = self.work.durationMilliseconds else { return String(localized: "Worked") }
        let duration = Duration.seconds(max(1, (milliseconds / 1000).rounded()))
            .formatted(.units(allowed: [.hours, .minutes, .seconds], width: .abbreviated))
        return String(format: String(localized: "Worked for %@"), duration)
    }
}
