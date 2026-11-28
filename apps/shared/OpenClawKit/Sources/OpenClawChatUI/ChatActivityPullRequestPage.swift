#if os(iOS)
import SwiftUI
import UIKit

struct ChatActivityPullRequestPage: View {
    let viewModel: OpenClawChatViewModel
    let pullRequestID: String
    @Environment(\.openURL) private var openURL

    @State private var overview: ChatPRReaderOverview?

    var body: some View {
        let snapshot = self.viewModel.sessionPullRequests?.key == self.viewModel.sessionKey
            ? self.viewModel.sessionPullRequests?.snapshot : nil
        let pr = snapshot.flatMap { ChatActivityPullRequest.list($0).first { $0.id == self.pullRequestID } }
        let url = pr.flatMap { URL(string: $0.url) }
        let page = ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let pr, let snapshot {
                    ChatPRHeader(pr: pr, reader: self.overview?.url == pr.url ? self.overview : nil)
                    let counts = pr.liveChecks(status: snapshot.status).map(ChatActivityCheckRow.rows) ?? []
                    if !counts.isEmpty {
                        ChatPRGroupedCard {
                            if let first = counts.first {
                                self.detailRow(
                                    "Checks",
                                    symbol: "checklist",
                                    value: counts.map(\.label).joined(separator: ", "),
                                    mark: first.kind == .passed && counts.count > 1 ? nil : first.kind)
                                if self.overview?.url == pr.url, let items = self.overview?.checks?.items {
                                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                                        Divider()
                                        HStack(spacing: 10) {
                                            if item.state == "success" || item.state == "failure" {
                                                ChatPRCheckMark(kind: item.state == "success" ? .passed : .failed)
                                            }
                                            Text(verbatim: item.name).font(OpenClawChatTypography.settingsBody)
                                                .fixedSize(horizontal: false, vertical: true)
                                            Spacer(minLength: 0)
                                        }.padding(.vertical, 10)
                                    }
                                }
                            }
                        }
                    }
                    if pr.details != nil, snapshot.status != "ready" {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(snapshot.status == "rate-limited"
                                ?
                                LocalizedStringKey(
                                    "GitHub limited updates for now. These are the last details received.")
                                : LocalizedStringKey("Couldn’t reach GitHub. These are the last details received."))
                                .font(.footnote).foregroundStyle(.secondary)
                            Button { self.viewModel.retrySessionPullRequests() } label: { Text("Try again") }
                                .accessibilityIdentifier("chat-activity-try-again")
                        }
                    }
                } else {
                    Text("This pull request is no longer linked to the chat.").foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
        }
        .modifier(ChatSafeAreaBar(edge: .bottom) {
            if let url {
                Button { self.openURL(url) } label: {
                    Text("Open on GitHub")
                        .font(OpenClawChatTypography.settingsBody).fontWeight(.semibold)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .modifier(ChatPRButtonStyle())
                .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
                .accessibilityIdentifier("chat-activity-pr-open")
            }
        })
        .task(id: pr?.url) {
            self.overview = nil
            guard let pr, let reader = self.viewModel.transport as? any ChatPRReaderTransport,
                  let data = try? await reader.pullRequestOverview(url: pr.url, sessionKey: self.viewModel.sessionKey),
                  !Task.isCancelled else { return }
            self.overview = ChatPRReaderOverview.decode(data, for: pr.url)
        }
        .navigationTitle(Text("Pull request"))
        .toolbarBackground(.hidden, for: .navigationBar)

        if #available(iOS 26, *) {
            page.scrollEdgeEffectStyle(.soft, for: .bottom)
        } else {
            page
        }
    }

    private func detailRow(
        _ label: LocalizedStringKey,
        symbol: String,
        value: String,
        mark: ChatActivityCheckRow.Kind? = nil) -> some View
    {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 20).accessibilityHidden(true)
            Text(label).foregroundStyle(.primary)
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                switch mark {
                case .running:
                    Circle().fill(.secondary).frame(width: 7, height: 7).frame(width: 12, height: 12)
                        .accessibilityHidden(true)
                case .failed, .passed:
                    if let mark { ChatPRCheckMark(kind: mark) }
                case .skipped, nil:
                    EmptyView()
                }
                Text(verbatim: value).monospacedDigit().foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(minHeight: 52)
        .accessibilityElement(children: .combine)
    }
}

/// Only the rows are clipped to the grouped card; a list cell would clip the eyebrow and branch
/// to its rounded corners even with a transparent background.
private struct ChatPRGroupedCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) { self.content() }
            .padding(.horizontal, 20)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 26))
    }
}

