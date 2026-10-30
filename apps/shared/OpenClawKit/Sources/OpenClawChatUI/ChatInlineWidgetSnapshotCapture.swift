#if canImport(WebKit) && (os(iOS) || os(macOS))
import Foundation
import WebKit

struct ChatInlineWidgetSnapshotRequest: Equatable {
    enum Action: Equatable {
        case copy
        case save
    }

    let id = UUID()
    let action: Action
    let generation: UUID
    let resource: OpenClawChatWidgetResource
}

enum ChatInlineWidgetSnapshotOutcome {
    case success(ChatInlineWidgetSnapshotRequest, OpenClawPlatformImage)
    case failure(ChatInlineWidgetSnapshotRequest)
}

@MainActor
final class ChatInlineWidgetSnapshotCapture {
    private var request: ChatInlineWidgetSnapshotRequest?
    private weak var webView: WKWebView?

    func capture(
        _ request: ChatInlineWidgetSnapshotRequest?,
        from webView: WKWebView,
        generation: UUID,
        resource: OpenClawChatWidgetResource,
        onSnapshot: @escaping @MainActor @Sendable (ChatInlineWidgetSnapshotOutcome) -> Void)
    {
        if self.webView !== webView || self.request?.generation != generation || self.request?.resource != resource {
            self.invalidate()
        }
        guard let request,
              request.generation == generation,
              request.resource == resource,
              request.id != self.request?.id
        else { return }
        self.request = request
        self.webView = webView

        webView.takeSnapshot(with: WKSnapshotConfiguration()) { [weak self, weak webView] image, _ in
            guard let self,
                  let webView,
                  self.request == request,
                  self.webView === webView
            else { return }
            self.invalidate()
            onSnapshot(image.map { .success(request, $0) } ?? .failure(request))
        }
    }

    func invalidate() {
        self.request = nil
        self.webView = nil
    }
}
#endif
