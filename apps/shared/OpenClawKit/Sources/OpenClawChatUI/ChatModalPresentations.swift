import CoreTransferable
import Foundation
import Observation
import SwiftUI
#if canImport(UIKit)
import PhotosUI
import UIKit
import UniformTypeIdentifiers
#endif

public struct OpenClawChatModalOrigin: Equatable {
    private let chat: OpenClawChatComposerPresentationOwner?
    private let standaloneID: UUID?

    @MainActor
    public init(viewModel: OpenClawChatViewModel) {
        self.chat = OpenClawChatComposerPresentationOwner(viewModel: viewModel)
        self.standaloneID = nil
    }

    init(owner: OpenClawChatComposerPresentationOwner) {
        self.chat = owner
        self.standaloneID = nil
    }

    fileprivate init(standaloneID: UUID) {
        self.chat = nil
        self.standaloneID = standaloneID
    }
}

@MainActor
public struct OpenClawChatModalActions {
    public struct Permit {
        public let isCurrent: @MainActor () -> Bool
        public let accept: @MainActor () -> Bool

        public init(
            isCurrent: @escaping @MainActor () -> Bool,
            accept: @escaping @MainActor () -> Bool)
        {
            self.isCurrent = isCurrent
            self.accept = accept
        }
    }

    public let capture: @MainActor (OpenClawChatModalOrigin) -> Permit?
    public let dismiss: @MainActor (OpenClawChatModalOrigin) -> Void
    public let isCurrent: @MainActor (OpenClawChatModalOrigin) -> Bool

    public init(
        capture: @escaping @MainActor (OpenClawChatModalOrigin) -> Permit?,
        dismiss: @escaping @MainActor (OpenClawChatModalOrigin) -> Void,
        isCurrent: @escaping @MainActor (OpenClawChatModalOrigin) -> Bool)
    {
        self.capture = capture
        self.dismiss = dismiss
        self.isCurrent = isCurrent
    }

    static var local: Self {
        Self(
            capture: { _ in Permit(isCurrent: { true }, accept: { true }) },
            dismiss: { _ in },
            isCurrent: { _ in true })
    }
}

@MainActor
@Observable
public final class OpenClawChatModalPresentations {
    public struct Receipt: Identifiable {
        public let id = UUID()
        public let origin: OpenClawChatModalOrigin
        let producerID: UUID
        let ancestors: [UUID]
        let dismiss: @MainActor (OpenClawChatModalOrigin) -> Void
        let isCurrentScope: @MainActor () -> Bool

        @MainActor
        @discardableResult
        public func retireIfCurrent() -> Bool {
            guard self.isCurrentScope() else { return false }
            self.dismiss(self.origin)
            return true
        }
    }

    @MainActor
    public final class Capture {
        public let receipt: Receipt
        private weak var owner: OpenClawChatModalPresentations?
        private let parentIsCurrent: @MainActor () -> Bool
        private let permit: OpenClawChatModalActions.Permit
        private var consumed = false

        fileprivate init(
            owner: OpenClawChatModalPresentations,
            receipt: Receipt,
            parentIsCurrent: @escaping @MainActor () -> Bool,
            permit: OpenClawChatModalActions.Permit)
        {
            self.owner = owner
            self.receipt = receipt
            self.parentIsCurrent = parentIsCurrent
            self.permit = permit
        }

        fileprivate func belongs(to owner: OpenClawChatModalPresentations) -> Bool {
            self.owner === owner
        }

        public var isCurrent: Bool {
            !self.consumed && self.owner?.origin == self.receipt.origin &&
                self.receipt.isCurrentScope() && self.parentIsCurrent() && self.permit.isCurrent()
        }

        /// Admission retires the captured native selection. Commit immediately;
        /// checking that consumed selection again would reject our own opening.
        public func accept() -> Bool {
            guard self.isCurrent, self.permit.accept() else { return false }
            self.consumed = true
            return true
        }
    }

