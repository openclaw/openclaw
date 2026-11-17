import OpenClawKit
import SwiftUI

struct ChatCompletedWorkDisclosure<Content: View>: View {
    let work: ChatTranscriptRow.CompletedWork
    @ViewBuilder let messageContent: (OpenClawChatMessage) -> Content
    // periphery:ignore - Read and written through $isExpanded; Xcode 27 omits the projected-binding reference.
    @State private var isExpanded = false

    var body: some View {
        self.segment
    }

    private var segment: some View {
        self.disclosure(label: self.label, icon: self.segmentIcon, expanded: self.$isExpanded) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(self.work.messages, id: \.presentationID) { message in
                    self.messageContent(message)
                }
            }
            .padding(.top, 8)
        }
    }

    private func disclosure(
        label: String,
        icon: String? = nil,
        expanded: Binding<Bool>,
        @ViewBuilder content: @escaping () -> some View) -> some View
    {
        DisclosureGroup(isExpanded: expanded, content: content) {
            HStack(spacing: 6) {
                if let icon {
                    Image(systemName: icon).accessibilityHidden(true)
                }
                Text(label)
            }
            .font(OpenClawChatTypography.caption)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(.secondary)
            #if os(iOS)
            .frame(minHeight: 44)
            #endif
        }
        #if os(iOS)
        .disclosureGroupStyle(ChatCompletedWorkDisclosureStyle())
        #endif
        .accessibilityIdentifier("chat-completed-work-\(self.work.anchorID)")
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var segmentIcon: String {
        guard self.work.isLive, let latest = ChatCompletedWorkSummary.latestItem(work: self.work) else {
            return "list.bullet"
        }
        let call = ToolDisplayRegistry.displayCall(name: latest.name, args: latest.arguments)
        let display = ToolDisplayRegistry.resolve(name: call.name, args: call.args)
        return ChatToolIcon.symbol(for: display.name, icon: display.icon)
    }

    private var label: String {
        guard self.work.isLive else {
            return ChatCompletedWorkSummary.label(work: self.work, expanded: self.isExpanded)
        }
        return ChatCompletedWorkSummary.liveLabel(work: self.work)
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
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(configuration.isExpanded ? Text("Expanded") : Text("Collapsed"))
            if configuration.isExpanded {
                configuration.content
            }
        }
    }
}
#endif
