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
    @ScaledMetric(relativeTo: .body) private var iconScale = 1.0
    @State private var shown: Facts?
    @State private var sheetHeight: CGFloat = 560
    /// An access mode picked here and not yet confirmed by the Gateway.
    @State private var awaitedMode: AwaitedMode?
    @State private var selectionCount = 0

    private struct AwaitedMode {
        var mode: OpenClawChatPermissionMode?
        var pickedAt: Date
    }

    /// Picking a mode closes the sheet this long after its check moves, so the choice is seen.
    private static let closeBeat: TimeInterval = 0.35

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
        NavigationStack {
            List {
                self.accessSection(facts)
                self.toolsSection(facts)
            }
            .listStyle(.insetGrouped)
            // The sheet opens as tall as its rows; the list's insets carry the bar and the home indicator.
            .onScrollGeometryChange(for: CGFloat.self) {
                $0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom
            } action: { _, height in
                self.sheetHeight = height
            }
            .navigationTitle("Permissions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { self.dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                        .accessibilityIdentifier("chat-composer-permissions-close")
                }
            }
        }
        .tint(.primary)
        .presentationDetents([.height(self.sheetHeight), .large])
        .presentationDragIndicator(.visible)
        .onChange(of: live, initial: true) { _, live in
            if live.isSettled {
                self.shown = live
                self.closeIfConfirmed(live)
            }
        }
        .sensoryFeedback(.selection, trigger: self.selectionCount)
        .onDisappear { self.viewModel.dismissComposerCapabilityNotice() }
        .accessibilityIdentifier("chat-composer-permissions-sheet")
    }

    private func accessSection(_ facts: Facts) -> some View {
        Section {
            self.modeRow(nil, facts: facts)
            ForEach(OpenClawChatPermissionMode.allCases, id: \.rawValue) { mode in
                self.modeRow(mode, facts: facts)
            }
        } header: {
            Text("Access").font(OpenClawChatTypography.settingsSectionHeader)
        } footer: {
            // A confirmed mode closes the sheet, so its next-reply notice is never shown here.
            self.footer(facts.modeReason)
        }
    }

    private func modeRow(_ mode: OpenClawChatPermissionMode?, facts: Facts) -> some View {
        let locked = mode == .full && !facts.canSelectFull
        let selected = facts.mode == mode
        return Button {
            self.select(mode)
        } label: {
            HStack(spacing: 8) {
                Label {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(mode?.displayName ?? String(localized: "Agent default"))
                            .font(OpenClawChatTypography.settingsBody)
                        // A locked row keeps its reason at full strength; it is the only thing left to read.
                        Text(
                            locked
                                ? String(localized: "Only admins can turn on Full access.")
                                : mode?.summary ?? String(localized: "Uses this agent’s settings."))
                            .font(OpenClawChatTypography.settingsFootnote)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    // Full access carries the accent, as in the Control UI, unless it is locked.
                    ChatPermissionModeGlyph(mode: mode, size: 15 * self.iconScale, weight: .regular)
                        .foregroundStyle(mode == .full && !locked ? AnyShapeStyle(OpenClawChatTheme.accent) :
                            AnyShapeStyle(.secondary))
                }
                Spacer(minLength: 0)
                // The mark's column stays reserved, so selecting a row never rewraps its summary.
                ZStack {
                    if selected {
                        Image(systemName: "checkmark")
                            .font(.subheadline.weight(.semibold))
                    } else if locked {
                        Image(systemName: "lock.fill")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 20)
                .accessibilityHidden(true)
            }
        }
        .disabled(!facts.canChangeMode || locked)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("chat-composer-permission-\(mode?.rawValue ?? "default")")
    }

    private func toolsSection(_ facts: Facts) -> some View {
        Section {
            Toggle(isOn: Binding(
                get: { facts.webSearchOn },
                set: { self.setWebSearch($0) }))
            {
                Label {
                    Text("Web search").font(OpenClawChatTypography.settingsBody)
                } icon: {
                    Image(systemName: "globe")
                        .font(.system(size: 15 * self.iconScale, weight: .regular))
                        .foregroundStyle(.secondary)
                }
            }
            .tint(OpenClawChatTheme.switchOn)
            .disabled(!facts.canChangeWebSearch)
            .accessibilityIdentifier("chat-composer-web-search")
        } header: {
            Text("Tools").font(OpenClawChatTypography.settingsSectionHeader)
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                self.footer(
                    facts.webSearchReason ??
                        (facts.notice == OpenClawChatViewModel.toolChangesNextRunNotice ? facts.notice : nil))
                if let error = facts.error {
                    Text(error)
                        .font(OpenClawChatTypography.settingsFootnote)
                        .foregroundStyle(OpenClawChatTheme.danger)
                }
            }
        }
    }

    @ViewBuilder
    private func footer(_ text: String?) -> some View {
        if let text {
            Text(text).font(OpenClawChatTypography.settingsFootnote)
        }
    }

    // The view model drops a change while another is in flight, so taps wait for the settled state.
    // A started patch confirms later: show the choice now and let the settled facts correct it.

    /// Access rows are a picker: a mode the Gateway confirms closes the sheet; a failure keeps it open
    /// with the error. Tapping the current mode closes it too, so a tap always answers.
    private func select(_ mode: OpenClawChatPermissionMode?) {
        guard self.live.isSettled else { return }
        guard mode != self.live.mode else {
            self.dismiss()
            return
        }
        self.viewModel.selectComposerPermissionMode(mode)
        let live = self.live
        // Nothing started (the view model refused, or failed before sending): show why and stay.
        guard !live.isSettled || live.mode == mode else {
            self.shown = live
            return
        }
        self.show(after: live) { $0.mode = mode }
        self.selectionCount += 1
        self.awaitedMode = AwaitedMode(mode: mode, pickedAt: .now)
        self.closeIfConfirmed(live)
    }

    private func closeIfConfirmed(_ live: Facts) {
        guard let awaited = self.awaitedMode, live.isSettled else { return }
        self.awaitedMode = nil
        guard live.error == nil, live.mode == awaited.mode else { return }
        let wait = Self.closeBeat - Date.now.timeIntervalSince(awaited.pickedAt)
        Task { @MainActor in
            if wait > 0 {
                try? await Task.sleep(for: .seconds(wait))
            }
            self.dismiss()
        }
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
#endif