    struct Request<Value>: Identifiable {
        let receipt: Receipt
        let value: Value
        var id: UUID {
            self.receipt.id
        }
    }

    struct FullMessage {
        let request: ChatFullMessageReaderRequest
        let markdownVariant: ChatMarkdownVariant
    }

    struct MermaidPreview {
        let svg: String
        let background: String
    }

    struct SignIn {
        let context: OpenClawChatModelSignInContext
        let refresh: @MainActor () async -> Void
    }

    public let standaloneOrigin = OpenClawChatModalOrigin(standaloneID: UUID())
    public private(set) var origin: OpenClawChatModalOrigin?
    var fullMessage: Request<FullMessage>?
    var selectText: Request<OpenClawChatMessage>?
    var image: Request<OpenClawPlatformImage>?
    var source: Request<ChatSourcePreview>?
    var mermaid: Request<MermaidPreview>?
    var widgetImage: Request<OpenClawPlatformImage>?
    var widgetError: Request<String>?
    var fileExport: Request<ChatDownloadedFile>?
    var fileError: Request<Void>?
    var signIn: Request<SignIn>?
    #if canImport(UIKit)
    var photoPicker: Request<ChatModalAttachmentCapture>?
    var fileImporter: Request<ChatModalAttachmentCapture>?
    var cameraPicker: Request<ChatModalAttachmentCapture>?
    // Frameworks dismiss before delivering results, and may cancel without one.
    // These bounded result owners never contribute to modal admission.
    var photoResult: Request<ChatModalAttachmentCapture>?
    var fileResult: Request<ChatModalAttachmentCapture>?
    var cameraResult: Request<ChatModalAttachmentCapture>?
    #endif

    public init() {
        self.origin = self.standaloneOrigin
    }

    private var receipts: [Receipt] {
        var values = [
            self.fullMessage?.receipt,
            self.selectText?.receipt,
            self.image?.receipt,
            self.source?.receipt,
            self.mermaid?.receipt,
            self.widgetImage?.receipt,
            self.widgetError?.receipt,
            self.fileExport?.receipt,
            self.fileError?.receipt,
            self.signIn?.receipt,
        ].compactMap(\.self)
        #if canImport(UIKit)
        values += [self.photoPicker?.receipt, self.fileImporter?.receipt, self.cameraPicker?.receipt]
            .compactMap(\.self)
        #endif
        return values
    }

    public var hasActivePresentation: Bool {
        !self.receipts.isEmpty
    }

    public func hasActivePresentation(for origin: OpenClawChatModalOrigin) -> Bool {
        self.receipts.contains { $0.origin == origin }
    }

    public func isPresented(_ receipt: Receipt) -> Bool {
        self.receipts.contains { $0.id == receipt.id && $0.origin == receipt.origin }
    }

    public func synchronize(origin: OpenClawChatModalOrigin) {
        guard self.origin != origin else { return }
        if let previous = self.origin { self.invalidate(origin: previous) }
        self.origin = origin
    }

    public func invalidate(origin: OpenClawChatModalOrigin) {
        self.remove { $0.origin == origin }
        #if canImport(UIKit)
        self.cancelAttachmentCaptures { $0.origin == origin }
        #endif
        if self.origin == origin { self.origin = nil }
    }

    public func capture(
        origin: OpenClawChatModalOrigin,
        producerID: UUID,
        ancestors: [UUID] = [],
        parentIsCurrent: @escaping @MainActor () -> Bool = { true },
        actions: OpenClawChatModalActions) -> Capture?
    {
        guard self.origin == origin, actions.isCurrent(origin), parentIsCurrent(),
              let permit = actions.capture(origin) else { return nil }
        return Capture(
            owner: self,
            receipt: Receipt(
                origin: origin,
                producerID: producerID,
                ancestors: ancestors,
                dismiss: actions.dismiss,
                isCurrentScope: { actions.isCurrent(origin) && parentIsCurrent() }),
            parentIsCurrent: parentIsCurrent,
            permit: permit)
    }

