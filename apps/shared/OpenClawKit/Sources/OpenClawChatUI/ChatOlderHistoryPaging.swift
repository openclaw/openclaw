#if os(iOS)
import SwiftUI

/// Reader-driven older history for the iOS transcript List (web `ui/src/pages/chat/chat-pane-history.ts:292-381`).
/// It only loads; `ChatReadingPosition` keeps the rows on screen still while the page is prepended.
@MainActor
final class ChatOlderHistoryReader {
    /// Web `CHAT_HISTORY_PREFETCH_EDGE_PX` (`chat-pane-shared.ts:128`).
    static let prefetchEdge: CGFloat = 1200

    private var lastTopDistance: CGFloat?

    /// True when the reader's own upward scroll moves within the prefetch edge. Layout-driven
    /// offset changes (prepends, keyboard, following) never count as intent.
    func observe(topDistance: CGFloat, readerScrolling: Bool) -> Bool {
        defer { self.lastTopDistance = topDistance }
        guard readerScrolling, let last = self.lastTopDistance else { return false }
        return topDistance < last && topDistance <= Self.prefetchEdge
    }

    func load(_ viewModel: OpenClawChatViewModel, readingPosition: ChatReadingPosition) {
        guard viewModel.canLoadOlderHistory, !viewModel.isLoadingOlderHistory else { return }
        viewModel.olderHistoryWillPrepend = { [weak readingPosition] in readingPosition?.olderPageWillPrepend() }
        Task { @MainActor in await viewModel.loadOlderHistory() }
    }

    func reset() {
        self.lastTopDistance = nil
    }
}

extension View {
    /// Requests the next older page after an upward reader scroll near the top of the transcript.
    func chatOlderHistoryTrigger(
        _ reader: ChatOlderHistoryReader,
        viewModel: OpenClawChatViewModel,
        scroll: ChatScrollFollowState,
        load: @escaping @MainActor () -> Void) -> some View
    {
        self.onScrollGeometryChange(for: CGFloat.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top
        } action: { _, topDistance in
            // A failed read stays manual until "Show earlier" succeeds (web `chat-pane-history.ts:332-337`).
            guard reader.observe(topDistance: topDistance, readerScrolling: scroll.isUserScrolling),
                  viewModel.canLoadOlderHistory, !viewModel.isLoadingOlderHistory,
                  !viewModel.olderHistoryLoadFailed else { return }
            load()
        }
    }
}

/// First List row while older history exists. Its height is constant across idle, loading and
/// failed states so the rows below it never move until a page is prepended.
struct ChatOlderHistoryBoundaryRow: View {
    let viewModel: OpenClawChatViewModel
    let load: @MainActor () -> Void

    var body: some View {
        if self.viewModel.canLoadOlderHistory {
            ZStack {
                if self.viewModel.isLoadingOlderHistory {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel(Text("Loading earlier messages"))
                } else if self.viewModel.olderHistoryLoadFailed {
                    Button(action: self.load) {
                        Text("Show earlier")
                            .font(OpenClawChatTypography.footnote)
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("chat-older-history-retry")
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
    }
}
#endif
