import SwiftUI

struct ChatCompletedWorkDisclosure<Content: View>: View {
    let work: ChatTranscriptRow.CompletedWork
    @ViewBuilder let messageContent: (OpenClawChatMessage) -> Content
    // periphery:ignore - Read and written through $isExpanded; Xcode 27 omits the projected-binding reference.
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: self.$isExpanded) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(self.work.messages, id: \.presentationID) { message in
                    self.messageContent(message)
                }
            }
            .padding(.top, 8)
        } label: {
            Text(self.label)
                .font(OpenClawChatTypography.caption)
                .fixedSize(horizontal: false, vertical: true)
                #if os(iOS)
                .foregroundStyle(Color.secondary)
                .frame(minHeight: 44)
                #else
                .foregroundStyle(.secondary)
                #endif
        }
        #if os(iOS)
        .disclosureGroupStyle(ChatCompletedWorkDisclosureStyle())
        #endif
        .accessibilityIdentifier("chat-completed-work-\(self.work.anchorID)")
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var label: String {
        ChatCompletedWorkSummary.label(work: self.work, expanded: self.isExpanded)
    }
}

#if os(iOS)
private struct ChatCompletedWorkDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                configuration.isExpanded.toggle()
            } label: {
                HStack {
                    configuration.label
                    Spacer(minLength: 8)
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? Text("Expanded") : Text("Collapsed"))
            if configuration.isExpanded {
                configuration.content
            }
        }
    }
}
#endif