    @discardableResult
    func present<Value>(
        _ value: Value,
        at slot: ReferenceWritableKeyPath<OpenClawChatModalPresentations, Request<Value>?>,
        capture: Capture?) -> Request<Value>?
    {
        guard let capture, capture.belongs(to: self), capture.accept() else { return nil }
        if let previous = self[keyPath: slot] { self.removeDescendants(of: previous.receipt) }
        let request = Request(receipt: capture.receipt, value: value)
        self[keyPath: slot] = request
        return request
    }

    public func dismiss(_ receipt: Receipt) {
        guard self.isPresented(receipt) else { return }
        receipt.dismiss(receipt.origin)
        self.removeDescendants(of: receipt)
        self.remove { $0.id == receipt.id || $0.ancestors.contains(receipt.id) }
    }

    public func removeDescendants(of receipt: Receipt) {
        self.remove { $0.origin == receipt.origin && $0.ancestors.contains(receipt.id) }
        #if canImport(UIKit)
        self.cancelAttachmentCaptures {
            $0.origin == receipt.origin && $0.ancestors.contains(receipt.id)
        }
        #endif
    }

    private func remove(where matches: (Receipt) -> Bool) {
        if let value = self.fullMessage, matches(value.receipt) { self.fullMessage = nil }
        if let value = self.selectText, matches(value.receipt) { self.selectText = nil }
        if let value = self.image, matches(value.receipt) { self.image = nil }
        if let value = self.source, matches(value.receipt) { self.source = nil }
        if let value = self.mermaid, matches(value.receipt) { self.mermaid = nil }
        if let value = self.widgetImage, matches(value.receipt) { self.widgetImage = nil }
        if let value = self.widgetError, matches(value.receipt) { self.widgetError = nil }
        if let value = self.fileExport, matches(value.receipt) { self.fileExport = nil }
        if let value = self.fileError, matches(value.receipt) { self.fileError = nil }
        if let value = self.signIn, matches(value.receipt) { self.signIn = nil }
        #if canImport(UIKit)
        if let value = self.photoPicker, matches(value.receipt) { self.photoPicker = nil }
        if let value = self.fileImporter, matches(value.receipt) { self.fileImporter = nil }
        if let value = self.cameraPicker, matches(value.receipt) { self.cameraPicker = nil }
        #endif
    }

    #if canImport(UIKit)
    enum AttachmentKind { case photo, file, camera }

    private func presentationSlot(_ kind: AttachmentKind) -> ReferenceWritableKeyPath<
        OpenClawChatModalPresentations,
        Request<ChatModalAttachmentCapture>?,
    > {
        switch kind {
        case .photo: \.photoPicker
        case .file: \.fileImporter
        case .camera: \.cameraPicker
        }
    }

    private func resultSlot(_ kind: AttachmentKind) -> ReferenceWritableKeyPath<
        OpenClawChatModalPresentations,
        Request<ChatModalAttachmentCapture>?,
    > {
        switch kind {
        case .photo: \.photoResult
        case .file: \.fileResult
        case .camera: \.cameraResult
        }
    }

    @discardableResult
    func presentAttachment(
        _ kind: AttachmentKind,
        viewModel: OpenClawChatViewModel,
        capture: Capture?) -> Request<ChatModalAttachmentCapture>?
    {
        let session = viewModel.currentSessionSnapshot()
        guard let capture, capture.belongs(to: self), capture.accept() else { return nil }
        let receipt = capture.receipt
        let resultSlot = self.resultSlot(kind)
        self[keyPath: resultSlot]?.value.cancel()
        let value = ChatModalAttachmentCapture(
            viewModel: viewModel,
            session: session,
            current: { [weak self] in
                self?.origin == receipt.origin &&
                    self?[keyPath: resultSlot]?.id == receipt.id && receipt.isCurrentScope()
            },
            finish: { [weak self] in
                guard self?[keyPath: resultSlot]?.id == receipt.id else { return }
                self?[keyPath: resultSlot] = nil
            })
        let request = Request(receipt: receipt, value: value)
        self[keyPath: resultSlot] = request
        self[keyPath: self.presentationSlot(kind)] = request
        return request
    }

