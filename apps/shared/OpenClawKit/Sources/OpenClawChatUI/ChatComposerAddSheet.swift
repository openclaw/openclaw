#if os(iOS)
import Photos
import SwiftUI
import UIKit

/// What the composer does once the "+" sheet has closed.
enum ChatComposerAddFollowUp {
    case camera
    case photoLibrary
    case files
    case focusDraft
}

extension OpenClawChatComposer {
    /// The sheet's own close. A choice that focuses the draft asks for the keyboard as the sheet starts to leave,
    /// not from `onDismiss`; iOS raises it as soon as the sheet is gone. Asking before the sheet leaves lifts the
    /// sheet with the keyboard first. Anything else runs once the sheet is gone.
    func closeAddSheet(_ followUp: ChatComposerAddFollowUp?) {
        self.showsAddSheet = false
        guard followUp == .focusDraft else {
            self.addSheetFollowUp = followUp
            return
        }
        self.addSheetFollowUp = nil
        self.addSheetReturnsFocus = false
        self.focusDraft()
    }

    /// Runs once the "+" sheet is gone, however it closed: the picker it asked for opens, or the keyboard comes back.
    func addSheetDidDismiss() {
        let followUp = self.addSheetFollowUp
        self.addSheetFollowUp = nil
        switch followUp {
        case .camera:
            self.cameraPickerPresentation.wrappedValue = true
        case .photoLibrary:
            self.photoPickerPresentation.wrappedValue = true
        case .files:
            self.fileImporterPresentation.wrappedValue = true
        case .focusDraft, nil:
            // A choice that focuses the draft took the keyboard when it closed the sheet.
            self.returnFocusAfterAddSheet()
        }
    }
}

/// The composer takes focus as soon as a picker that picked something starts to leave. Its tiles keep
/// preparing above the keyboard, at their final size.
struct ChatPickerAttachmentFocus: ViewModifier {
    let composer: OpenClawChatComposer
    let pickerPresented: Bool

    func body(content: Content) -> some View {
        let ready = !self.pickerPresented && !self.composer.pickedAttachmentFocusIDs.isEmpty
        content.onChange(of: ready) { _, ready in
            guard ready else { return }
            self.composer.pickedAttachmentFocusIDs.removeAll()
            guard self.composer.isAttachmentInputEnabled else { return }
            self.composer.focusDraft()
        }
    }
}

