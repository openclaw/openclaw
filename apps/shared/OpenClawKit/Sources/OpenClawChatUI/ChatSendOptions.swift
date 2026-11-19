import SwiftUI

struct ChatSendModeMenuItems: View {
    let modes: [OpenClawChatQueueMode]
    let onSelect: (OpenClawChatQueueMode) -> Void

    var body: some View {
        ForEach(self.modes, id: \.self) { mode in
            Button {
                self.onSelect(mode)
            } label: {
                switch mode {
                case .steer:
                    Label("Steer now", systemImage: "arrow.turn.up.right")
                        .font(OpenClawChatTypography.body)
                case .followup:
                    Label("Queue next", systemImage: "clock")
                        .font(OpenClawChatTypography.body)
                }
            }
        }
    }
}

#if os(iOS)

struct ChatSendOptions<Options: View>: View {
    let defaultQueueMode: String?
    let options: Options

    init(defaultQueueMode: String?, @ViewBuilder options: () -> Options) {
        self.defaultQueueMode = defaultQueueMode
        self.options = options()
    }

    var body: some View {
        Menu {
            self.options
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("Send options").font(OpenClawChatTypography.caption)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .accessibilityHidden(true)
                }
                Text(self.defaultSendExplanation)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Send options")
        .accessibilityValue(Text(self.defaultSendExplanation))
        .accessibilityIdentifier("chat-send-options")
    }

    private var defaultSendExplanation: String {
        switch self.defaultQueueMode {
        case "collect": String(localized: "Default: Collect. Combine follow-ups after this reply.")
        case "steer": String(localized: "Default: Steer now. Guide the current reply.")
        case "followup": String(localized: "Default: Queue next. Send a separate follow-up after this reply.")
        default: String(localized: "Default: Gateway setting. Send uses the current queue behavior.")
        }
    }
}
#endif
