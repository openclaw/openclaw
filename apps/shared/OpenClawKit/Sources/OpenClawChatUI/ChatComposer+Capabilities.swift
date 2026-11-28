import SwiftUI

extension OpenClawChatComposer {
    #if os(iOS)
    /// One glyph for the session's permission mode. It opens the sheet that also holds the built-in
    /// tools, so the composer never spells out a mode or a tool state.
    @ViewBuilder
    var cleanInlinePermissionButton: some View {
        if self.viewModel.composerCapabilityControlsAvailable {
            let mode = self.viewModel.composerPermissionMode
            Button {
                self.showsPermissionsSheet = true
            } label: {
                // Full access carries the accent, as in the Control UI. The trailing padding sits the
                // glyph 20 pt from the `+` instead of a full control width away.
                ChatPermissionModeGlyph(mode: mode, size: 15)
                    .foregroundStyle(mode == .full ? OpenClawChatTheme.accent : CleanChatComposerMetrics.footerInk)
                    .padding(.trailing, 12)
                    .frame(
                        width: CleanChatComposerMetrics.glyphControlWidth,
                        height: CleanChatComposerMetrics.controlTouchSize)
                    // A full touch target that takes the gap after it, so no neighbor's target overlaps it.
                    .frame(width: CleanChatComposerMetrics.controlTouchSize, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Session permissions")
            .accessibilityValue(mode?.displayName ?? String(localized: "Agent default"))
            .accessibilityIdentifier("chat-composer-inline-permissions")
        }
    }
    #endif

    /// iOS shows these notices in the permissions sheet, not in the composer.
    @ViewBuilder
    var composerCapabilityNoticeRow: some View {
        #if !os(iOS)
        if let notice = self.viewModel.composerCapabilityNotice {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(OpenClawChatTheme.accent)
                    .accessibilityHidden(true)
                Text(notice)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button {
                    self.viewModel.dismissComposerCapabilityNotice()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .frame(
                    width: CleanChatComposerMetrics.controlTouchSize,
                    height: CleanChatComposerMetrics.controlTouchSize)
                .contentShape(Rectangle())
                .accessibilityLabel("Dismiss capability notice")
                .accessibilityIdentifier("chat-composer-dismiss-capability-notice")
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-composer-capability-notice")
        }
        #endif
    }
}