/// The composer's "+": a system sheet that adds things to the next message. Recent photos with the camera first,
/// the photo library and files, then the skills to use and the connectors this chat can reach.
struct ChatComposerAddSheet: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let isAttachmentInputEnabled: Bool
    let onAttachPhotos: ([PHAsset]) -> Void
    let onClose: (ChatComposerAddFollowUp?) -> Void

    enum Route: Hashable {
        case skills
        case skillSwitches
        case connectors
        case connector(String)
        case branches
    }

    @State private var path: [Route] = []
    @State private var detent: PresentationDetent?
    @State private var library = ChatRecentPhotosLibrary()
    @State private var selection = ChatRecentPhotoSelection()
    /// A change reloads the catalog, which is empty meanwhile; the pages keep the last settled facts until it
    /// settles, and the switch just flipped shows its new value.
    @State private var settled: ChatComposerCapabilityFacts?
    @State private var pending: [String: Bool] = [:]
    /// The root's own height, so it rests without scrolling at every text size; measured at the root and kept
    /// through a push.
    /// The whole list's height, measured at the root and kept through a push.
    @State private var fittedHeight: CGFloat = 436

    var body: some View {
        let live = ChatComposerCapabilityFacts(self.viewModel)
        let busy = self.viewModel.composerCapabilitiesBusy
        let caps = ChatComposerCapabilityDisplay(
            facts: busy ? (self.settled ?? live) : live,
            pending: self.pending,
            change: { key, isOn, toggle in
                self.pending[key] = isOn
                toggle()
                // Nothing started (refused before sending): show the real state again.
                if !self.viewModel.composerCapabilitiesBusy { self.pending[key] = nil }
            })
        let showsBranches = self.viewModel.sessionBranches.count > 1
        let showsReset = self.showsCapabilities && self.viewModel.composerToolOverrides.overrideCount > 0
        NavigationStack(path: self.$path) {
            List {
                self.photoSection
                Section {
                    self.actionRow("Photo Library", systemImage: "photo.on.rectangle", id: "photo-library") {
                        self.onClose(.photoLibrary)
                    }
                    .disabled(!self.isAttachmentInputEnabled)
                    self.actionRow("Files", systemImage: "folder", id: "files") { self.onClose(.files) }
                        .disabled(!self.isAttachmentInputEnabled)
                }
                if self.showsCapabilities {
                    Section {
                        NavigationLink(value: Route.skills) {
                            self.rowLabel("Use a skill", systemImage: "line.diagonal")
                        }
                        .accessibilityIdentifier("chat-composer-add-skills")
                        NavigationLink(value: Route.connectors) {
                            LabeledContent {
                                if let count = caps.connectorsOnCount {
                                    Text(verbatim: String(format: String(localized: "%lld on"), count))
                                        .font(OpenClawChatTypography.settingsBody)
                                }
                            } label: {
                                self.rowLabel("Connectors", systemImage: "powerplug")
                            }
                        }
                        .accessibilityIdentifier("chat-composer-add-connectors")
                    }
                }
                if showsBranches {
                    Section {
                        NavigationLink(value: Route.branches) {
                            self.rowLabel("Branches", systemImage: "arrow.triangle.branch")
                        }
                        .accessibilityIdentifier("chat-composer-add-branches")
                    }
                }
                if showsReset {
                    Section {
                        Button {
                            self.viewModel.clearComposerToolOverrides()
                        } label: {
                            Text("Reset tools for this chat").font(OpenClawChatTypography.settingsBody)
                        }
                        .disabled(self.viewModel.composerClearToolOverridesDisabled)
                        .accessibilityHint(self.viewModel.composerToolOverrideMutationDisabledReason ?? "")
                        .accessibilityIdentifier("chat-composer-add-reset-tools")
                    }
                }
            }
            .listStyle(.insetGrouped)
            // The photo row has no header; it sits under the title like the rows under it.
            .listSectionSpacing(.compact)
            // The first card sits under the title as in the model sheet and the system's own sheets.
            .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
            // The list's insets carry the bar and the home indicator.
            .onScrollGeometryChange(for: CGFloat.self) {
                $0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom
            } action: { _, height in
                if self.path.isEmpty, height > 0 { self.fittedHeight = height }
            }
            .navigationTitle(self.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !self.selection.marked.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            self.attach(self.selection.marked)
                        } label: {
                            Text("Add")
                                .font(OpenClawChatTypography.settingsBody)
                                .fontWeight(.semibold)
                        }
                        .modifier(ChatComposerProminentToolbarButton())
                        .accessibilityLabel(Text(verbatim: self.library.addLabel(for: self.selection.marked)))
                        .accessibilityIdentifier("chat-composer-add-marked")
                    }
                }
                OpenClawSheetCloseItem(identifier: "chat-composer-add-close") { self.onClose(nil) }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .skills:
                    ChatComposerSkillsPage(
                        viewModel: self.viewModel,
                        caps: caps,
                        onSwitches: { self.path.append(.skillSwitches) },
                        onSearch: { self.detent = .large },
                        onUsed: { self.onClose(.focusDraft) })
                case .skillSwitches:
                    ChatComposerSkillSwitchesPage(
                        viewModel: self.viewModel,
                        caps: caps,
                        onSearch: { self.detent = .large })
                case .connectors:
                    ChatComposerConnectorsPage(viewModel: self.viewModel, caps: caps)
                case let .connector(name):
                    ChatComposerConnectorPage(
                        viewModel: self.viewModel,
                        caps: caps,
                        name: name)
                case .branches:
                    ChatComposerBranchesPage(viewModel: self.viewModel, onClose: { self.onClose(nil) })
                }
            }
        }
        .openClawSheetHeaderEdge()
        .tint(.primary)
        .accessibilityIdentifier("chat-composer-add-sheet")
        .presentationDetents([.height(self.restingHeight), .large], selection: Binding(
            get: { self.detent ?? .height(self.restingHeight) },
            set: { self.detent = $0 }))
        .presentationDragIndicator(.visible)
        // Below full height iOS draws a sheet as glass, which lets the composer's red button tint it.
        .presentationBackground(Color(uiColor: .systemGroupedBackground))
        .task(id: self.viewModel.composerCapabilityOwnerID) {
            // After a failed load, opening the sheet is the "Try again".
            await self.viewModel.loadComposerCapabilities(force: self.viewModel.composerCapabilityErrorMessage != nil)
        }
        .onAppear {
            self.viewModel.loadSlashCommandsIfNeeded()
            // Its pages' footers show a failed change; the toast doesn't repeat it.
            self.viewModel.statusStrip.surfaceDidOpen(OpenClawChatViewModel.addSheetSurface)
        }
        .onDisappear { self.viewModel.statusStrip.surfaceDidClose(OpenClawChatViewModel.addSheetSurface) }
        .onChange(of: live, initial: true) { _, live in
            if !self.viewModel.composerCapabilitiesBusy { self.settled = live }
        }
        .onChange(of: busy) { _, busy in
            if !busy {
                self.settled = ChatComposerCapabilityFacts(self.viewModel)
                self.pending = [:]
            }
        }
        .onChange(of: self.library.assets) { _, assets in
            // A photo that left the library, or a limited grant, can't stay marked.
            let ids = Set(assets.map(\.localIdentifier))
            for id in self.selection.marked where !ids.contains(id) {
                self.selection.toggle(id)
            }
        }
    }

    /// An inset grouped list's content runs on past its last group (the footer gap, the bottom margin, an empty
    /// footer area). The list is lazy, so a group below the sheet's edge has no position to measure; this is the
    /// measured excess instead. With it the last row ends 42.6 pt above the sheet's edge at xS, L and AX3 alike
    /// (iOS 27.2): the home indicator's 34 pt plus 8.6. Without it, 73 pt; the excess doesn't change with text size.
    private static let emptySpaceAfterLastGroup: CGFloat = 43.8

    /// Rests where the last group's footer gap meets the home indicator's inset, with nothing empty below.
    private var restingHeight: CGFloat {
        self.fittedHeight - Self.emptySpaceAfterLastGroup
    }

    /// While photos are marked, the title counts them and the top bar offers Add.
    private var title: Text {
        let count = self.selection.marked.count
        if count == 0 { return Text("Add") }
        if self.library.containsVideo(in: self.selection.marked) {
            return Text(verbatim: String(format: String(localized: "%lld selected"), count))
        }
        return Text(verbatim: Self.photoCount(count))
    }

    /// "Add 1 photo", "Add 3 photos", for VoiceOver.
    static func addPhotosLabel(_ count: Int) -> String {
        String(AttributedString(localized: "Add ^[\(count) photo](inflect: true)").characters)
    }

    /// "1 photo", "3 photos", inflected so plurals localize.
    static func photoCount(_ count: Int) -> String {
        String(AttributedString(localized: "^[\(count) photo](inflect: true)").characters)
    }

    private var showsCapabilities: Bool {
        self.viewModel.supportsComposerCapabilities && self.viewModel.composerCapabilityControlsAvailable
    }

    private func attach(_ ids: [String]) {
        let byID = Dictionary(uniqueKeysWithValues: self.library.assets.map { ($0.localIdentifier, $0) })
        let assets = ids.compactMap { byID[$0] }
        guard self.isAttachmentInputEnabled, !assets.isEmpty else { return }
        self.onAttachPhotos(assets)
        self.onClose(.focusDraft)
    }

    // MARK: Photos

    private var photoSection: some View {
        Section {
            ChatComposerPhotoRow(
                library: self.library,
                selection: self.$selection,
                isEnabled: self.isAttachmentInputEnabled,
                onCamera: { self.onClose(.camera) },
                onAttach: { self.attach(self.selection.attaching($0)) })
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
        }
    }

    // MARK: Rows

    private func rowLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
        Label {
            Text(title).font(OpenClawChatTypography.settingsBody)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(.secondary)
        }
    }

    private func actionRow(
        _ title: LocalizedStringKey,
        systemImage: String,
        id: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            self.rowLabel(title, systemImage: systemImage).foregroundStyle(Color.primary)
        }
        .accessibilityIdentifier("chat-composer-add-\(id)")
    }
}

