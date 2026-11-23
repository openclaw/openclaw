#if os(iOS)
import SwiftUI

/// The Control UI's shield for each permission mode. SF Symbols has no shield with an ellipsis or
/// a gear, so those two draw the mark inside a plain shield.
struct ChatPermissionModeGlyph: View {
    let mode: OpenClawChatPermissionMode?
    let size: CGFloat
    var weight: Font.Weight = .medium

    var body: some View {
        switch self.mode {
        case nil: self.symbol("checkmark.shield")
        case .guarded: self.symbol("lock.shield")
        case .full: self.symbol("exclamationmark.shield")
        case .readOnly: self.shield(mark: "ellipsis", scale: 0.5)
        case .workspace: self.shield(mark: "gearshape.fill", scale: 0.44)
        }
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: self.size, weight: self.weight))
    }

    private func shield(mark: String, scale: CGFloat) -> some View {
        self.symbol("shield")
            .overlay {
                Image(systemName: mark)
                    .font(.system(size: self.size * scale, weight: .bold))
                    .offset(y: -self.size * 0.03)
            }
    }
}

extension View {
    func chatComposerPermissionsSheet(isPresented: Binding<Bool>, viewModel: OpenClawChatViewModel) -> some View {
        self.sheet(isPresented: isPresented) { ChatComposerPermissionsSheet(viewModel: viewModel) }
    }
}

/// What the agent may do in this session and which built-in tools it has, opened from the
/// composer's shield. Skills and connectors stay in the `+` menu.
private struct ChatComposerPermissionsSheet: View {
    @Bindable var viewModel: OpenClawChatViewModel
    @Environment(\.dismiss) private var dismiss
    @ScaledMetric(relativeTo: .body) private var glyphSize: CGFloat = 20
    @State private var shown: Facts?
    @State private var contentHeight: CGFloat = 560

    /// Everything the sheet draws. A patch reloads the catalog, which is empty meanwhile, so the
    /// sheet keeps the last settled facts while one is in flight instead of flashing every row off.
    private struct Facts: Equatable {
        var isSettled: Bool
        var mode: OpenClawChatPermissionMode?
        var canChangeMode: Bool
        var canSelectFull: Bool
        var modeReason: String?
        var webSearchOn: Bool
        var canChangeWebSearch: Bool
        var webSearchReason: String?
        var notice: String?
        var error: String?
    }

    private var live: Facts {
        let catalog = self.viewModel.composerCapabilityCatalog
        let canChangeWebSearch = catalog.webSearchAvailable && catalog.webSearchBaseEnabled &&
            catalog.toolOverrideMutationAvailable
        let error = self.viewModel.composerCapabilityErrorMessage
        // A failed load is its own reason for web search; the error line already says it.
        let webSearchReason = canChangeWebSearch ? nil : self.viewModel.composerWebSearchMutationDisabledReason
        return Facts(
            isSettled: !self.viewModel.composerCapabilitiesBusy,
            mode: self.viewModel.composerPermissionMode,
            canChangeMode: catalog.permissionMutationAvailable,
            canSelectFull: catalog.canSelectFullPermission,
            modeReason: catalog.permissionMutationAvailable
                ? nil
                : self.viewModel.composerPermissionMutationDisabledReason,
            webSearchOn: self.viewModel.composerWebSearchEnabled,
            canChangeWebSearch: canChangeWebSearch,
            webSearchReason: webSearchReason == error ? nil : webSearchReason,
            notice: self.viewModel.composerCapabilityNotice,
            error: error)
    }

