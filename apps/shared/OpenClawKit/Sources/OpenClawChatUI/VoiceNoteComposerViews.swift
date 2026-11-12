import SwiftUI

/// Host-provided voice-note recording state for the shared chat composer.
public struct OpenClawChatVoiceNoteControl {
    public var recorder: OpenClawVoiceNoteRecorder
    public var isTalkActive: Bool

    public init(recorder: OpenClawVoiceNoteRecorder, isTalkActive: Bool) {
        self.recorder = recorder
        self.isTalkActive = isTalkActive
    }
}

struct OpenClawVoiceNoteButton: View {
    let control: OpenClawChatVoiceNoteControl
    let isComposerEnabled: Bool
    let isAttachmentInputEnabled: Bool

    var isRecordingEnabled: Bool {
        self.isComposerEnabled
            && self.isAttachmentInputEnabled
            && !self.control.isTalkActive
            && !self.control.recorder.isRequestingPermission
    }

    var body: some View {
        Button {
            Task { await self.control.recorder.start() }
        } label: {
            if self.control.recorder.isRequestingPermission {
                ProgressView()
                    .controlSize(.mini)
            } else {
                Image(systemName: "mic")
                    .font(OpenClawChatTypography.display(size: 15, weight: .semibold, relativeTo: .subheadline))
            }
        }
        .help("Record Voice Note")
        .accessibilityLabel("Record voice note")
        .accessibilityIdentifier("chat-voice-note-record")
        .buttonStyle(.bordered)
        .controlSize(.small)
        .foregroundStyle(.secondary)
        .contentShape(Rectangle())
        .disabled(!self.isRecordingEnabled)
    }
}

struct OpenClawVoiceNoteRetainedRow: View {
    let note: OpenClawRetainedVoiceNote
    let onRetry: () -> Void
    let onDiscard: () -> Void
    var embedded = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "mic.fill")
                .font(OpenClawChatTypography.display(size: 13, weight: .semibold, relativeTo: .footnote))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 2) {
                Text(self.note.fileName)
                    .font(OpenClawChatTypography.body)
                    .lineLimit(1)
                Text("Too large to send. Remove an attachment or retry.")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Button(action: self.onRetry) {
                Text("Retry")
                    .font(OpenClawChatTypography.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Retry voice note")

            Button {
                self.onDiscard()
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Discard voice note")
        }
        .padding(.horizontal, self.embedded ? 2 : 14)
        .padding(.vertical, self.embedded ? 2 : 10)
        .background {
            if !self.embedded {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(OpenClawChatTheme.composerField)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(OpenClawChatTheme.composerBorder))
            }
        }
    }
}

struct OpenClawVoiceNoteRecordingRow: View {
    let recorder: OpenClawVoiceNoteRecorder
    var embedded = false

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(OpenClawChatTheme.danger)
                .frame(width: 9, height: 9)

            // Live capture wave replaces a static "Recording" label; the level is
            // real recorder metering, so silence reads flat and speech moves.
            TalkWaveformView(phase: .listening(level: self.recorder.level, speechActive: false))
                .frame(maxWidth: .infinity, minHeight: 26, maxHeight: 26)
                .accessibilityLabel("Recording")

            Text(openClawVoiceNoteDurationLabel(self.recorder.elapsedSeconds))
                .font(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote))
                .foregroundStyle(.secondary)

            Spacer(minLength: 8)

            Button {
                self.recorder.cancel()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Cancel voice note")

            Button {
                self.recorder.finish()
            } label: {
                Image(systemName: "checkmark")
            }
            .buttonStyle(.borderedProminent)
            .tint(OpenClawChatTheme.accent)
            .controlSize(.small)
            .accessibilityLabel("Finish voice note")
        }
        .padding(.horizontal, self.embedded ? 2 : 14)
        .padding(.vertical, self.embedded ? 2 : 10)
        .background {
            if !self.embedded {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(OpenClawChatTheme.composerField)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(OpenClawChatTheme.composerBorder))
            }
        }
    }
}
