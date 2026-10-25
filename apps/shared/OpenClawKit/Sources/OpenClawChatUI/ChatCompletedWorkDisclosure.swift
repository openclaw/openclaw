import SwiftUI

struct ChatCompletedWorkDisclosure<Content: View>: View {
    let work: ChatTranscriptRow.CompletedWork
    @ViewBuilder let messageContent: (OpenClawChatMessage) -> Content
    // periphery:ignore - Read and written through $localExpanded; Xcode 27 omits the projected-binding reference.
    @State private var localExpanded = false
    @Environment(\.openClawDisclosureExpansion) private var expansion

    var body: some View {
        DisclosureGroup(isExpanded: self.isExpanded) {
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

    /// The chat view owns the open folds: a row rebuilt under a new identity (its run group gains earlier
    /// rows when a page lands) keeps the fold the reader opened.
    private var isExpanded: Binding<Bool> {
        guard let expansion = self.expansion else { return self.$localExpanded }
        return Binding {
            expansion.isExpanded(self.work.anchorID)
        } set: { expanded in
            expansion.set(self.work.anchorID, expanded: expanded)
        }
    }

    private var label: String {
        guard let milliseconds = self.work.durationMilliseconds else { return String(localized: "Worked") }
        let duration = ChatWorkingDurationFormatter.compact(milliseconds: milliseconds)
        return String(format: String(localized: "Worked for %@"), duration)
    }
}

/// Which completed-work folds the reader opened, owned by the chat view rather than by a row.
@MainActor
@Observable
final class ChatDisclosureExpansion {
    private(set) var expanded: Set<UUID> = []

    func isExpanded(_ id: UUID) -> Bool {
        self.expanded.contains(id)
    }

    func set(_ id: UUID, expanded: Bool) {
        if expanded { self.expanded.insert(id) } else { self.expanded.remove(id) }
    }

    func reset() {
        self.expanded = []
    }
}

extension EnvironmentValues {
    @Entry var openClawDisclosureExpansion: ChatDisclosureExpansion?
}
