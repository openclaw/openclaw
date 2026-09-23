import SwiftUI

struct DeepLinkAgentPromptAlert: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    #if DEBUG
    @Environment(NativeActionRouter.self) private var nativeActions: NativeActionRouter?
    #endif

    private var promptBinding: Binding<NodeAppModel.AgentDeepLinkPrompt?> {
        Binding(
            get: {
                let prompt = self.appModel.pendingAgentDeepLinkPrompt
                #if DEBUG
                self.nativeActions?.testLifetimeObservation?("deep-link-prompt-read present=\(prompt != nil)")
                #endif
                return prompt
            },
            set: { _ in
                // Keep prompt state until explicit user action.
            })
    }

    func body(content: Content) -> some View {
        content.alert(item: self.promptBinding) { prompt in
            Alert(
                title: Text("Run OpenClaw agent?")
                    .font(OpenClawType.headline),
                message: Text(verbatim: String(
                    format: String(localized: """
                    Message:
                    %1$@

                    URL:
                    %2$@
                    """),
                    prompt.messagePreview,
                    prompt.urlPreview))
                    .font(OpenClawType.subhead),
                primaryButton: .cancel(
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold))
                {
                    self.appModel.declinePendingAgentDeepLinkPrompt()
                },
                secondaryButton: .default(
                    Text("Run")
                        .font(OpenClawType.subheadSemiBold))
                {
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