    func attachmentBinding(
        _ kind: AttachmentKind,
        context: ChatModalContext,
        viewModel: OpenClawChatViewModel,
        enabled: Bool) -> Binding<Bool>
    {
        let slot = self.presentationSlot(kind)
        let expected = self[keyPath: slot]?.receipt
        return Binding(
            get: {
                self[keyPath: slot]?.receipt.producerID == context.producerID &&
                    self[keyPath: slot]?.receipt.origin == context.origin
            },
            set: { presented in
                if presented {
                    guard enabled else { return }
                    self.presentAttachment(kind, viewModel: viewModel, capture: context.capture())
                } else if let expected {
                    self.dismiss(expected)
                }
            })
    }

    func cancelAttachmentCaptures(where matches: (Receipt) -> Bool) {
        for kind in [AttachmentKind.photo, .file, .camera] {
            let slot = self.resultSlot(kind)
            if let request = self[keyPath: slot], matches(request.receipt) {
                request.value.cancel()
                self[keyPath: slot] = nil
            }
        }
        self.remove(where: matches)
    }

    func cancelAttachments(context: ChatModalContext) {
        self.cancelAttachmentCaptures {
            $0.origin == context.origin && $0.producerID == context.producerID
        }
    }
    #endif

    func binding<Value>(
        _ slot: ReferenceWritableKeyPath<OpenClawChatModalPresentations, Request<Value>?>,
        context: ChatModalContext) -> Binding<Request<Value>?>
    {
        let expected = self[keyPath: slot]?.receipt
        return Binding(
            get: {
                guard let value = self[keyPath: slot],
                      value.receipt.origin == context.origin,
                      value.receipt.ancestors == context.ancestors else { return nil }
                return value
            },
            set: { value in
                guard value == nil, let expected else { return }
                self.dismiss(expected)
            })
    }
}

@MainActor
struct ChatModalContext {
    let owner: OpenClawChatModalPresentations
    let origin: OpenClawChatModalOrigin
    let producerID: UUID
    let ancestors: [UUID]
    let parentIsCurrent: @MainActor () -> Bool
    let actions: OpenClawChatModalActions

    func capture() -> OpenClawChatModalPresentations.Capture? {
        self.owner.capture(
            origin: self.origin,
            producerID: self.producerID,
            ancestors: self.ancestors,
            parentIsCurrent: self.parentIsCurrent,
            actions: self.actions)
    }

    func nested(_ receipt: OpenClawChatModalPresentations.Receipt) -> Self {
        Self(
            owner: self.owner,
            origin: receipt.origin,
            producerID: self.producerID,
            ancestors: receipt.ancestors + [receipt.id],
            parentIsCurrent: { [weak owner = self.owner] in owner?.isPresented(receipt) == true },
            actions: self.actions)
    }

    func producing(_ id: UUID) -> Self {
        Self(
            owner: self.owner,
            origin: self.origin,
            producerID: id,
            ancestors: self.ancestors,
            parentIsCurrent: self.parentIsCurrent,
            actions: self.actions)
    }
}

extension EnvironmentValues {
    @Entry var chatModalContext: ChatModalContext?
}

@MainActor
@propertyWrapper
struct ChatModalState: DynamicProperty {
    @Environment(\.chatModalContext) private var inherited
    @State private var local = OpenClawChatModalPresentations()
    @State private var producerID = UUID()