private struct ChatPRHeader: View {
    let pr: ChatActivityPullRequest
    let reader: ChatPRReaderOverview?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 9) {
                self.badge
                self.reference
                Spacer(minLength: 3)
                if let date = self.reader?.date {
                    Text(date, format: .dateTime.month(.abbreviated).day())
                        .font(OpenClawChatTypography.footnote).foregroundStyle(.secondary).fixedSize()
                }
            }
            self.headline
            HStack(spacing: 10) { self.byline
                Spacer(minLength: 8)
                self.totals
            }
            self.branch
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var headline: some View {
        if let title = self.pr.title, !title.isEmpty {
            Text(verbatim: title).font(OpenClawChatTypography.body(size: 22, weight: .bold, relativeTo: .title2))
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("chat-activity-pr-title")
        }
    }

    private var reference: some View {
        HStack(spacing: 3) {
            Text(verbatim: "\(self.pr.owner)/\(self.pr.repo)").truncationMode(.middle)
            Text(verbatim: "#\(self.pr.number)").fixedSize()
        }
        .font(OpenClawChatTypography.footnote).foregroundStyle(.secondary).lineLimit(1)
        .accessibilityElement(children: .combine).accessibilityIdentifier("chat-activity-pr-identity")
    }

    @ViewBuilder private var badge: some View {
        if let details = self.pr.details, let state = ChatPullRequestState(rawValue: details.state) {
            HStack(spacing: 5) {
                ChatPRStateGlyph(state: state, size: 12)
                Text(verbatim: ChatActivityRules.pullRequestStateLabel(state.rawValue))
                    .font(OpenClawChatTypography.footnoteSemiBold)
            }
            .foregroundStyle(state.ink).padding(.horizontal, 8).padding(.vertical, 4)
            .background(state.ink.opacity(0.14), in: Capsule()).fixedSize()
            .accessibilityElement(children: .combine).accessibilityIdentifier("chat-activity-pr-state")
        }
    }

    @ViewBuilder private var byline: some View {
        if let author = self.pr.details?.author?.login, !author.isEmpty {
            HStack(spacing: 8) {
                self.avatar(author, size: 24)
                Text(verbatim: author).font(OpenClawChatTypography.callout).fontWeight(.medium)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func avatar(_ author: String, size: CGFloat) -> some View {
        ZStack {
            Circle().fill(Color.secondary.opacity(0.20))
            Text(verbatim: String(author.prefix(1)).uppercased())
                .font(OpenClawChatTypography.avatar(size: size * 0.48)).foregroundStyle(.secondary)
            if let image = self.reader?.avatar, self.reader?.author == author {
                Image(uiImage: image).resizable().scaledToFill()
            }
        }
        .frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
    }

    private var totals: some View {
        HStack(spacing: 8) {
            if let files = self.pr.details?.changedFiles {
                Text(files == 1 ? "1 file" : "\(files) files").foregroundStyle(.secondary)
            }
            OpenClawChatLineCounts(additions: self.pr.details?.additions, deletions: self.pr.details?.deletions)
        }
        .font(OpenClawChatTypography.footnote).monospacedDigit().accessibilityElement(children: .combine)
    }

    private var branchText: some View {
        Text(verbatim: self.pr.branch).font(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote))
            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("chat-activity-pr-branch")
    }

    @ViewBuilder private var branch: some View {
        if !self.pr.branch.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch").font(.footnote).foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                self.branchText
            }
        }
    }
}

private struct ChatPRButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glass).buttonBorderShape(.capsule).tint(.primary)
        } else {
            content.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(.primary)
        }
    }
}

/// Signed checkout and pull-request counts share visible and spoken formatting.
public struct OpenClawChatLineCounts: View {
    let additions: Int?
    let deletions: Int?

    public init(additions: Int?, deletions: Int?) {
        self.additions = additions
        self.deletions = deletions
    }

    public var body: some View {
        HStack(spacing: 5) {
            if let n = self.additions, n > 0 {
                Text(verbatim: "+\(n.formatted())").foregroundStyle(ChatPRInk.green)
                    .accessibilityLabel(n == 1 ? Text("1 line added") : Text(verbatim: String(
                        format: String(localized: "%lld lines added"),
                        n)))
            }
            if let n = self.deletions, n > 0 {
                Text(verbatim: "−\(n.formatted())").foregroundStyle(ChatPRInk.red)
                    .accessibilityLabel(n == 1 ? Text("1 line removed") : Text(verbatim: String(
                        format: String(localized: "%lld lines removed"),
                        n)))
            }
        }
        .font(OpenClawChatTypography.footnote).monospacedDigit()
    }
}
#endif
