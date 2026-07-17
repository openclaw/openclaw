import AppKit
import Observation
import SwiftUI

@MainActor
struct QuickChatView: View {
    @Bindable var model: QuickChatModel
    let onDismiss: () -> Void
    let onSendAccepted: (Bool) -> Void
    let onContentHeightChange: (CGFloat) -> Void
    let onTextViewReady: (NSTextView) -> Void

    @State private var editorHeight: CGFloat = 30

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)

            VStack(spacing: 0) {
                self.inputRow

                if let status = self.statusLine {
                    HStack {
                        Text(status.message)
                            .font(.caption)
                            .foregroundStyle(status.isError ? Color.red : Color.orange)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 9)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                if self.model.shouldShowPermissionStrip {
                    self.permissionStrip
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .frame(width: 620)
        .fixedSize(horizontal: false, vertical: true)
        .animation(.spring(duration: 0.25), value: self.model.shouldShowPermissionStrip)
        .animation(.easeOut(duration: 0.14), value: self.statusLine?.message)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            self.onContentHeightChange(height)
        }
    }

    private var inputRow: some View {
        HStack(spacing: 10) {
            self.agentAvatar

            ZStack(alignment: .leading) {
                if self.model.text.isEmpty {
                    Text("Message \(self.model.agentDisplay.name)")
                        .font(.system(size: 13.5))
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 2)
                        .allowsHitTesting(false)
                }
                QuickChatTextView(
                    text: self.$model.text,
                    onSubmit: self.submit,
                    onEscape: self.onDismiss,
                    onHeightChange: { self.editorHeight = $0 },
                    onTextViewReady: self.onTextViewReady)
                    .frame(height: self.editorHeight)
            }
            .frame(maxWidth: .infinity)

            Text("main session")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(.quaternary, in: Capsule())

            Button {
                self.submit(openChat: false)
            } label: {
                Group {
                    switch self.model.sendState {
                    case .sending:
                        ProgressView()
                            .controlSize(.small)
                    case .sent:
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    case .idle, .failed:
                        Image(systemName: "arrow.up.circle.fill")
                            .foregroundStyle(self.model.canSend ? Color.accentColor : Color.secondary)
                    }
                }
                .font(.system(size: 22))
                .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .disabled(!self.model.canSend)
            .accessibilityLabel("Send message")
        }
        .padding(14)
    }

    private var agentAvatar: some View {
        ZStack {
            Circle()
                .fill(Color.primary.opacity(0.07))
            if let emoji = self.model.agentDisplay.emoji {
                Text(emoji)
                    .font(.system(size: 16))
            } else {
                Image(systemName: self.model.agentDisplay.avatarSymbolFallback)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 28, height: 28)
        .accessibilityLabel(self.model.agentDisplay.name)
    }

    private var permissionStrip: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.shield")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Needs additional permissions")
                        .font(.caption.weight(.semibold))
                    Text(self.model.missingPermissions.map(\.permissionDisplayName).joined(separator: ", "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Grant") {
                    self.model.grantMissingPermissions()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(self.model.isGrantingPermissions)
                Button("Not now") {
                    self.model.dismissPermissionsForSession()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(12)
        }
    }

    private var statusLine: (message: String, isError: Bool)? {
        if case let .failed(message) = self.model.sendState {
            return (message, true)
        }
        if let message = self.model.connectionStatusMessage {
            return (message, false)
        }
        return nil
    }

    private func submit(openChat: Bool) {
        guard self.model.canSend, let presentationID = self.model.activePresentationID else { return }
        Task {
            guard await self.model.send() else { return }
            if openChat {
                // The user may have dismissed (or reopened) the bar while the ack was in
                // flight; acting then would close the wrong presentation or steal focus.
                guard self.model.activePresentationID == presentationID else { return }
                self.onSendAccepted(true)
                return
            }
            // Plain Return lingers briefly on the checkmark before the bar dismisses itself.
            try? await Task.sleep(for: .seconds(0.45))
            guard self.model.activePresentationID == presentationID,
                  self.model.sendState == .sent,
                  self.model.text.isEmpty else { return }
            self.onSendAccepted(false)
        }
    }
}
