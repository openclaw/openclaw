import SwiftUI

struct ChatSubagentWaitRow: View {
    let wait: ChatSubagentWait
    let onSelect: @MainActor (String) -> Void

    var body: some View {
        HStack(spacing: 7) {
            ChatWorkingClawView(seed: "subagent-wait", parked: true)
            VStack(alignment: .leading, spacing: 1) {
                Text("Waiting on subagents")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                if let child = self.wait.child {
                    Button {
                        self.onSelect(child.key)
                    } label: {
                        Text(child.name)
                            .font(OpenClawChatTypography.caption)
                            .underline()
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("chat-subagent-wait-child")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }
}