    var wrappedValue: ChatModalContext {
        let context = self.inherited ?? ChatModalContext(
            owner: self.local,
            origin: self.local.origin ?? self.local.standaloneOrigin,
            producerID: self.producerID,
            ancestors: [],
            parentIsCurrent: { true },
            actions: .local)
        return context.producing(self.producerID)
    }

    var projectedValue: ChatModalFallbackHost {
        ChatModalFallbackHost(context: self.wrappedValue, installsHost: self.inherited == nil)
    }
}

@MainActor
struct ChatModalFallbackHost: ViewModifier {
    let context: ChatModalContext
    let installsHost: Bool
    var origin: OpenClawChatModalOrigin?

    func originating(in viewModel: OpenClawChatViewModel) -> Self {
        Self(context: self.context, installsHost: self.installsHost, origin: .init(viewModel: viewModel))
    }

    func body(content: Content) -> some View {
        if self.installsHost {
            content.modifier(ChatModalHost(context: ChatModalContext(
                owner: self.context.owner,
                origin: self.origin ?? self.context.origin,
                producerID: self.context.producerID,
                ancestors: [],
                parentIsCurrent: { true },
                actions: .local)))
        } else {
            content
        }
    }
}

extension View {
    @MainActor
    public func openClawChatModalPresentations(
        _ owner: OpenClawChatModalPresentations,
        origin: OpenClawChatModalOrigin,
        actions: OpenClawChatModalActions,
        parent: OpenClawChatModalPresentations.Receipt? = nil,
        parentIsCurrent: @escaping @MainActor () -> Bool = { true }) -> some View
    {
        self.modifier(ChatModalHost(context: ChatModalContext(
            owner: owner,
            origin: origin,
            producerID: parent?.producerID ?? UUID(),
            ancestors: parent.map { $0.ancestors + [$0.id] } ?? [],
            parentIsCurrent: parentIsCurrent,
            actions: actions)))
    }
}

@MainActor
private struct ChatModalHost: ViewModifier {
    let context: ChatModalContext
    private var owner: OpenClawChatModalPresentations {
        self.context.owner
    }

    private var fileDownloadErrorMessage: some View {
        Text("Reconnect and try again. If the file has expired or was removed, ask the assistant to send it again.")
            .font(OpenClawChatTypography.body)
    }

