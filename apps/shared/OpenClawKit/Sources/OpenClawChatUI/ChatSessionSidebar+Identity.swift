#if os(macOS)
import SwiftUI

extension EnvironmentValues {
    @Entry public var openClawSidebarIdentityMenu: OpenClawSidebarIdentityMenu?
}

/// Presentation supplied by the app's existing Gateway and navigation owners.
public struct OpenClawSidebarIdentityMenu {
    let gatewayName: String?
    let isPrimary: Bool
    let content: AnyView

    public init(gatewayName: String?, isPrimary: Bool, @ViewBuilder content: () -> some View) {
        self.gatewayName = gatewayName
        self.isPrimary = isPrimary
        self.content = AnyView(content())
    }
}

extension ChatSessionSidebarModel {
    struct IdentitySubtitle: Equatable {
        let text: String
        let showsPrimary: Bool
        let isHealthy: Bool

        init(healthy: Bool, gatewayName: String?, isPrimary: Bool) {
            self.isHealthy = healthy
            self.text = healthy ? gatewayName ?? String(localized: "Gateway connected") :
                String(localized: "Connecting…")
            self.showsPrimary = healthy && gatewayName != nil && isPrimary
        }

        var connectionStatus: String {
            self.isHealthy ? String(localized: "Gateway connected") : String(localized: "Connecting…")
        }

        var accessibilityText: String {
            self.showsPrimary ? self.text + ", " + String(localized: "Primary") : self.text
        }
    }
}

extension ChatSessionSidebar {
    func identityFooter(now: Date) -> some View {
        HStack(spacing: 4) {
            ChatSidebarIdentityCard(viewModel: self.viewModel)
            HStack(spacing: 8) {
                if self.groupLoadFailed {
                    Button { self.groupRefreshNonce += 1 } label: {
                        Image(systemName: "arrow.clockwise")
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .help(String(localized: "Retry thread groups"))
                    .accessibilityLabel(String(localized: "Retry thread groups"))
                }
                if let summary = self.attentionSummary(
                    sessions: self.rosterData?.rows ?? self.viewModel.sessions, now: now)
                {
                    OpenClawChatAttentionBadge(
                        summary: summary,
                        targetID: "identity-footer",
                        presentation: self.$presentedAttention,
                        showsCount: true)
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .frame(minHeight: 44)
    }
}

private struct ChatSidebarIdentityCard: View {
    @Environment(\.openClawSidebarPeople) private var people
    @Environment(\.openClawSidebarIdentityMenu) private var identityMenu
    @State private var hovered = false
    let viewModel: OpenClawChatViewModel

    var body: some View {
        let person = self.people?.people.first { $0.id == self.people?.selfKey }
        let name = person?.label ?? String(localized: "Owner")
        let subtitle = ChatSessionSidebarModel.IdentitySubtitle(
            healthy: self.viewModel.healthOK,
            gatewayName: self.identityMenu?.gatewayName,
            isPrimary: self.identityMenu?.isPrimary == true)
        Menu {
            self.identityMenu?.content
            if !subtitle.isHealthy {
                Divider()
                Button("Retry now") {
                    Task {
                        await self.viewModel.pollHealthIfNeeded(force: true)
                        self.viewModel.refresh()
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                if let person {
                    ChatSidebarPersonAvatar(person: person, size: 28)
                } else {
                    Image(systemName: "person.crop.circle.fill")
                        .resizable().scaledToFit().frame(width: 28, height: 28)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: name)
                        .font(OpenClawChatTypography.body(size: 13.5, weight: .semibold, relativeTo: .body))
                    HStack(spacing: 6) {
                        Text(verbatim: subtitle.text)
                        if subtitle.showsPrimary { Text("Primary").fixedSize() }
                    }
                    .font(OpenClawChatTypography.body(size: 11, weight: .regular, relativeTo: .caption))
                    .foregroundStyle(subtitle.isHealthy ? Color.secondary : .orange)
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        // Native borderless menus discard custom label layout and can expose
        // a photo's intrinsic size. Keep the avatar's 28-point SwiftUI bounds.
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .background(self.hovered ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .onHover { self.hovered = $0 }
        .accessibilityLabel(Text(verbatim: name + ": " + subtitle.accessibilityText))
        .accessibilityValue(subtitle.connectionStatus)
        .accessibilityIdentifier("chat-sidebar-identity")
    }
}
#endif
