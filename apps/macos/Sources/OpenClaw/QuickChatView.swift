import AppKit
import Observation
import OpenClawChatUI
import SwiftUI

@MainActor
struct QuickChatView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast

    @Bindable var model: QuickChatModel
    @Bindable var replyBinding: QuickChatReplyBinding
    let onDismiss: () -> Void
    let onSendAccepted: (Bool) -> Void
    let onShowAgentPicker: () -> Void
    let onShowModelMenu: () -> Void
    let onShowRecentSessions: () -> Void
    let onToggleReply: () -> Void
    let onToggleDictation: () -> Void
    let onStopDictation: () -> Void
    let onCaptureTextContext: () -> Void
    let onShowCaptureMenu: () -> Void
    let onGrantPermissions: () -> Void
    let onPasteReply: () -> Void
    let onContentHeightChange: (CGFloat) -> Void
    let onTextViewReady: (NSTextView) -> Void

    @State private var editorHeight: CGFloat = 34

    private var isExpanded: Bool {
        self.replyBinding.isExpanded
    }

    private var accent: Color {
        OpenClawChatTheme.desktopAccent(in: self.colorScheme)
    }

    private var surface: Color {
        OpenClawChatTheme.desktopComposer(in: self.colorScheme)
    }

    private var border: Color {
        Color.primary.opacity(self.contrast == .increased ? 0.3 : 0.08)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Keep the transcript mounted so reopening does not reload and reset a live reply.
            if let viewModel = self.replyBinding.viewModel, self.replyBinding.route != nil {
                VStack(spacing: 0) {
                    self.header
                    self.replyArea(viewModel: viewModel)
                }
                .frame(height: self.isExpanded ? nil : 0)
                .clipped()
                .allowsHitTesting(self.isExpanded)
                .accessibilityHidden(!self.isExpanded)
            }

            if let status = self.statusLine {
                Label(status.message, systemImage: status.isError ? "exclamationmark.circle" : "info.circle")
                    .font(.system(size: 12))
                    .foregroundStyle(status.isError ? Color.red : Color.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
            }

            if self.model.shouldShowPermissionStrip {
                self.permissionStrip
            }

            self.composer
                .padding(self.isExpanded ? 12 : 0)
        }
        .frame(width: 620)
        .fixedSize(horizontal: false, vertical: true)
        .foregroundStyle(OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.contrast))
        .tint(self.accent)
        .background(OpenClawChatTheme.desktopCanvas(in: self.colorScheme), in: .rect(cornerRadius: 20))
        .clipShape(.rect(cornerRadius: 20))
        .overlay {
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(self.border, lineWidth: 1)
                .allowsHitTesting(false)
        }
        .animation(self.reduceMotion ? nil : .spring(duration: 0.25), value: self.isExpanded)
        .animation(self.reduceMotion ? nil : .easeOut(duration: 0.14), value: self.model.textContext)
        .animation(self.reduceMotion ? nil : .easeOut(duration: 0.14), value: self.statusLine?.message)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            self.onContentHeightChange(height)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            self.agentChip
            Text(self.model.targetSessionOverride?.displayName ?? self.model.agentDisplay.name)
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            self.historyButton
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                if !self.isExpanded {
                    self.agentChip
                        .padding(.top, 3)
                }
                self.editor
                    .frame(maxWidth: .infinity)
                Button(action: self.onToggleReply) {
                    Image(systemName: self.isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .medium))
                        .frame(width: 28, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .disabled(self.model.routingTarget == nil)
                .help(self.isExpanded ? "Collapse conversation" : "Expand conversation")
                .accessibilityLabel(self.isExpanded ? "Collapse conversation" : "Expand conversation")
                .accessibilityIdentifier("quick-chat-toggle-conversation")
            }
            .frame(minHeight: 40, alignment: .top)

            if let context = self.model.textContext {
                self.contextChip(context)
            }

            self.controls
        }
        .padding(12)
        .frame(minHeight: 112, alignment: .top)
        .background(self.surface, in: .rect(cornerRadius: 20))
        .overlay {
            if self.isExpanded {
                RoundedRectangle(cornerRadius: 20)
                    .strokeBorder(self.border, lineWidth: 1)
                    .allowsHitTesting(false)
            }
        }
        .accessibilityIdentifier("quick-chat-composer")
    }

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            if self.model.text.isEmpty {
                Text(verbatim: self.model.messagePlaceholder)
                    .font(.system(size: 16))
                    .foregroundStyle(.secondary)
                    .padding(.leading, 2)
                    .padding(.top, 6)
                    .allowsHitTesting(false)
            }
            QuickChatTextView(
                text: self.$model.text,
                selectionRange: self.model.dictationSelectionRange,
                onSubmit: self.submit,
                onEscape: {
                    self.onStopDictation()
                    self.onDismiss()
                },
                onUserEdit: {
                    guard self.model.isDictating || self.model.isStartingDictation else { return }
                    self.onStopDictation()
                },
                onHeightChange: { self.editorHeight = $0 },
                onTextViewReady: self.onTextViewReady)
                .frame(height: self.editorHeight)
                .accessibilityLabel(Text(verbatim: self.model.messagePlaceholder))
                .accessibilityIdentifier("quick-chat-input")
        }
    }

    private var controls: some View {
        HStack(spacing: 4) {
            self.captureMenu
            if !self.isExpanded {
                self.historyButton
            }
            if let viewModel = self.replyBinding.viewModel, let usage = viewModel.contextUsage {
                OpenClawChatContextUsageControl(
                    usage: usage,
                    canCompact: viewModel.canRequestSessionCompact && self.model.sendState != .sending,
                    controlSize: 28,
                    onCompact: viewModel.requestSessionCompact)
            }
            Spacer(minLength: 8)
            self.modelControl
            self.effortControl
            self.dictationButton
            self.sendButton
        }
    }

    private var captureMenu: some View {
        Menu {
            Button(action: self.onCaptureTextContext) {
                Label(
                    String(format: String(localized: "Attach text from %@"), self.model.frontmostAppName),
                    systemImage: "doc.text")
            }
            .disabled(!self.model.canCaptureTextContext)
            Button(action: self.onShowCaptureMenu) {
                Label("Capture a screenshot", systemImage: "camera.viewfinder")
            }
            .disabled(!self.model.canCaptureWindow)
        } label: {
            Group {
                if self.model.isCapturingTextContext {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .regular))
                }
            }
            .frame(width: 28, height: 30)
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(.secondary)
        .help("Attach context")
        .accessibilityLabel("Attach context")
        .accessibilityIdentifier("quick-chat-attach")
    }

    private var historyButton: some View {
        Button(action: self.onShowRecentSessions) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 15))
                .frame(width: 28, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .disabled(!self.model.canSelectRecentSession)
        .help("Continue a recent conversation")
        .accessibilityLabel("Continue a recent conversation")
    }

    private var dictationButton: some View {
        Button(action: self.onToggleDictation) {
            Group {
                if self.model.isStartingDictation {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: self.model.isDictating ? "mic.fill" : "mic")
                        .font(.system(size: 16))
                        .foregroundStyle(self.model.isDictating ? self.accent : Color.secondary)
                        .symbolEffect(.pulse, isActive: self.model.isDictating && !self.reduceMotion)
                }
            }
            .frame(width: 28, height: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!self.model.canToggleDictation)
        .help(self.dictationButtonLabel)
        .accessibilityLabel(Text(verbatim: self.dictationButtonLabel))
    }

    private var sendButton: some View {
        Button {
            self.submit(openChat: false)
        } label: {
            Group {
                if self.model.sendState == .sending {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .medium))
                }
            }
            .frame(width: 32, height: 32)
            .foregroundStyle(self.model.canSend ? Color.white : Color.secondary)
            .background(
                self.model.canSend
                    ? OpenClawChatTheme.desktopPrimary(in: self.colorScheme)
                    : Color.primary.opacity(0.07),
                in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!self.model.canSend)
        .help("Send message")
        .accessibilityLabel("Send message")
        .accessibilityIdentifier("quick-chat-send")
    }

    @ViewBuilder
    private var agentChip: some View {
        if self.model.agents.count > 1 {
            Button(action: self.onShowAgentPicker) {
                self.agentAvatar
            }
            .buttonStyle(.plain)
            .disabled(self.model.sendState == .sending)
            .help(self.model.agentDisplay.name)
        } else {
            self.agentAvatar.help(self.model.agentDisplay.name)
        }
    }

    private var modelControl: some View {
        Button(action: self.onShowModelMenu) {
            HStack(spacing: 5) {
                if self.model.isLoadingModelControls || self.model.isUpdatingModel {
                    ProgressView().controlSize(.mini)
                }
                Text(verbatim: self.model.modelControlLabel)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .medium))
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .frame(height: 30)
            .frame(maxWidth: 180)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!self.model.canUseModelControls)
        .help(self.model.modelControlLabel)
        .accessibilityLabel("Model")
        .accessibilityValue(self.model.modelControlLabel)
        .accessibilityIdentifier("quick-chat-model")
    }

    private var effortControl: some View {
        OpenClawChatEffortControl(
            thinkingOptions: self.model.thinkingOptions,
            thinkingLevel: self.model.displayedThinkingLevel,
            thinkingIsInherited: self.model.selectedThinkingLevel == nil,
            fastModeEnabled: self.model.speed.isEnabled,
            fastModeIsInherited: self.model.speed.override == nil,
            showsFastMode: self.model.speed.showsControls,
            supportsFastMode: self.model.speed.supportsFastMode,
            isEnabled: self.model.canUseModelControls && !self.model.isUpdatingModel,
            onSelectThinkingLevel: self.model.selectThinkingLevel,
            onSelectFastMode: { self.model.selectSpeed($0.map { $0 ? .on : .off }) })
    }

    private var agentAvatar: some View {
        ZStack {
            Circle().fill(self.agentTint.opacity(0.12))
            if case let .image(data) = self.model.agentDisplay.avatar, let image = NSImage(data: data) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .clipShape(Circle())
            } else if let emoji = self.model.agentDisplay.emoji {
                Text(emoji).font(.system(size: 20))
            } else {
                Text(self.model.agentDisplay.monogram)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(self.agentTint)
            }
        }
        .frame(width: 28, height: 28)
        .accessibilityLabel(self.model.agentDisplay.name)
    }

    private var agentTint: Color {
        Color(hue: self.model.agentDisplay.tintHue, saturation: 0.62, brightness: 0.72)
    }

    private var permissionStrip: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.shield").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Needs additional permissions").font(.caption.weight(.semibold))
                Text(verbatim: self.model.missingPermissions.map(\.permissionDisplayName).joined(separator: ", "))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Grant", action: self.onGrantPermissions)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(self.model.isGrantingPermissions)
            Button("Not now", action: self.model.dismissPermissionsForSession)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(12)
    }

    private func contextChip(_ context: QuickChatTextContext) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "doc.text").foregroundStyle(self.accent)
            Text(String(
                format: String(localized: "%@ — %@ (%lld chars)"),
                context.appName,
                context.windowTitle,
                context.characterCount))
                .font(.system(size: 12))
                .lineLimit(1)
                .truncationMode(.middle)
            Button(action: self.model.clearTextContext) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove attached text context")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(self.accent.opacity(0.08), in: .rect(cornerRadius: 8))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func replyArea(viewModel: OpenClawChatViewModel) -> some View {
        VStack(spacing: 0) {
            OpenClawChatView(
                viewModel: viewModel,
                drawsBackground: false,
                showsSessionSwitcher: false,
                userAccent: self.accent,
                displayOptions: [],
                showsAssistantAvatars: false,
                composerChrome: .clean,
                showsComposer: false,
                isComposerEnabled: false,
                isAttachmentInputEnabled: false,
                mediaPlaybackAllowed: { !AppStateStore.shared.talkEnabled })
                .environment(\.openClawChatDesktopLayout, true)
                .id(self.replyBinding.route)
                .frame(height: 320)
            if QuickChatPasteLogic.finalAssistantText(
                messages: viewModel.messages,
                afterUserIdempotencyKey: self.model.lastAcceptedIdempotencyKey,
                streamingAssistantText: viewModel.streamingAssistantText,
                pendingRunCount: viewModel.pendingRunCount) != nil
            {
                HStack {
                    Spacer()
                    Button(action: self.onPasteReply) {
                        if self.replyBinding.isPastingReply {
                            ProgressView().controlSize(.small)
                        } else {
                            Label(
                                String(format: String(localized: "Paste to %@"), self.model.frontmostAppName),
                                systemImage: "doc.on.clipboard")
                        }
                    }
                    .buttonStyle(.borderless)
                    .font(.system(size: 12))
                    .disabled(self.replyBinding.isPastingReply)
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 4)
            }
        }
    }

    private var statusLine: (message: String, isError: Bool)? {
        if case let .failed(message) = self.model.sendState { return (message, true) }
        if let message = self.model.textContextCaptureMessage { return (message, false) }
        if let message = self.model.dictationStatusMessage { return (message, true) }
        if let message = self.model.modelControlStatusMessage { return (message, true) }
        if let message = self.replyBinding.pasteStatusMessage { return (message, true) }
        if let message = self.model.connectionStatusMessage { return (message, false) }
        return nil
    }

    private func submit(openChat: Bool) {
        self.onStopDictation()
        guard self.model.canSend, let presentationID = self.model.activePresentationID else { return }
        Task {
            guard await self.model.send() else { return }
            // A dismissed/reopened bar must not inherit the accepted send's navigation.
            guard self.model.activePresentationID == presentationID else { return }
            self.onSendAccepted(openChat)
        }
    }

    private var dictationButtonLabel: String {
        self.model.isDictating || self.model.isStartingDictation
            ? String(localized: "Stop dictation")
            : String(localized: "Start dictation")
    }
}