    func body(content: Content) -> some View {
        let error = self.owner.binding(\.widgetError, context: self.context)
        let errorReceipt = error.wrappedValue?.receipt
        let fileErrorReceipt = self.owner.binding(\.fileError, context: self.context).wrappedValue?.receipt
        return content
            .environment(\.chatModalContext, self.context)
            .onChange(of: self.context.origin, initial: true) { _, origin in
                if self.context.ancestors.isEmpty { self.owner.synchronize(origin: origin) }
            }
            .sheet(item: self.owner.binding(\.fullMessage, context: self.context)) { request in
                self.nested(request.receipt, content: ChatFullMessageReader(
                    request: request.value.request,
                    markdownVariant: request.value.markdownVariant,
                    onClose: { self.owner.dismiss(request.receipt) }))
            }
            .sheet(item: self.owner.binding(\.image, context: self.context)) { request in
                self.nested(request.receipt, content: self.image(request))
            }
            .sheet(item: self.owner.binding(\.signIn, context: self.context)) { request in
                self.nested(request.receipt, content: OpenClawChatModelSignInSheet(
                    context: request.value.context,
                    onAuthChanged: request.value.refresh,
                    onClose: { self.owner.dismiss(request.receipt) }))
            }
            .alert(
                "Widget export failed",
                isPresented: self.isPresented(\.widgetError))
            {
                Button(role: .cancel) {
                    if let errorReceipt { self.owner.dismiss(errorReceipt) }
                } label: {
                    Text("OK").font(OpenClawChatTypography.body)
                }
            } message: {
                if let value = self.owner.binding(\.widgetError, context: self.context).wrappedValue {
                    Text(value.value).font(OpenClawChatTypography.body)
                }
            }
            .alert("Unable to Download File", isPresented: self.isPresented(\.fileError)) {
                    Button(role: .cancel) {
                        if let fileErrorReceipt { self.owner.dismiss(fileErrorReceipt) }
                    } label: {
                        Text("OK").font(OpenClawChatTypography.body)
                    }
                } message: {
                    self.fileDownloadErrorMessage
                }
                #if os(iOS)
                .sheet(item: self.owner.binding(\.selectText, context: self.context)) { request in
                    self.nested(request.receipt, content: ChatSelectableTextSheet(
                        text: ChatMessageVisibleText.copyText(in: request.value),
                        onClose: { self.owner.dismiss(request.receipt) }))
                }
                .sheet(item: self.owner.binding(\.source, context: self.context)) { request in
                    self.nested(
                        request.receipt,
                        content: ScrollView {
                            ChatSourcePreviewDetail(source: request.value) { self.owner.dismiss(request.receipt) }
                        }
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible))
                }
                .sheet(item: self.owner.binding(\.widgetImage, context: self.context)) { request in
                    self.nested(request.receipt, content: ChatInlineWidgetShareSheet(image: request.value))
                }
                .sheet(item: self.owner.binding(\.fileExport, context: self.context)) { request in
                    // Retain the temporary file through the system activity callback,
                    // even if the originating chat removes its presentation first.
                    self.nested(request.receipt, content: OpenClawChatFileShareSheet(
                        fileURL: request.value.url,
                        onCompletion: { [file = request.value] in
                            withExtendedLifetime(file) {}
                        }))
                }
                #endif
                #if canImport(WebKit) && os(macOS)
                .sheet(item: self.owner.binding(\.mermaid, context: self.context)) { request in
                    self.diagram(request)
                }
                #elseif canImport(WebKit) && os(iOS)
                .fullScreenCover(item: self.owner.binding(\.mermaid, context: self.context)) { request in
                    self.diagram(request)
                }
                #endif
                #if canImport(UIKit)
                .background {
                    if let request = self.owner.fileResult, self.belongs(request.receipt) {
                        ChatModalAttachmentHost(owner: self.owner, request: request, kind: .file)
                            .id(request.id)
                    }
                    if let request = self.owner.photoResult, self.belongs(request.receipt) {
                        ChatModalAttachmentHost(owner: self.owner, request: request, kind: .photo)
                            .id(request.id)
                    }
                    if let request = self.owner.cameraResult, self.belongs(request.receipt) {
                        ChatModalAttachmentHost(owner: self.owner, request: request, kind: .camera)
                            .id(request.id)
                    }
                }
                #endif
    }

    private func belongs(_ receipt: OpenClawChatModalPresentations.Receipt) -> Bool {
        receipt.origin == self.context.origin && receipt.ancestors == self.context.ancestors
    }

    private func isPresented(
        _ slot: ReferenceWritableKeyPath<
            OpenClawChatModalPresentations,
            OpenClawChatModalPresentations.Request<some Any>?,
        >) -> Binding<Bool>
    {
        let binding = self.owner.binding(slot, context: self.context)
        return Binding(get: { binding.wrappedValue != nil }, set: { if !$0 { binding.wrappedValue = nil } })
    }

    /// Erase the recursive host type, not the typed payload or its receipt.
    private func nested(_ receipt: OpenClawChatModalPresentations.Receipt, content: some View) -> AnyView {
        AnyView(content.modifier(ChatModalHost(context: self.context.nested(receipt))))
    }

    private func image(
        _ request: OpenClawChatModalPresentations.Request<OpenClawPlatformImage>) -> some View
    {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            ScrollView([.horizontal, .vertical]) {
                OpenClawPlatformImageFactory.image(request.value)
                    .resizable().scaledToFit().padding(20)
            }
            Button { self.owner.dismiss(request.receipt) } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2).symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.plain).foregroundStyle(.white).padding(16)
            .accessibilityLabel(String(localized: "Close image preview"))
        }
    }

    #if canImport(WebKit) && (os(iOS) || os(macOS))
    private func diagram(
        _ request: OpenClawChatModalPresentations.Request<OpenClawChatModalPresentations.MermaidPreview>) -> AnyView
    {
        self.nested(request.receipt, content: ChatMermaidPreviewView(
            svg: request.value.svg,
            background: request.value.background,
            onClose: { self.owner.dismiss(request.receipt) }))
    }
    #endif
}

