#if os(iOS)
import SwiftUI
import UIKit

struct ChatPRSheetActions: ViewModifier {
    let viewModel: OpenClawChatViewModel
    let id: String
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content.toolbar {
            if let pr = self.viewModel.linkedPullRequests.first(where: { $0.id == self.id }),
               let url = URL(string: pr.url)
            {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            ChatPRVisibility.shared.setHidden(true, ids: [pr.id], in: self.viewModel.prVisibilityScope)
                            self.dismiss()
                        } label: { Label("Hide", systemImage: "eye.slash") }
                        Button { UIPasteboard.general.url = url } label: { Label("Copy link", systemImage: "link") }
                        ShareLink(item: url) { Label("Share…", systemImage: "square.and.arrow.up") }
                    } label: { Label("More actions", systemImage: "ellipsis").labelStyle(.iconOnly) }
                        .tint(.primary).accessibilityIdentifier("chat-activity-pr-menu")
                }
            }
        }
    }
}

public struct ChatPRRestoreMenu: View {
    private let model: OpenClawChatViewModel
    public init(viewModel: OpenClawChatViewModel) {
        self.model = viewModel
    }

    public var body: some View {
        let scope = self.model.prVisibilityScope
        let ids = ChatPRVisibility.shared.hidden(in: scope)
        let hidden = self.model.linkedPullRequests.filter { ids.contains($0.id.lowercased()) }
        if !hidden.isEmpty {
            Menu {
                ForEach(hidden, id: \.id) { pr in
                    let sameNumber = hidden.contains { $0.number == pr.number && $0.id != pr.id }
                    let reference = sameNumber ? pr.id : "#\(pr.number)"
                    Button { ChatPRVisibility.shared.setHidden(false, ids: [pr.id], in: scope) } label: {
                        Label(String(format: String(localized: "Show %@"), reference), systemImage: "eye")
                    }
                }
                if hidden.count > 1 {
                    Button { ChatPRVisibility.shared.setHidden(false, ids: hidden.map(\.id), in: scope) } label: {
                        Label("Show all", systemImage: "eye")
                    }
                }
            } label: { Label("Pull requests", systemImage: "arrow.triangle.branch") }
        }
    }
}
#endif