extension ChatRecentPhotosLibrary {
    fileprivate func containsVideo(in ids: [String]) -> Bool {
        self.assets.contains { $0.mediaType == .video && ids.contains($0.localIdentifier) }
    }

    fileprivate func addLabel(for ids: [String]) -> String {
        self.containsVideo(in: ids) ? String(localized: "Add") : ChatComposerAddSheet.addPhotosLabel(ids.count)
    }
}

// MARK: - Photo row

/// The camera, then the newest photos. A tap on a photo's corner marks it; a tap anywhere else on it attaches it,
/// with any photos already marked.
private struct ChatComposerPhotoRow: View {
    let library: ChatRecentPhotosLibrary
    @Binding var selection: ChatRecentPhotoSelection
    let isEnabled: Bool
    let onCamera: () -> Void
    let onAttach: (String) -> Void

    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Tiles grow with the text so "Camera" always fits, up to a size that still shows more than one photo.
    @ScaledMetric(relativeTo: .footnote) private var scaledSide: CGFloat = 84
    private var side: CGFloat {
        min(self.scaledSide, 148)
    }

    private static let spacing: CGFloat = 8

    var body: some View {
        let access = self.library.access
        Group {
            if access == .limited || (access == .full && !self.library.assets.isEmpty) {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: Self.spacing) {
                        self.cameraTile
                        ForEach(self.library.assets, id: \.localIdentifier) { asset in
                            self.photoTile(asset)
                        }
                        if self.library.access == .limited {
                            self.morePhotosTile
                        }
                    }
                }
                .scrollClipDisabled()
            } else if access == .full {
                HStack(spacing: Self.spacing) {
                    self.cameraTile
                    self.card(title: Text("No recent photos"), detail: nil, systemImage: nil, action: nil)
                        .accessibilityIdentifier("chat-composer-add-no-photos")
                }
            } else if access == .notDetermined {
                HStack(spacing: Self.spacing) {
                    self.cameraTile
                    self.card(
                        title: Text("Show recent photos"),
                        detail: Text("Asks for access to Photos"),
                        systemImage: "photo.on.rectangle.angled",
                        action: { self.library.requestAccess() })
                        .accessibilityIdentifier("chat-composer-add-photos-access")
                }
            } else if access == .restricted {
                HStack(spacing: Self.spacing) {
                    self.cameraTile
                    self.card(title: Text("No access to Photos"), detail: nil, systemImage: "lock", action: nil)
                        .accessibilityIdentifier("chat-composer-add-photos-restricted")
                }
            } else {
                HStack(spacing: Self.spacing) {
                    self.cameraTile
                    self.card(
                        title: Text("No access to Photos"),
                        detail: Text("Change in Settings"),
                        systemImage: "lock",
                        action: {
                            if let url = URL(string: UIApplication.openSettingsURLString) { self.openURL(url) }
                        })
                        .accessibilityIdentifier("chat-composer-add-photos-settings")
                }
            }
        }
        .frame(height: self.side)
        .disabled(!self.isEnabled)
    }

    private var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    private var cameraTile: some View {
        Button(action: self.onCamera) {
            VStack(spacing: 4) {
                Image(systemName: "camera").font(.title3)
                Text("Camera")
                    .font(OpenClawChatTypography.footnote)
                    .lineLimit(1)
                    .fixedSize()
            }
            .frame(width: self.side, height: self.side)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: Self.tileShape)
            .contentShape(Self.tileShape)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.primary)
        .disabled(!self.cameraAvailable)
        .accessibilityIdentifier("chat-composer-add-camera")
    }

    private var morePhotosTile: some View {
        Button { self.library.chooseMorePhotos() } label: {
            VStack(spacing: 4) {
                Image(systemName: "plus").font(.title3)
                Text(self.library.assets.isEmpty ? "Choose photos" : "More photos")
                    .font(OpenClawChatTypography.footnote)
                    .multilineTextAlignment(.center)
            }
            .padding(6)
            .frame(width: self.side, height: self.side)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: Self.tileShape)
            .contentShape(Self.tileShape)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.primary)
        .accessibilityLabel(self.library.assets.isEmpty ? Text("Choose photos") : Text("Choose more photos"))
        .accessibilityIdentifier("chat-composer-add-more-photos")
    }

    private func photoTile(_ asset: PHAsset) -> some View {
        let id = asset.localIdentifier
        let number = self.selection.number(of: id)
        return Button { self.onAttach(id) } label: {
            ChatRecentPhotoThumbnail(asset: asset, manager: self.library.imageManager, side: self.side)
                .frame(width: self.side, height: self.side)
                .clipShape(Self.tileShape)
                .overlay(alignment: .bottomTrailing) {
                    if asset.mediaType == .video {
                        ChatVideoDurationLabel(seconds: asset.duration).padding(5)
                    }
                }
                .overlay {
                    // A hairline keeps a light photo apart from the sheet; marked, a heavier ring.
                    Self.tileShape.strokeBorder(
                        number == nil ? Color.primary.opacity(0.12) : Color.primary,
                        lineWidth: number == nil ? 0.5 : 3)
                }
                .contentShape(Self.tileShape)
        }
        .buttonStyle(.plain)
        // Touch and hold previews the photo; the menu offers only what the tap does.
        .contextMenu {
            Button { self.onAttach(id) } label: {
                Label(self.library.addLabel(for: self.selection.attaching(id)), systemImage: "plus")
            }
        } preview: {
            Self.preview(asset, manager: self.library.imageManager)
        }
        .overlay(alignment: .topTrailing) {
            // The mark's own target: the photo's top-trailing 44 pt.
            Button { self.selection.toggle(id) } label: {
                ChatRecentPhotoMark(number: number)
                    .padding(6)
                    .frame(width: 44, height: 44, alignment: .topTrailing)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
        .accessibilityLabel(Self.photoLabel(asset))
        .accessibilityAddTraits(number != nil ? .isSelected : [])
        .accessibilityValue(number.map { Text(verbatim: String(format: String(localized: "Number %lld"), $0)) }
            ?? Text(verbatim: ""))
        .accessibilityHint(asset
            .mediaType == .video ? Text("Add") : Text("Adds this photo. To add several, use Select."))
        .accessibilityAction(named: number == nil ? Text("Select") : Text("Deselect")) {
            self.selection.toggle(id)
        }
        .accessibilityIdentifier("chat-composer-add-photo-\(self.library.assets.firstIndex(of: asset) ?? 0)")
    }

    /// The whole photo, fitted to a 360 by 480 pt box.
    private static func preview(_ asset: PHAsset, manager: PHCachingImageManager) -> some View {
        let width = CGFloat(max(asset.pixelWidth, 1))
        let height = CGFloat(max(asset.pixelHeight, 1))
        let scale = min(360 / width, 480 / height)
        return ChatRecentPhotoThumbnail(asset: asset, manager: manager, side: max(width, height) * scale)
            .frame(width: width * scale, height: height * scale)
    }

    private func card(
        title: Text,
        detail: Text?,
        systemImage: String?,
        action: (() -> Void)?) -> some View
    {
        let content = HStack(spacing: 12) {
            if let systemImage {
                Image(systemName: systemImage).foregroundStyle(.secondary).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                title.font(OpenClawChatTypography.settingsBody)
                    // A card that only informs stays quiet; one that acts reads like a row.
                        .foregroundStyle(action == nil ? Color.secondary : Color.primary)
                if let detail {
                    detail.font(OpenClawChatTypography.settingsFootnote).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: action == nil ? .center : .leading)
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: Self.tileShape)
        .contentShape(Self.tileShape)
        return Group {
            if let action {
                Button(action: action) { content }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
            } else {
                content.accessibilityElement(children: .combine)
            }
        }
    }

    private static let tileShape = RoundedRectangle(cornerRadius: 12, style: .continuous)

    private static func photoLabel(_ asset: PHAsset) -> Text {
        if asset.mediaType == .video {
            let duration = Duration.seconds(asset.duration.rounded(.down)).formatted(.units(width: .wide))
            return Text(verbatim: [String(localized: "Video"), duration].formatted(.list(type: .and)))
        }
        guard let date = asset.creationDate else { return Text("Photo") }
        return Text(verbatim: String(
            format: String(localized: "Photo, %@"),
            date.formatted(date: .abbreviated, time: .shortened)))
    }
}

/// The round mark in a photo's corner: empty until marked, then the order it was marked in.
private struct ChatRecentPhotoMark: View {
    let number: Int?
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 24

    var body: some View {
        ZStack {
            if let number {
                Circle().fill(Color.primary)
                Text(verbatim: "\(number)")
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(Color(uiColor: .systemBackground))
            } else {
                Circle().fill(Color.black.opacity(0.18))
            }
            Circle().strokeBorder(Color.white, lineWidth: 1.5)
        }
        .frame(width: self.size, height: self.size)
        // A thin dark ring outside the white one, so the mark reads on a white screenshot and a dark photo alike.
        .padding(0.75)
        .overlay { Circle().strokeBorder(Color.black.opacity(0.4), lineWidth: 0.75) }
    }
}

// MARK: - Use a skill

/// A skill the person can use in a chat: on for the Gateway, not blocked, nothing missing.
extension OpenClawChatComposerSkill {
    fileprivate var isUsable: Bool {
        self.baseEnabled && !self.missingDependencies && !self.blocked
    }

    fileprivate func matches(_ query: String) -> Bool {
        query.isEmpty || self.name.localizedCaseInsensitiveContains(query) ||
            self.key.localizedCaseInsensitiveContains(query) ||
            self.description.localizedCaseInsensitiveContains(query)
    }
}

/// The skills to use: a tap puts the skill's command in front of the draft. An off skill is dimmed and offers
/// to turn itself on first.
private struct ChatComposerSkillsPage: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let caps: ChatComposerCapabilityDisplay
    let onSwitches: () -> Void
    let onSearch: () -> Void
    let onUsed: () -> Void

    @State private var query = ""
    @State private var isSearching = false
    @State private var expandedOffSkill: String?
    /// The off skill being turned on; its button shows a spinner in the same box until the change settles.
    @State private var turningOn: String?
    @ScaledMetric(relativeTo: .body) private var searchClearance: CGFloat = 64

    var body: some View {
        let catalog = self.caps.facts.catalog
        let blocked = !self.viewModel.composerAttachments.isEmpty ||
            !self.viewModel.composerPreparingAttachments.isEmpty
        let query = self.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let skills = catalog.skills.filter { $0.isUsable && $0.matches(query) }
        List {
            Section {
                if !catalog.skillsAvailable, self.viewModel.composerCapabilitiesLoading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if !catalog.skillsAvailable {
                    Text("Skills unavailable").font(OpenClawChatTypography.settingsBody).foregroundStyle(.secondary)
                } else if skills.isEmpty, !query.isEmpty {
                    ChatComposerNoResults(query: query)
                } else if skills.isEmpty {
                    Text("No skills available").font(OpenClawChatTypography.settingsBody).foregroundStyle(.secondary)
                } else {
                    ForEach(skills) { skill in
                        self.skillRow(skill, blocked: blocked)
                    }
                }
            } footer: {
                if blocked {
                    Text("Remove attachments to use a skill.").font(OpenClawChatTypography.settingsFootnote)
                } else if let error = self.viewModel.composerCapabilityErrorMessage {
                    Text(error).font(OpenClawChatTypography.settingsFootnote).foregroundStyle(OpenClawChatTheme.danger)
                }
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
        .contentMargins(.bottom, self.searchClearance, for: .scrollContent)
        .navigationTitle(Text("Use a skill"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: self.$query, isPresented: self.$isSearching, prompt: Text("Search skills"))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .modifier(ChatComposerSkillSwitchesButton(action: self.onSwitches))
        .onChange(of: self.isSearching) { _, searching in
            if searching { self.onSearch() }
        }
    }

    @ViewBuilder
    private func skillRow(_ skill: OpenClawChatComposerSkill, blocked: Bool) -> some View {
        let isOn = self.caps.isOn(ChatComposerCapabilityFacts.skill(skill.key))
        let invocation = self.viewModel.composerSkillInvocation(skill)
        let expanded = !isOn && self.expandedOffSkill == skill.key
        VStack(alignment: .leading, spacing: 10) {
            Button {
                if isOn {
                    self.viewModel.insertComposerSkill(skill)
                    self.onUsed()
                } else {
                    self.expandedOffSkill = expanded ? nil : skill.key
                }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: invocation)
                        .font(OpenClawChatTypography.settingsBody)
                        .foregroundStyle(isOn ? Color.primary : Color.secondary)
                    let detail = expanded ? String(localized: "Off for this chat") : skill.description
                    if !detail.isEmpty {
                        Text(verbatim: detail)
                            .font(OpenClawChatTypography.settingsFootnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(expanded ? nil : 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(blocked)
            .accessibilityValue(isOn || expanded ? Text(verbatim: "") : Text("Off for this chat"))
            .accessibilityHint(blocked ? Text("Remove attachments to use a skill.") : Text(verbatim: ""))
            .accessibilityIdentifier("chat-composer-skill-\(skill.key)")
            if expanded {
                let reason = self.caps.facts.catalog.toolOverrideMutationAvailable
                    ? nil : self.viewModel.composerToolOverrideMutationDisabledReason
                if let reason {
                    Text(verbatim: reason).font(OpenClawChatTypography.settingsFootnote).foregroundStyle(.secondary)
                } else {
                    let busy = self.turningOn == skill.key
                    Button {
                        self.turningOn = skill.key
                        Task {
                            let used = await self.viewModel.turnOnComposerSkillAndInsert(skill)
                            self.turningOn = nil
                            // A failure keeps the page open, with the error in its footer.
                            if used { self.onUsed() }
                        }
                    } label: {
                        Text("Turn on and use")
                            .font(OpenClawChatTypography.settingsBody)
                            .fontWeight(.semibold)
                            .opacity(busy ? 0 : 1)
                            .overlay { if busy { ProgressView() } }
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .disabled(busy || self.turningOn != nil || self.viewModel.composerCapabilityMutationDisabled)
                    .accessibilityIdentifier("chat-composer-skill-turn-on")
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// The round button beside the search field that opens the skill switches. iOS 26 places the system search
/// field in the bottom bar next to it.
private struct ChatComposerSkillSwitchesButton: ViewModifier {
    let action: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.toolbar {
                DefaultToolbarItem(kind: .search, placement: .bottomBar)
                ToolbarSpacer(.fixed, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) { self.button }
            }
        } else {
            content.toolbar {
                ToolbarItem(placement: .bottomBar) { self.button }
            }
        }
    }

    private var button: some View {
        Button(action: self.action) {
            // A 44 pt target; the bar draws the same glass circle around it.
            Image(systemName: "switch.2")
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .accessibilityLabel(Text("Turn skills on or off"))
        .accessibilityIdentifier("chat-composer-skill-switches")
    }
}

/// Every usable skill with its switch for this chat.
private struct ChatComposerSkillSwitchesPage: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let caps: ChatComposerCapabilityDisplay
    let onSearch: () -> Void
    @State private var query = ""
    @State private var isSearching = false
    @ScaledMetric(relativeTo: .body) private var searchClearance: CGFloat = 64

    var body: some View {
        let catalog = self.caps.facts.catalog
        let query = self.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let skills = catalog.skills.filter { $0.isUsable && $0.matches(query) }
        List {
            Section {
                if !catalog.skillsAvailable, self.viewModel.composerCapabilitiesLoading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if !catalog.skillsAvailable {
                    Text("Skills unavailable").font(OpenClawChatTypography.settingsBody).foregroundStyle(.secondary)
                } else if skills.isEmpty, !query.isEmpty {
                    ChatComposerNoResults(query: query)
                } else if skills.isEmpty {
                    Text("No skills available").font(OpenClawChatTypography.settingsBody).foregroundStyle(.secondary)
                }
                ForEach(skills) { skill in
                    Toggle(isOn: self.caps.binding(ChatComposerCapabilityFacts.skill(skill.key)) {
                        self.viewModel.toggleComposerSkill(skill)
                    }) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: skill.name).font(OpenClawChatTypography.settingsBody)
                            if !skill.description.isEmpty {
                                Text(verbatim: skill.description)
                                    .font(OpenClawChatTypography.settingsFootnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                    .tint(OpenClawChatTheme.switchOn)
                    .disabled(
                        !catalog.toolOverrideMutationAvailable || self.viewModel.composerCapabilityMutationDisabled)
                    .accessibilityHint(self.viewModel.composerSkillStatusMessage(skill) ?? "")
                    .accessibilityIdentifier("chat-composer-skill-switch-\(skill.key)")
                }
            } footer: {
                ChatComposerCapabilityFooter(
                    viewModel: self.viewModel,
                    text: skills.isEmpty ? nil : Text("Changes apply to this chat only."))
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
        .contentMargins(.bottom, self.searchClearance, for: .scrollContent)
        .navigationTitle(Text("Skills"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: self.$query, isPresented: self.$isSearching, prompt: Text("Search skills"))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onChange(of: self.isSearching) { _, searching in
            if searching { self.onSearch() }
        }
    }
}

// MARK: - Connectors

private struct ChatComposerConnectorsPage: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let caps: ChatComposerCapabilityDisplay

    var body: some View {
        let catalog = self.caps.facts.catalog
        List {
            Section {
                if !catalog.connectorsAvailable, self.viewModel.composerCapabilitiesLoading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if !catalog.connectorsAvailable {
                    Text("Connectors unavailable").font(OpenClawChatTypography.settingsBody)
                        .foregroundStyle(.secondary)
                } else if catalog.connectors.isEmpty {
                    Text("No connectors set up").font(OpenClawChatTypography.settingsBody)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(catalog.connectors) { connector in
                        let isOn = self.caps.isOn(ChatComposerCapabilityFacts.connector(connector.name))
                        NavigationLink(value: ChatComposerAddSheet.Route.connector(connector.name)) {
                            LabeledContent {
                                Text(isOn ? "On" : "Off").font(OpenClawChatTypography.settingsBody)
                            } label: {
                                Text(verbatim: connector.title).font(OpenClawChatTypography.settingsBody)
                            }
                        }
                        .accessibilityIdentifier("chat-composer-connector-\(connector.name)")
                    }
                }
            } footer: {
                ChatComposerCapabilityFooter(viewModel: self.viewModel, text: nil)
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
        .navigationTitle(Text("Connectors"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// One connector's page, built like a plugin's detail page in Settings: the name as the title, its switch for
/// this chat with what it says about itself, then each of its tools with a switch.
private struct ChatComposerConnectorPage: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let caps: ChatComposerCapabilityDisplay
    let name: String

    var body: some View {
        let catalog = self.caps.facts.catalog
        let connector = catalog.connectors.first { $0.name == self.name }
        let canChange = catalog.toolOverrideMutationAvailable && !self.viewModel.composerCapabilityMutationDisabled
        List {
            if let connector {
                let isOn = self.caps.isOn(ChatComposerCapabilityFacts.connector(connector.name))
                Section {
                    Toggle(isOn: self.caps.binding(ChatComposerCapabilityFacts.connector(connector.name)) {
                        self.viewModel.toggleComposerConnector(connector)
                    }) {
                        Text("On for this chat").font(OpenClawChatTypography.settingsBody)
                    }
                    .tint(OpenClawChatTheme.switchOn)
                    .disabled(!canChange)
                    .accessibilityHint(self.viewModel.composerToolOverrideMutationDisabledReason ?? "")
                    .accessibilityIdentifier("chat-composer-connector-switch")
                } footer: {
                    if let notice = connector.notice?.trimmingCharacters(in: .whitespacesAndNewlines), !notice.isEmpty {
                        Text(verbatim: notice).font(OpenClawChatTypography.settingsFootnote)
                    }
                }
                if !connector.tools.isEmpty {
                    Section {
                        ForEach(connector.tools) { tool in
                            Toggle(isOn: self.caps.binding(ChatComposerCapabilityFacts.tool(
                                server: connector.name,
                                tool: tool.name))
                            {
                                self.viewModel.toggleComposerTool(server: connector.name, tool: tool.name)
                            }) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: tool.label).font(OpenClawChatTypography.settingsBody)
                                    let description = tool.summary
                                    if !description.isEmpty {
                                        Text(verbatim: description)
                                            .font(OpenClawChatTypography.settingsFootnote)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .tint(OpenClawChatTheme.switchOn)
                            .disabled(!canChange || !catalog.toolAccessAvailable || !isOn)
                            .accessibilityHint(
                                !isOn ? Text("Turn on the connector to change its tools.")
                                    : Text(verbatim: self.viewModel.composerToolOverrideMutationDisabledReason ?? ""))
                            .accessibilityIdentifier("chat-composer-tool-\(tool.name)")
                        }
                    } header: {
                        Text("Tools").font(OpenClawChatTypography.settingsSectionHeader)
                    } footer: {
                        ChatComposerCapabilityFooter(viewModel: self.viewModel, text: nil)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
        .navigationTitle(Text(verbatim: connector?.title ?? self.name))
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Branches

private struct ChatComposerBranchesPage: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let onClose: () -> Void

    var body: some View {
        List {
            Section {
                ForEach(self.viewModel.sessionBranches) { branch in
                    Button {
                        if !branch.active {
                            Task { await self.viewModel.switchToBranch(branch.leafEntryId) }
                        }
                        self.onClose()
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: OpenClawChatComposer.branchTitle(branch))
                                    .font(OpenClawChatTypography.settingsBody)
                                    .foregroundStyle(Color.primary)
                                Text(verbatim: OpenClawChatComposer.branchMetadata(branch))
                                    .font(OpenClawChatTypography.settingsFootnote)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            if branch.active {
                                Image(systemName: "checkmark").font(.body.weight(.semibold)).accessibilityHidden(true)
                            }
                        }
                    }
                    .disabled(!self.viewModel.canSwitchSessionBranch)
                    .accessibilityAddTraits(branch.active ? .isSelected : [])
                }
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
        .navigationTitle(Text("Branches"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await self.viewModel.refreshSessionBranches() }
    }
}

// MARK: - Shared pieces

/// What the capability pages draw: skills, connectors and tools, and whether each is on for this chat.
struct ChatComposerCapabilityFacts: Equatable {
    var catalog: OpenClawChatComposerCapabilityCatalog
    var on: [String: Bool] = [:]

    @MainActor
    init(_ viewModel: OpenClawChatViewModel) {
        self.catalog = viewModel.composerCapabilityCatalog
        for skill in self.catalog.skills {
            self.on[Self.skill(skill.key)] = viewModel.composerSkillEnabled(skill)
        }
        for connector in self.catalog.connectors {
            self.on[Self.connector(connector.name)] = viewModel.composerConnectorEnabled(connector)
            for tool in connector.tools {
                self.on[Self.tool(server: connector.name, tool: tool.name)] =
                    viewModel.composerToolEnabled(server: connector.name, tool: tool.name)
            }
        }
    }

    static func skill(_ key: String) -> String {
        "skill\u{1f}" + key
    }

    static func connector(_ name: String) -> String {
        "connector\u{1f}" + name
    }

    static func tool(server: String, tool: String) -> String {
        "tool\u{1f}" + server + "\u{1f}" + tool
    }
}

/// The facts a page shows, with the switch just flipped at its new value until the Gateway settles.
struct ChatComposerCapabilityDisplay {
    let facts: ChatComposerCapabilityFacts
    let pending: [String: Bool]
    let change: (_ key: String, _ isOn: Bool, _ toggle: () -> Void) -> Void

    func isOn(_ key: String) -> Bool {
        self.pending[key] ?? self.facts.on[key] ?? false
    }

    /// The Gateway owns the value; a switch that already shows the requested state does not toggle again.
    func binding(_ key: String, toggle: @escaping () -> Void) -> Binding<Bool> {
        Binding(get: { self.isOn(key) }, set: { isOn in
            if isOn != self.isOn(key) { self.change(key, isOn, toggle) }
        })
    }

    var connectorsOnCount: Int? {
        guard self.facts.catalog.connectorsAvailable else { return nil }
        let count = self.facts.catalog.connectors.count { self.isOn(ChatComposerCapabilityFacts.connector($0.name)) }
        // Nothing on is the normal state: the row shows only its name.
        return count > 0 ? count : nil
    }
}

/// A page's footer: its own line, or the error from the last change, which replaces it.
private struct ChatComposerCapabilityFooter: View {
    let viewModel: OpenClawChatViewModel
    let text: Text?

    var body: some View {
        if let error = self.viewModel.composerCapabilityErrorMessage {
            Text(verbatim: error).font(OpenClawChatTypography.settingsFootnote)
                .foregroundStyle(OpenClawChatTheme.danger)
        } else if let text {
            text.font(OpenClawChatTypography.settingsFootnote)
        }
    }
}

private struct ChatComposerNoResults: View {
    let query: String

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(verbatim: String(format: String(localized: "No results for “%@”"), self.query))
                    .font(OpenClawChatTypography.settingsBody)
            } icon: {
                Image(systemName: "magnifyingglass")
            }
        }
        .listRowBackground(Color.clear)
    }
}

/// The sheet's one primary action, trailing, in the system's prominent style.
private struct ChatComposerProminentToolbarButton: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glassProminent).tint(OpenClawChatTheme.accent)
        } else {
            content.buttonStyle(.borderedProminent).tint(OpenClawChatTheme.accent)
        }
    }
}

#endif
