import SwiftUI

@MainActor
struct ChatDictationActivityRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let control: OpenClawChatDictationControl
    let onCancel: @MainActor () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            self.headerLayout {
                HStack(spacing: 8) {
                    if self.control.phase == .listening {
                        TalkWaveformView(phase: .listening(
                            level: self.control.level,
                            speechActive: !self.control.partialTranscript.isEmpty))
                            .frame(width: 28, height: 18)
                            .accessibilityHidden(true)
                    } else {
                        ProgressView().controlSize(.small)
                            .accessibilityHidden(true)
                    }
                    Text(self.phase.statusText)
                        .font(OpenClawChatTypography.captionSemiBold)
                        .accessibilityIdentifier("chat-dictation-status")
                }
                if !self.dynamicTypeSize.isAccessibilitySize {
                    Spacer(minLength: 0)
                }
                HStack(spacing: 8) {
                    Button(action: self.onCancel) {
                        Text("Cancel").font(OpenClawChatTypography.caption)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel dictation")
                    if self.control.phase == .listening {
                        Button(action: self.control.finish) {
                            Text("Done").font(OpenClawChatTypography.captionSemiBold)
                                .frame(minWidth: 44, minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(OpenClawChatTheme.accent)
                        .accessibilityLabel("Finish dictation")
                    }
                }
                .frame(maxWidth: self.dynamicTypeSize.isAccessibilitySize ? .infinity : nil, alignment: .trailing)
            }
            if !self.control.partialTranscript.isEmpty {
                Text(self.control.partialTranscript)
                    .font(OpenClawChatTypography.body)
                    .lineLimit(3)
                    .truncationMode(.head)
                    .accessibilityIdentifier("chat-dictation-transcript")
            } else if self.control.phase == .listening {
                Text("Speak now. Tap Done to add your words to the message.")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, self.dynamicTypeSize.isAccessibilitySize ? 10 : 0)
        .padding(.bottom, 10)
        .background(OpenClawChatTheme.subtleCard, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-dictation-activity")
    }

    private var phase: OpenClawChatDictationControl.Phase {
        self.control.phase == .idle ? .starting : self.control.phase
    }

    private var headerLayout: AnyLayout {
        self.dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(spacing: 8))
    }
}

struct ChatAttachmentActivityRow: View {
    let title: LocalizedStringKey

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
                .accessibilityHidden(true)
            Text(self.title)
                .font(OpenClawChatTypography.caption)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat-attachment-activity")
    }
}