#if canImport(UIKit)
/// The camera hands us an immutable snapshot, but UIKit does not expose it as
/// Sendable. This wrapper is only used for one detached JPEG encoding pass.
private struct OpenClawSendableCameraImage: @unchecked Sendable {
    let value: UIImage
}

private struct OpenClawVideoTransfer: Sendable, Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { video in
            SentTransferredFile(video.url)
        } importing: { received in
            let fileExtension = received.file.pathExtension
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-picker-video-\(UUID().uuidString)")
                .appendingPathExtension(fileExtension.isEmpty ? "mov" : fileExtension)
            try FileManager.default.copyItem(at: received.file, to: destination)
            return OpenClawVideoTransfer(url: destination)
        }
    }
}

private struct OpenClawPickerTransferUnavailable: LocalizedError {
    var errorDescription: String? {
        String(localized: "Could not load this attachment. Try selecting it again.")
    }
}

/// Receipt and cancellation checks guard work before the VM attachment call.
/// After that handoff, the captured VM session owns completion; replacing
/// or removing a modal does not revoke already admitted attachment work.
@MainActor
@Observable
final class ChatModalAttachmentCapture {
    let viewModel: OpenClawChatViewModel
    let session: OpenClawChatViewModel.SessionSnapshot
    var items: [PhotosPickerItem] = []
    private let current: @MainActor () -> Bool
    private let finish: @MainActor () -> Void
    private var enabled = true
    private var consumed = false
    private var generation = UUID()
    private(set) var task: Task<Void, Never>?

    init(
        viewModel: OpenClawChatViewModel,
        session: OpenClawChatViewModel.SessionSnapshot,
        current: @escaping @MainActor () -> Bool,
        finish: @escaping @MainActor () -> Void)
    {
        self.viewModel = viewModel
        self.session = session
        self.current = current
        self.finish = finish
    }

    private var isCurrent: Bool {
        self.enabled && self.current() && self.viewModel.isCurrentSession(self.session)
    }

    func cancel() {
        self.enabled = false
        self.generation = UUID()
        self.task?.cancel()
    }

    func file(_ result: Result<[URL], Error>) {
        guard !self.consumed else { return }
        self.consumed = true
        defer { self.finish() }
        guard self.isCurrent else { return }
        switch result {
        case let .success(urls):
            self.viewModel.addAttachments(urls: urls, for: self.session)
        case let .failure(error):
            if !(error is CancellationError) { self.viewModel.errorText = error.localizedDescription }
        }
    }

    func camera(_ image: UIImage) {
        guard !self.consumed, self.isCurrent else { return }
        self.consumed = true
        let sendableImage = OpenClawSendableCameraImage(value: image)
        let fileName = "camera-\(UUID().uuidString.prefix(8)).jpg"
        let generation = self.generation
        // Staging begins at the actual result, before JPEG encoding suspends.
        self.viewModel.beginAttachmentStaging()
        self.task = Task { @MainActor in
            defer {
                self.viewModel.endAttachmentStaging()
                self.task = nil
                self.finish()
            }
            let data = await Task.detached(priority: .userInitiated) {
                sendableImage.value.jpegData(compressionQuality: 0.92)
            }.value
            guard !Task.isCancelled, self.generation == generation, self.isCurrent, let data else { return }
            await self.viewModel.addImageAttachment(
                data: data,
                fileName: fileName,
                mimeType: "image/jpeg",
                for: self.session)
        }
    }

