import SwiftUI

struct DeepLinkAgentPromptAlert: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel

    private var promptBinding: Binding<NodeAppModel.AgentDeepLinkPrompt?> {
        Binding(
            get: { self.appModel.pendingAgentDeepLinkPrompt },
            set: { _ in
                // Keep prompt state until explicit user action.
            })
    }

    func body(content: Content) -> some View {
        content.alert(item: self.promptBinding) { prompt in
            Alert(
                title: Text("Run OpenClaw agent?"),
                message: Text(
                    """
                    Message:
                    \(prompt.messagePreview)

                    URL:
                    \(prompt.urlPreview)
                    """),
                primaryButton: .cancel(Text("Cancel")) {
                    self.appModel.declinePendingAgentDeepLinkPrompt()
                },
                secondaryButton: .default(Text("Run")) {
                    Task { await self.appModel.approvePendingAgentDeepLinkPrompt() }
                })
        }
    }
}

extension View {
    func deepLinkAgentPromptAlert() -> some View {
        self.modifier(DeepLinkAgentPromptAlert())
    }
}