    var body: some View {
        let live = self.live
        let facts = self.shown ?? live
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                self.header
                self.sectionTitle("Access")
                self.accessCard(facts)
                self.footnote(
                    facts.modeReason ??
                        (facts.notice == OpenClawChatViewModel.permissionsNextRunNotice ? facts.notice : nil))
                self.sectionTitle("Tools")
                    .padding(.top, 22)
                self.toolsCard(facts)
                self.footnote(
                    facts.webSearchReason ??
                        (facts.notice == OpenClawChatViewModel.toolChangesNextRunNotice ? facts.notice : nil))
                self.footnote(facts.error, color: OpenClawChatTheme.danger)
            }
            .padding(.horizontal, 16)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { self.contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(OpenClawChatTheme.sheetBackground)
        .presentationDetents([.height(self.contentHeight), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(OpenClawChatTheme.sheetBackground)
        .onChange(of: live, initial: true) { _, live in
            if live.isSettled {
                self.shown = live
            }
        }
        .onDisappear { self.viewModel.dismissComposerCapabilityNotice() }
        .accessibilityIdentifier("chat-composer-permissions-sheet")
    }

    private var header: some View {
        ZStack {
            Text("Permissions")
                .font(OpenClawChatTypography.sheetTitle)
                .foregroundStyle(OpenClawChatTheme.assistantText)
                .accessibilityAddTraits(.isHeader)
            HStack {
                self.closeButton
                Spacer()
            }
        }
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    private var closeButton: some View {
        let label = Image(systemName: "xmark")
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(OpenClawChatTheme.assistantText)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        return Button { self.dismiss() } label: {
            if #available(iOS 26.0, *) {
                label.glassEffect(.regular.interactive(), in: Circle())
            } else {
                label.background(.regularMaterial, in: Circle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("chat-composer-permissions-close")
    }

    private func sectionTitle(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(OpenClawChatTypography.sheet(size: 15, relativeTo: .subheadline))
            .foregroundStyle(OpenClawChatTheme.muted)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func footnote(_ text: String?, color: Color = OpenClawChatTheme.muted) -> some View {
        if let text {
            Text(text)
                .font(OpenClawChatTypography.sheet(size: 13, relativeTo: .footnote))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.top, 8)
        }
    }

    private func accessCard(_ facts: Facts) -> some View {
        VStack(spacing: 0) {
            self.modeRow(nil, facts: facts)
            ForEach(OpenClawChatPermissionMode.allCases, id: \.rawValue) { mode in
                Divider().padding(.leading, self.textInset)
                self.modeRow(mode, facts: facts)
            }
        }
        .background(OpenClawChatTheme.sheetCard)
        .clipShape(RoundedRectangle(cornerRadius: Self.cardRadius, style: .continuous))
    }

    private func modeRow(_ mode: OpenClawChatPermissionMode?, facts: Facts) -> some View {
        let locked = mode == .full && !facts.canSelectFull
        let enabled = facts.canChangeMode && !locked
        let selected = facts.mode == mode
        let dimmed = enabled ? 1 : Self.disabledOpacity
        return Button {
            self.select(mode)
        } label: {
            HStack(spacing: Self.iconGap) {
                // Full access carries the accent, as in the Control UI, unless it is locked.
                ChatPermissionModeGlyph(mode: mode, size: self.glyphSize)
                    .foregroundStyle(mode == .full && !locked ? OpenClawChatTheme.accent : OpenClawChatTheme.muted)
                    .frame(width: self.iconWidth)
                    .opacity(dimmed)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(mode?.displayName ?? String(localized: "Agent default"))
                        .font(OpenClawChatTypography.sheet(size: 17, weight: .medium, relativeTo: .body))
                        .foregroundStyle(OpenClawChatTheme.assistantText)
                        .opacity(dimmed)
                    // A locked row keeps its reason at full strength; it is the only thing left to read.
                    Text(
                        locked
                            ? String(localized: "Only admins can turn on Full access.")
                            : mode?.summary ?? String(localized: "Uses this agent’s settings."))
                        .font(OpenClawChatTypography.sheet(size: 13, relativeTo: .footnote))
                        .lineSpacing(2)
                        .foregroundStyle(OpenClawChatTheme.muted)
                        .opacity(locked ? 1 : dimmed)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                // The mark's column stays reserved, so selecting a row never rewraps its summary.
                ZStack {
                    if selected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(OpenClawChatTheme.accent)
                            .opacity(dimmed)
                    } else if locked {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(OpenClawChatTheme.muted)
                    }
                }
                .frame(width: 20)
                .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(ChatPermissionRowButtonStyle())
        .disabled(!enabled)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("chat-composer-permission-\(mode?.rawValue ?? "default")")
    }

    private func toolsCard(_ facts: Facts) -> some View {
        Toggle(isOn: Binding(
            get: { facts.webSearchOn },
            set: { self.setWebSearch($0) }))
        {
            HStack(spacing: Self.iconGap) {
                Image(systemName: "globe")
                    .font(.system(size: self.glyphSize, weight: .medium))
                    .foregroundStyle(OpenClawChatTheme.muted)
                    .frame(width: self.iconWidth)
                    .accessibilityHidden(true)
                Text("Web search")
                    .font(OpenClawChatTypography.sheet(size: 17, weight: .medium, relativeTo: .body))
                    .foregroundStyle(OpenClawChatTheme.assistantText)
            }
            .opacity(facts.canChangeWebSearch ? 1 : Self.disabledOpacity)
        }
        .tint(OpenClawChatTheme.switchOn)
        .disabled(!facts.canChangeWebSearch)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(minHeight: 52)
        .background(
            OpenClawChatTheme.sheetCard,
            in: RoundedRectangle(cornerRadius: Self.cardRadius, style: .continuous))
        .accessibilityIdentifier("chat-composer-web-search")
    }

    private static let cardRadius: CGFloat = 26
    private static let disabledOpacity: Double = 0.45
    private static let iconGap: CGFloat = 12

    private var iconWidth: CGFloat {
        self.glyphSize + 6
    }

    /// Row separators start at the text, as in an inset grouped list.
    private var textInset: CGFloat {
        16 + self.iconWidth + Self.iconGap
    }

    // The view model drops a change while another is in flight, so taps wait for the settled state.
    // A started patch confirms later: show the choice now and let the settled facts correct it.

    private func select(_ mode: OpenClawChatPermissionMode?) {
        guard self.live.isSettled else { return }
        self.viewModel.selectComposerPermissionMode(mode)
        self.show(after: self.live) { $0.mode = mode }
    }

    private func setWebSearch(_ isOn: Bool) {
        guard self.live.isSettled, isOn != self.live.webSearchOn else { return }
        self.viewModel.toggleComposerWebSearch()
        self.show(after: self.live) { $0.webSearchOn = isOn }
    }

    private func show(after live: Facts, choice: (inout Facts) -> Void) {
        guard !live.isSettled, var next = shown else {
            self.shown = live
            return
        }
        choice(&next)
        next.error = nil
        self.shown = next
    }
}

/// The row draws its own disabled state, so a locked row can keep its reason readable.
private struct ChatPermissionRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Color.primary.opacity(configuration.isPressed ? 0.06 : 0))
    }
}
#endif
