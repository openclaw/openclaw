import OpenClawChatUI
import SwiftUI

struct ChatInfoAvatar: View {
    let visit: ChatInfoVisit
    let size: CGFloat

    var body: some View {
        Group {
            if let image = self.visit.avatar {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(verbatim: self.visit.badge).font(OpenClawType.avatar(size: self.size > 40 ? 34 : self.size * 0.45))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: self.size, height: self.size)
        .background(Color(.sRGB, red: 56 / 255, green: 57 / 255, blue: 54 / 255)).clipShape(Circle())
        .accessibilityHidden(true)
    }
}

/// Says which agent owns this chat. Static: the agent profile opens only from the main chat header.
struct ChatInfoAgentRow: View {
    let visit: ChatInfoVisit

    var body: some View {
        HStack(spacing: 7) {
            ChatInfoAvatar(visit: self.visit, size: 22)
            Text(verbatim: self.visit.agentName).font(OpenClawType.subheadMedium)
                .foregroundStyle(OpenClawBrand.textSecondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: String(format: String(localized: "Agent, %@"), self.visit.agentName)))
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier("chat-info-agent-row")
    }
}

/// One titled card per section; the trailing slot holds a quiet link at the title's own size.
struct ChatInfoSection<Trailing: View, Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // The link rides on the title's baseline without changing the header's height.
            Text(self.title).font(OpenClawType.footnoteSemiBold).foregroundStyle(OpenClawBrand.textSecondary)
                .accessibilityAddTraits(.isHeader)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: Alignment(horizontal: .trailing, vertical: .firstTextBaseline)) { self.trailing() }
                .padding(.horizontal, 16)
            self.content().frame(maxWidth: .infinity, alignment: .leading)
                .background(OpenClawBrand.surfaceRaised, in: .rect(cornerRadius: 24))
        }
    }
}

extension ChatInfoSection where Trailing == EmptyView {
    init(_ title: LocalizedStringKey, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, trailing: { EmptyView() }, content: content)
    }
}

/// Environment and the catalog states share the leading column and grouped row insets.
private struct ChatInfoIconRow<Content: View>: View {
    let symbol: String
    let tint: Color
    @ViewBuilder let content: () -> Content
    @ScaledMetric(relativeTo: .body) private var mark: CGFloat = 19

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: self.symbol).foregroundStyle(self.tint)
                .frame(width: self.mark).accessibilityHidden(true)
            self.content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
    }
}

struct ChatInfoDiscoveryRow: View {
    enum State { case empty, loading, failed }

    let symbol: String
    let title: String
    let detail: String
    let failure: String
    let state: State
    let retry: () -> Void

    var body: some View {
        if self.state == .failed {
            Button(action: self.retry) { self.row.contentShape(.rect) }
                .buttonStyle(.plain).accessibilityHint(Text("Try again"))
        } else {
            self.row
        }
    }

    private var row: some View {
        ChatInfoIconRow(symbol: self.symbol, tint: OpenClawBrand.textTertiary) {
            // Both text assemblies participate in measurement; a slow/failed read never moves the next heading.
            ZStack(alignment: .leading) {
                let empty = VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: self.title).font(OpenClawType.body)
                    Text(verbatim: self.detail).font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.textSecondary)
                }
                // The trailing glyph is the only retry cue; it sits on the text line, so the row keeps its height.
                let failed = HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: self.failure).font(OpenClawType.body)
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.clockwise").font(OpenClawType.body)
                        .foregroundStyle(OpenClawBrand.textTertiary).accessibilityHidden(true)
                }
                if self.state == .empty { empty } else { empty.hidden().accessibilityHidden(true) }
                if self.state == .failed { failed } else { failed.hidden().accessibilityHidden(true) }
                if self.state == .loading {
                    Capsule().fill(OpenClawBrand.textTertiary.opacity(0.25)).frame(width: 104, height: 5)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityHidden(self.state == .loading)
    }
}

struct ChatInfoEnvironmentRow: View {
    let environment: ChatInfoEnvironment
    let changes: ChatInfoCheckoutChanges?
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        ChatInfoIconRow(symbol: "arrow.triangle.branch", tint: OpenClawBrand.textSecondary) {
            VStack(alignment: .leading, spacing: 2) {
                let layout = self.type.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) :
                    AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                layout {
                    if let project = self.environment.project { Text(verbatim: project).font(OpenClawType.body) }
                    if self.environment.worktree {
                        if !self.type.isAccessibilitySize { Spacer(minLength: 0) }
                        Text("Worktree").font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.textSecondary)
                    }
                }
                if let branch = self.environment.branch {
                    Text(verbatim: branch).font(OpenClawType.monoFootnote).foregroundStyle(OpenClawBrand.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let changes {
                    OpenClawChatLineCounts(additions: changes.additions, deletions: changes.deletions)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One row: usage ring, percent and token counts, Compact on the trailing edge.
struct ChatInfoContext: View {
    let usage: OpenClawChatContextUsage
    let canCompact: Bool
    let compact: () -> Void
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        let layout = self.type.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) :
            AnyLayout(HStackLayout(alignment: .center, spacing: 14))
        layout {
            HStack(spacing: 14) {
                if let fraction = self.usage.fractionUsed {
                    ZStack {
                        Circle().stroke(OpenClawBrand.selection, lineWidth: 5)
                        Circle().trim(from: 0, to: fraction).stroke(OpenClawBrand.textStrong, lineWidth: 5)
                            .rotationEffect(.degrees(-90))
                    }.frame(width: 25, height: 25).padding(2.5).accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 1) {
                    let count = ChatCompactTokenCountFormatter.string(Double(self.usage.usedTokens))
                    if let percent = self.usage.percentUsed {
                        Text(verbatim: String(format: String(localized: "%lld%% used"), percent))
                            .font(OpenClawType.body)
                    }
                    if let total = self.usage.contextWindowTokens {
                        let window = ChatCompactTokenCountFormatter.string(Double(total))
                        Text(verbatim: String(format: String(localized: "%@ of %@ tokens"), count, window))
                            .font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.textSecondary)
                    } else {
                        Text(verbatim: String(format: String(localized: "%@ tokens used"), count))
                            .font(OpenClawType.body)
                    }
                }.fixedSize(horizontal: false, vertical: true)
            }.accessibilityElement(children: .combine)
            if !self.type.isAccessibilitySize { Spacer(minLength: 0) }
            Button(action: self.compact) {
                Text("Compact").font(OpenClawType.subheadMedium).padding(.horizontal, 15).padding(.vertical, 7)
                    .background(.quaternary, in: Capsule()).frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!self.canCompact)
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
    }
}