    func photos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty, !self.consumed, self.isCurrent else { return }
        self.consumed = true
        self.items = items
        self.viewModel.beginAttachmentStaging()
        self.task = Task { @MainActor in
            defer {
                self.items = []
                self.viewModel.endAttachmentStaging()
                self.task = nil
                self.finish()
            }
            for item in items {
                do {
                    guard !Task.isCancelled, self.isCurrent else { break }
                    let type = item.supportedContentTypes.first(where: {
                        $0.conforms(to: .movie) || $0.conforms(to: .image)
                    }) ?? item.supportedContentTypes.first ?? .image
                    if type.conforms(to: .movie) {
                        guard let transfer = try await item.loadTransferable(type: OpenClawVideoTransfer.self)
                        else { throw OpenClawPickerTransferUnavailable() }
                        defer { try? FileManager.default.removeItem(at: transfer.url) }
                        guard !Task.isCancelled, self.isCurrent else { break }
                        let metadata = OpenClawChatPickerAttachmentMetadata.resolve(
                            contentType: type,
                            transferredFileURL: transfer.url)
                        let name = "video-\(UUID().uuidString.prefix(8)).\(metadata.fileExtension)"
                        await self.viewModel.addVideoAttachment(
                            url: transfer.url,
                            fileName: name,
                            mimeType: metadata.mimeType,
                            expectedSession: self.session)
                    } else {
                        guard let data = try await item.loadTransferable(type: Data.self)
                        else { throw OpenClawPickerTransferUnavailable() }
                        guard !Task.isCancelled, self.isCurrent else { break }
                        let metadata = OpenClawChatPickerAttachmentMetadata.resolve(contentType: type)
                        let name = "photo-\(UUID().uuidString.prefix(8)).\(metadata.fileExtension)"
                        await self.viewModel.addImageAttachment(
                            data: data,
                            fileName: name,
                            mimeType: metadata.mimeType,
                            for: self.session)
                    }
                } catch {
                    guard !Task.isCancelled, self.isCurrent else { break }
                    self.viewModel.errorText = error.localizedDescription
                }
            }
        }
    }
}

@MainActor
private struct ChatModalAttachmentHost: View {
    let owner: OpenClawChatModalPresentations
    let request: OpenClawChatModalPresentations.Request<ChatModalAttachmentCapture>
    let kind: OpenClawChatModalPresentations.AttachmentKind

    private var presented: Binding<Bool> {
        Binding(
            get: { self.owner.isPresented(self.request.receipt) },
            set: { if !$0 { self.owner.dismiss(self.request.receipt) } })
    }

    var body: some View {
        @Bindable var capture = self.request.value
        switch self.kind {
        case .file:
            Color.clear.frame(width: 0, height: 0)
                .fileImporter(
                    isPresented: self.presented,
                    allowedContentTypes: OpenClawChatPickerAttachmentMetadata.allowedFileContentTypes,
                    allowsMultipleSelection: true,
                    onCompletion: self.request.value.file)
        case .photo:
            Color.clear.frame(width: 0, height: 0)
                .photosPicker(
                    isPresented: self.presented,
                    selection: $capture.items,
                    maxSelectionCount: 8,
                    matching: .any(of: [.images, .videos]))
                .onChange(of: capture.items) { _, items in self.request.value.photos(items) }
        case .camera:
            Color.clear.frame(width: 0, height: 0)
                .fullScreenCover(isPresented: self.presented) {
                    OpenClawChatCameraPicker(
                        onImage: self.request.value.camera,
                        onDismiss: { self.owner.dismiss(self.request.receipt) })
                        .ignoresSafeArea()
                }
        }
    }
}

#endif
