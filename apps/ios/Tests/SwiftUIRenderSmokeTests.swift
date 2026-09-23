import Observation
import OpenClawKit
import OpenClawProtocol
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw
@testable import OpenClawChatUI

struct SwiftUIRenderSmokeTests {
    @MainActor private static func modalModel() -> OpenClawChatViewModel {
        OpenClawChatViewModel(
            sessionKey: "agent:main:modal", transport: LocalFixtureChatTransport(fixture: .appleReviewDemo))
    }

    @MainActor private static func modalMessage() -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "assistant", content: [.init(
                type: "text",
                text: "A captured answer.",
                mimeType: nil,
                fileName: nil,
                content: nil)], timestamp: 1)
    }

    @MainActor private static func modalSource() -> ChatSourcePreview {
        ChatSourcePreview(
            url: URL(string: "https://example.com/recorded")!, title: "Recorded source",
            domain: "example.com", excerpt: "Captured excerpt", excerptKind: .page)
    }

    @MainActor private static func presentModal(
        _ kind: String, owner: OpenClawChatModalPresentations, model: OpenClawChatViewModel,
        capture: OpenClawChatModalPresentations.Capture?) -> OpenClawChatModalPresentations.Receipt?
    {
        switch kind {
        case "full":
            owner.present(.init(
                request: .init(viewModel: model, messageID: "captured-message"),
                markdownVariant: .standard), at: \.fullMessage, capture: capture)?.receipt
        case "text":
            owner.present(self.modalMessage(), at: \.selectText, capture: capture)?.receipt
        case "image":
            owner.present(UIImage(), at: \.image, capture: capture)?.receipt
        case "source":
            owner.present(self.modalSource(), at: \.source, capture: capture)?.receipt
        case "diagram":
            owner.present(.init(svg: "<svg/>", background: "#fff"), at: \.mermaid, capture: capture)?.receipt
        case "widget-share":
            owner.present(UIImage(), at: \.widgetImage, capture: capture)?.receipt
        case "widget-error":
            owner.present("Captured export error", at: \.widgetError, capture: capture)?.receipt
        case "file-export":
            (try? ChatDownloadedFile(data: Data("Captured file".utf8), fileName: "capture.txt"))
                .flatMap { owner.present($0, at: \.fileExport, capture: capture)?.receipt }
        case "file-error":
            owner.present((), at: \.fileError, capture: capture)?.receipt
        case "sign-in":
            owner.present(.init(
                context: .init(
                    agentID: "main", request: { _, _ in throw CancellationError() },
                    closeWizard: { _ in throw CancellationError() }, isCurrent: { true }),
                refresh: {}), at: \.signIn, capture: capture)?.receipt
        case "photo": owner.presentAttachment(.photo, viewModel: model, capture: capture)?.receipt
        case "file": owner.presentAttachment(.file, viewModel: model, capture: capture)?.receipt
        case "camera": owner.presentAttachment(.camera, viewModel: model, capture: capture)?.receipt
        default: nil
        }
    }

    @Test(arguments: [
        "full", "text", "image", "source", "diagram", "widget-share", "widget-error", "sign-in",
        "photo", "file", "camera", "file-export", "file-error",
    ])
    @MainActor func `chat modal slots own admission and exact dismissal`(kind: String) throws {
        let model = Self.modalModel()
        let owner = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: model)
        owner.synchronize(origin: origin)
        defer {
            owner.invalidate(origin: origin)
            model.detachTransport()
        }
        var accepted = 0
        var dismissed = 0
        let actions = OpenClawChatModalActions(
            capture: { _ in .init(isCurrent: { true }, accept: {
                #expect(!owner.hasActivePresentation)
                accepted += 1
                return true
            }) }, dismiss: { _ in dismissed += 1 }, isCurrent: { _ in true })
        let first = try #require(Self.presentModal(
            kind,
            owner: owner,
            model: model,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                actions: actions)))
        #expect(accepted == 1)
        #expect(owner.hasActivePresentation(for: origin))
        #expect(owner.isPresented(first))
        owner.dismiss(first)
        #expect(dismissed == 1)
        #expect(!owner.hasActivePresentation)

        let second = try #require(Self.presentModal(
            kind,
            owner: owner,
            model: model,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                actions: actions)))
        #expect(second.id != first.id)
        owner.dismiss(first)
        #expect(owner.isPresented(second))
        #expect(dismissed == 1)
        owner.dismiss(second)
        #expect(dismissed == 2)
        #expect(!owner.hasActivePresentation)
    }

    @Test(arguments: ["image", "source", "diagram", "file-export", "file-error"])
    @MainActor func `nested chat reader keeps parent and rejects stale descendants`(kind: String) throws {
        let model = Self.modalModel()
        let owner = OpenClawChatModalPresentations()
        let otherWindow = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: model)
        owner.synchronize(origin: origin)
        otherWindow.synchronize(origin: origin)
        defer {
            owner.invalidate(origin: origin)
            otherWindow.invalidate(origin: origin)
            model.detachTransport()
        }
        let parent = try #require(Self.presentModal(
            "full",
            owner: owner,
            model: model,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                actions: .local)))
        let childCapture = owner.capture(
            origin: origin, producerID: UUID(), ancestors: [parent.id],
            parentIsCurrent: { owner.isPresented(parent) }, actions: .local)
        let child = try #require(Self.presentModal(kind, owner: owner, model: model, capture: childCapture))
        owner.dismiss(child)
        #expect(owner.isPresented(parent))
        #expect(owner.hasActivePresentation)

        let replacement = try #require(Self.presentModal(
            kind,
            owner: owner,
            model: model,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                ancestors: [parent.id],
                parentIsCurrent: { owner.isPresented(parent) },
                actions: .local)))
        let independent = try #require(Self.presentModal(
            kind,
            owner: otherWindow,
            model: model,
            capture: otherWindow.capture(
                origin: origin,
                producerID: UUID(),
                actions: .local)))
        owner.dismiss(child)
        #expect(owner.isPresented(replacement))
        owner.dismiss(parent)
        #expect(!owner.hasActivePresentation)
        #expect(otherWindow.isPresented(independent))
        #expect(childCapture?.isCurrent == false)
        let nextParent = try #require(Self.presentModal(
            "full",
            owner: owner,
            model: model,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                actions: .local)))
        let nextChild = try #require(Self.presentModal(
            kind,
            owner: owner,
            model: model,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                ancestors: [nextParent.id],
                parentIsCurrent: { owner.isPresented(nextParent) },
                actions: .local)))
        owner.dismiss(parent)
        owner.dismiss(replacement)
        #expect(owner.isPresented(nextParent))
        #expect(owner.isPresented(nextChild))
        #expect(otherWindow.isPresented(independent))
    }

    @Test(arguments: ["text", "file", "file-export", "file-error"])
    @MainActor func `modal capture cannot publish into another owner`(kind: String) throws {
        let model = Self.modalModel()
        let first = OpenClawChatModalPresentations()
        let second = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: model)
        first.synchronize(origin: origin)
        second.synchronize(origin: origin)
        defer {
            first.invalidate(origin: origin)
            second.invalidate(origin: origin)
            model.detachTransport()
        }
        var retirements = 0
        let actions = OpenClawChatModalActions(
            capture: { _ in .init(isCurrent: { true }, accept: { retirements += 1
                return true
            }) },
            dismiss: { _ in }, isCurrent: { _ in true })
        let capture = try #require(first.capture(origin: origin, producerID: UUID(), actions: actions))
        #expect(Self.presentModal(kind, owner: second, model: model, capture: capture) == nil)
        #expect(retirements == 0)
        #expect(!first.hasActivePresentation && !second.hasActivePresentation)
        #expect(Self.presentModal(kind, owner: first, model: model, capture: capture) != nil)
        #expect(retirements == 1)
    }

    @Test @MainActor func `file picker dismissal keeps only its captured completion owner`() throws {
        let model = Self.modalModel()
        model.input = "Keep this picker draft"
        let owner = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: model)
        owner.synchronize(origin: origin)
        defer { owner.invalidate(origin: origin)
            model.detachTransport()
        }
        let context = ChatModalContext(
            owner: owner, origin: origin, producerID: UUID(), ancestors: [],
            parentIsCurrent: { true }, actions: .local)
        owner.attachmentBinding(.file, context: context, viewModel: model, enabled: true).wrappedValue = true
        let first = try #require(owner.fileResult)
        let firstBinding = owner.attachmentBinding(.file, context: context, viewModel: model, enabled: true)
        // fileImporter sets false before completion; cancel also sets false with no completion.
        firstBinding.wrappedValue = false
        #expect(!owner.hasActivePresentation)
        #expect(owner.fileResult?.id == first.id)
        first.value.file(.failure(NSError(
            domain: "fixture",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "First captured result"])))
        #expect(model.errorText == "First captured result")
        #expect(model.input == "Keep this picker draft")
        #expect(owner.fileResult == nil)

        owner.attachmentBinding(.file, context: context, viewModel: model, enabled: true).wrappedValue = true
        let second = try #require(owner.fileResult)
        firstBinding.wrappedValue = false
        first.value.file(.failure(NSError(domain: "fixture", code: 2)))
        #expect(owner.fileImporter?.id == second.id)
        #expect(owner.fileResult?.id == second.id)
        #expect(model.errorText == "First captured result")
        owner.dismiss(second.receipt)
        #expect(!owner.hasActivePresentation)
        #expect(owner.fileResult?.id == second.id)
        owner.attachmentBinding(.file, context: context, viewModel: model, enabled: true).wrappedValue = true
        let third = try #require(owner.fileResult)
        second.value.file(.failure(NSError(domain: "fixture", code: 3)))
        #expect(owner.fileImporter?.id == third.id)
        #expect(owner.fileResult?.id == third.id)
        #expect(model.errorText == "First captured result")
        owner.dismiss(third.receipt)
        owner.invalidate(origin: origin)
        #expect(owner.fileResult == nil)
        third.value.file(.failure(NSError(domain: "fixture", code: 4)))
        #expect(model.errorText == "First captured result")
        #expect(model.input == "Keep this picker draft")
    }

    @Test @MainActor func `picker session is captured before admission can change the model`() async throws {
        let model = Self.modalModel()
        let owner = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: model)
        let original = model.currentSessionSnapshot()
        owner.synchronize(origin: origin)
        defer { owner.invalidate(origin: origin)
            model.detachTransport()
        }
        let actions = OpenClawChatModalActions(
            capture: { _ in .init(isCurrent: { true }, accept: {
                #expect(model.switchSession(to: "agent:main:replacement"))
                return true
            }) }, dismiss: { _ in }, isCurrent: { _ in true })
        let published = owner.presentAttachment(
            .file,
            viewModel: model,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                actions: actions))
        // The accepted bootstrap-join repair exposes this existing task's getter.
        let bootstrap = model.bootstrapTask
        if let bootstrap { await bootstrap.value }
        let request = try #require(published)
        #expect(request.value.session == original)
        #expect(!model.isCurrentSession(original))
        model.errorText = "Successor state"
        request.value.file(.failure(NSError(domain: "fixture", code: 1)))
        #expect(model.errorText == "Successor state")
        #expect(model.attachments.isEmpty)
        #expect(owner.fileResult == nil)
    }

    @Test @MainActor func `camera result uses captured session and joins its encoding owner`() async throws {
        let model = Self.modalModel()
        let owner = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: model)
        owner.synchronize(origin: origin)
        defer { owner.invalidate(origin: origin)
            model.detachTransport()
        }
        let request = try #require(owner.presentAttachment(
            .camera,
            viewModel: model,
            capture: owner.capture(
                origin: origin,
                producerID: UUID(),
                actions: .local)))
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        owner.dismiss(request.receipt)
        #expect(!owner.hasActivePresentation)
        request.value.camera(image)
        let encoding = try #require(request.value.task)
        await encoding.value
        #expect(request.value.task == nil)
        #expect(owner.cameraResult == nil)
        #expect(model.attachments.count == 1)
        #expect(model.attachments.first?.mimeType == "image/jpeg")
        let attachmentIDs = model.attachments.map(\.id)
        request.value.camera(image)
        #expect(model.attachments.map(\.id) == attachmentIDs)
    }

    @Test(arguments: ["sign-in", "widget-share", "widget-error", "file-export", "file-error"])
    @MainActor func `delayed modal publication cannot survive open close ABA`(kind: String) async throws {
        let model = Self.modalModel()
        let appModel = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let router = NativeActionRouter(appModel: appModel, gatewayController: controller)
        let rootID = router.registerPresentation(onRetire: { _ in }, { _, _, _ in })
        let owner = OpenClawChatModalPresentations()
        let origin = OpenClawChatModalOrigin(viewModel: model)
        owner.synchronize(origin: origin)
        defer {
            owner.invalidate(origin: origin)
            router.unregisterPresentation(rootID)
            model.detachTransport()
        }
        let actions = RootTabs.makeChatModalActions(
            origin: origin, router: router, rootID: rootID,
            isCurrentScope: { true }, isCurrentContainer: { true })
        let captured = try #require(owner.capture(origin: origin, producerID: UUID(), actions: actions))
        let release = AsyncStream<Void>.makeStream()
        var published = false
        let publication = Task { @MainActor in
            for await _ in release.stream {
                break
            }
            published = Self.presentModal(kind, owner: owner, model: model, capture: captured) != nil
        }
        do {
            let intervening = try #require(Self.presentModal(
                "text",
                owner: owner,
                model: model,
                capture: owner.capture(
                    origin: origin,
                    producerID: UUID(),
                    actions: actions)))
            owner.dismiss(intervening)
            #expect(!owner.hasActivePresentation)
            release.continuation.finish()
            await publication.value
            #expect(!published)
            #expect(!owner.hasActivePresentation)
            let fresh = try #require(Self.presentModal(
                kind,
                owner: owner,
                model: model,
                capture: owner.capture(
                    origin: origin,
                    producerID: UUID(),
                    actions: actions)))
            #expect(owner.isPresented(fresh))
        } catch {
            release.continuation.finish()
            await publication.value
            throw error
        }
    }

    @Test @MainActor func `old notification sheet binding cannot dismiss another path`() {
        var sheet: RootTabs.PresentedSheet? = .notificationSettings(path: "first")
        var admissions = 0
        let source = Binding(get: { sheet }, set: { sheet = $0 })
        let old = RootTabs.matchedModalBinding(source, admit: { admissions += 1
            return true
        })
        sheet = .notificationSettings(path: "second")
        #expect(sheet?.id == RootTabs.PresentedSheet.notificationSettings(path: "first").id)
        old.wrappedValue = nil
        #expect(sheet == .notificationSettings(path: "second"))
        #expect(admissions == 0)
        let current = RootTabs.matchedModalBinding(source, admit: { admissions += 1
            return true
        })
        current.wrappedValue = nil
        #expect(sheet == nil)
        #expect(admissions == 1)
        #expect(RootTabs.PresentedSheet.sessionDashboard(sessionKey: "x:y", agentId: "a") !=
            .sessionDashboard(sessionKey: "y", agentId: "a:x"))
    }

    @MainActor @Observable
    fileprivate final class NativeChatPresentation {
        var binding: IOSNativeActionBinding?
        var isVisible = true
        var ordinarySynchronizations = 0
        var synchronizedRequestID = 0
        var synchronizedRegistrationID: UUID?
        var startedNewChats: [UUID: (requestID: Int, taskID: ObjectIdentifier)] = [:]
        var startedSynchronizations: [UUID: Int] = [:]
        var completedSynchronizations: Set<UUID> = []
        var completedNewChats: [UUID: Bool] = [:]
    }

    private struct NativeChatHost: View {
        @Environment(NodeAppModel.self) private var appModel
        @Environment(NativeActionRouter.self) private var nativeActions: NativeActionRouter?
        let presentation: NativeChatPresentation
        let presentationID: UUID?

        private var currentPresentation: IOSChatViewModelOwner.Presentation {
            .init(binding: self.presentation.binding, router: self.nativeActions, id: self.presentationID)
        }

        var body: some View {
            let newChat = self.appModel.chatPresentation.currentNewChatRequest(
                appModel: self.appModel, presentation: self.currentPresentation)
            return ZStack {
                if self.presentation.isVisible {
                    ChatProTab(nativeBinding: self.presentation.binding, nativePresentationID: self.presentationID)
                } else {
                    Color.clear
                }
            }
            .task(id: self.appModel.chatPresentation.taskIdentity(
                appModel: self.appModel, nativeBinding: self.presentation.binding,
                presentationID: self.presentationID,
                chatRegistrationID: self.nativeActions?.chatRegistrationID,
                presentationAuthority: self.nativeActions?.capturePresentationAuthority(self.presentationID)))
            {
                let binding = self.presentation.binding
                let requestID = self.appModel.newChatRequestID
                let synchronizationID = UUID()
                self.presentation.startedSynchronizations[synchronizationID] = requestID
                defer { self.presentation.completedSynchronizations.insert(synchronizationID) }
                let registrationID = self.nativeActions?.chatRegistrationID
                await self.appModel.chatPresentation.synchronizePresentation(
                    appModel: self.appModel, currentPresentation: { self.currentPresentation })
                if !Task.isCancelled, registrationID == self.nativeActions?.chatRegistrationID {
                    self.presentation.synchronizedRegistrationID = registrationID
                }
                if !Task.isCancelled, binding == nil {
                    self.presentation.ordinarySynchronizations += 1
                    self.presentation.synchronizedRequestID = requestID
                }
            }
            .task(id: newChat.map(ObjectIdentifier.init)) {
                    guard let newChat else { return }
                    let invocationID = UUID()
                    self.presentation.startedNewChats[invocationID] = (newChat.id, ObjectIdentifier(newChat))
                    let result = await self.appModel.chatPresentation.performNewChat(
                        newChat, appModel: self.appModel, currentPresentation: { self.currentPresentation })
                    self.presentation.completedNewChats[invocationID] = result
                }
        }
    }

    @MainActor private static func host(_ view: some View, size: CGSize? = nil) -> UIWindow {
        let frame = CGRect(origin: .zero, size: size ?? UIScreen.main.bounds.size)
        let window = UIWindow(frame: frame)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @MainActor private static func hostNativeChat(
        _ view: some View,
        previousKeyWindow: inout UIWindow?) throws -> UIWindow
    {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
        try #require(scenes.count == 1)
        let scene = try #require(scenes.first)
        previousKeyWindow = scene.windows.first { $0.isKeyWindow && !$0.isHidden }
        // A frame-only window has no scene and need not materialize its SwiftUI editor.
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.setNeedsLayout()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    @MainActor private static func composer(
        in window: UIWindow,
        expectedText: String) async throws -> ChatComposerUITextView
    {
        let deadline = ContinuousClock.now + .seconds(2)
        repeat {
            var pending: [UIView] = [window]
            var inputs: [ChatComposerUITextView] = []
            var visited = 0
            while let view = pending.popLast() {
                visited += 1
                try #require(visited <= 512)
                if let input = view as? ChatComposerUITextView { inputs.append(input) }
                pending.append(contentsOf: view.subviews)
            }
            try #require(inputs.count <= 1)
            if let input = inputs.first, input.window === window,
               input.bounds.width > 0, input.bounds.height > 0,
               (input.text ?? "").utf8.elementsEqual(expectedText.utf8)
            {
                return input
            }
            try await Task.sleep(for: .milliseconds(10))
        } while ContinuousClock.now < deadline
        throw OpenClawNativeActionError("Native chat editor did not materialize its expected text")
    }

    @Test @MainActor func `settings hub fallback builds in light and dark mode`() {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        for scheme in [ColorScheme.light, ColorScheme.dark] {
            let appModel = NodeAppModel()
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let root = SettingsHubScreen(navigationPath: .constant([]))
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

            windows.append(Self.host(root))
        }
    }

    @Test @MainActor func `settings About destination builds in light and dark mode`() {
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            for typeSize in [DynamicTypeSize.large, .accessibility2] {
                let appModel = NodeAppModel()
                let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

                let root = NavigationStack {
                    SettingsProTab(directRoute: .about)
                }
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .environment(\.dynamicTypeSize, typeSize)
                .preferredColorScheme(scheme)

                _ = Self.host(root, size: CGSize(width: 320, height: 852))
            }
        }
    }

    @Test @MainActor func `settings Licenses destination builds in light and dark mode`() throws {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        let document = try #require(LicenseDocumentLoader.bundledDocuments().first)
        for scheme in [ColorScheme.light, ColorScheme.dark] {
            for route in [SettingsRoute.licenses, .licenseDocument(id: document.id)] {
                let appModel = NodeAppModel()
                let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)

                let root = NavigationStack {
                    SettingsProTab(directRoute: route)
                }
                .environment(AppAppearanceModel())
                .environment(appModel)
                .environment(appModel.voiceWake)
                .environment(gatewayController)
                .preferredColorScheme(scheme)

                windows.append(Self.host(root, size: CGSize(width: 393, height: 852)))
            }
        }
    }

    @Test @MainActor func `display math builds valid and fallback view hierarchies`() {
        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = VStack {
                ChatMarkdownRenderer(
                    text: #"Inline math \(E = mc^2\) stays inside prose."#,
                    context: .assistant,
                    variant: .standard,
                    textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"\notARealCommand{"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: "α + β = γ",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: String(repeating: "{", count: 65) + "x",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: String(repeating: #"\bar"#, count: 129) + "x",
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
                ChatMathBlockView(block: ChatMathBlock(
                    latex: #"x\textcolor{#fff}{}"#,
                    isComplete: true), textColor: OpenClawChatTheme.assistantText)
            }
            .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 393, height: 240))
        }
    }

    @Test @MainActor func `long user prompt disclosure builds across dynamic type sizes`() {
        let text = Array(repeating: "A long user-authored prompt line.", count: 13).joined(separator: "\n")
        let message = OpenClawChatMessage(
            role: "user",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: nil)

        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = ChatMessageBubble(
                message: message,
                style: .standard,
                markdownVariant: .standard,
                userAccent: nil,
                displayOptions: [],
                assistantName: "OpenClaw",
                assistantAvatarText: "OC",
                assistantAvatarTint: nil,
                showsAssistantAvatar: true,
                isClean: false,
                contextWindowTokens: nil,
                userMessageExpanded: false,
                onToggleUserMessageExpanded: {},
                inlineWidgetResolverReady: true,
                inlineWidgetResourceResolver: { _, _ in nil },
                mediaArtifactResolverReady: false,
                mediaPlaybackAllowed: { true },
                loadMediaArtifact: { _, _, _ in nil })
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 320, height: 420))
        }
    }

    @Test @MainActor func `managed assistant image starts its artifact load`() async throws {
        let artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111"
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "image",
                text: nil,
                mimeType: "image/png",
                fileName: nil,
                artifactId: artifactId,
                url: "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full",
                alt: "Managed preview",
                content: nil)],
            timestamp: 1)
        var requestedArtifactId: String?
        let root = ChatMessageBubble(
            message: message,
            style: .standard,
            markdownVariant: .standard,
            userAccent: nil,
            displayOptions: [],
            assistantName: "OpenClaw",
            assistantAvatarText: "OC",
            assistantAvatarTint: nil,
            showsAssistantAvatar: true,
            isClean: false,
            contextWindowTokens: nil,
            userMessageExpanded: false,
            onToggleUserMessageExpanded: {},
            inlineWidgetResolverReady: true,
            inlineWidgetResourceResolver: { _, _ in nil },
            mediaArtifactResolverReady: true,
            mediaPlaybackAllowed: { true },
            loadMediaArtifact: { requested, kind, _ in
                requestedArtifactId = requested
                #expect(kind == .image)
                return OpenClawChatLoadedMedia.data(OpenClawChatMediaData(
                    data: Data(base64Encoded:
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8A" +
                            "AusB9Y9Zl1sAAAAASUVORK5CYII=")!,
                    mimeType: "image/png"))
            })
        let window = Self.host(root, size: CGSize(width: 393, height: 420))
        defer { window.isHidden = true }

        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while requestedArtifactId == nil, ContinuousClock().now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(requestedArtifactId == artifactId)
    }

    @Test(arguments: ["new-chat", "send", "reopen", "profile-reopen"])
    @MainActor func `native chat owns routing across activation and explicit reopen`(action: String) async throws {
        try await Self.nativeChatFixture(action: action)
    }

    @Test(arguments: ["pending", "reserved"])
    @MainActor func `native compose preserves dictation`(capturePhase: String) async throws {
        try await Self.nativeChatFixture(action: "dictation-\(capturePhase)")
    }

    @Test @MainActor func `unbound chat adopts a new session without native registration`() async throws {
        try await Self.nativeChatFixture(action: "unbound-new-chat")
    }

    @Test @MainActor func `retired native chat ignores late session creation and releases its router`() async throws {
        try await Self.nativeChatFixture(action: "retired-new-chat")
    }

    @Test(arguments: ["text", "attachment", "queued", "queued-retired"])
    @MainActor func `ordinary sidebar return attests the retained native owner`(state: String) async throws {
        try await Self.nativeChatFixture(action: "sidebar-\(state)")
    }

    @Test(arguments: ["native-renewal", "native-renewal-departure", "ordinary-renewal", "ordinary-renewal-departure"])
    @MainActor func `same-model registration does not cancel admitted New Chat`(action: String) async throws {
        try await Self.nativeChatFixture(action: action)
    }

    @Test(arguments: [
        "ordinary-cold-routing",
        "ordinary-selection-readiness",
        "ordinary-cold-connection",
        "ordinary-pending-user-aba",
        "ordinary-pending-account-aba",
        "ordinary-stale-sync",
    ])
    @MainActor func `New Chat preserves its origin through readiness`(action: String) async throws {
        try await Self.nativeChatFixture(action: action)
    }

    @Test @MainActor func `standalone fixture New Chat keeps its factory transport`() async throws {
        try await withUserDefaults([
            "talk.enabled": false, "talk.background.enabled": false, VoiceWakePreferences.enabledKey: false,
        ]) {
            let appModel = NodeAppModel()
            appModel.enterAppleReviewDemoMode()
            let owner = appModel.chatPresentation
            let presentation = IOSChatViewModelOwner.Presentation(binding: nil, router: nil, id: nil)
            let result: Result<Void, Error>
            do {
                owner.requestNewChat(appModel: appModel, presentation: presentation)
                await owner.synchronizePresentation(appModel: appModel, currentPresentation: { presentation })
                let request = try #require(owner.currentNewChatRequest(appModel: appModel, presentation: presentation))
                let model = try #require(owner.viewModel)
                let initial = model.currentSessionTarget
                #expect(owner.transport == nil)
                #expect(model.transport is LocalFixtureChatTransport)
                let adopted = await owner.performNewChat(
                    request, appModel: appModel, currentPresentation: { presentation })
                #expect(adopted)
                #expect(model.currentSessionTarget != initial)
                #expect(!appModel.consumeNewChatRequest(request.id))
                result = .success(())
            } catch {
                result = .failure(error)
            }
            owner.viewModel?.detachTransport()
            appModel.disconnectGateway()
            await appModel.waitForGatewaySessionResetIfNeeded()
            appModel.voiceWake.stop()
            try result.get()
        }
    }

    @MainActor private static func nativeChatFixture(action: String) async throws {
        weak var routerLifetime: NativeActionRouter?
        try await withUserDefaults([
            "talk.enabled": false, "talk.background.enabled": false, VoiceWakePreferences.enabledKey: false,
        ]) {
            let isDictation = action == "dictation-pending" || action == "dictation-reserved"
            let isUnbound = action == "unbound-new-chat"
            let isOrdinary = isUnbound || action.hasPrefix("ordinary-")
            let renewsDuringCreate = action.contains("-renewal")
            let testsReadiness = isOrdinary && !isUnbound && !renewsDuringCreate
            let connectsDuringRestore = action == "ordinary-cold-connection"
            let retiresDuringCreate = action == "retired-new-chat"
            let sidebarReturn = action.hasPrefix("sidebar-")
            let session = OpenClawNativeSessionRef(
                owner: .init(gatewayID: "chat-activation-\(UUID().uuidString)", profileID: "profile-b"),
                agentID: "main",
                sessionKey: "agent:main:native-b")
            let expectedProfile = isOrdinary ? nil : session.owner.profileID
            var createdProfiles: [String?] = []
            var createdKeys: [String] = []
            var createdAgentIDs: [String?] = []
            var createdParentKeys: [String?] = []
            var beforeCreateResponse: (@MainActor () -> Void)?
            var createWaiters: [CheckedContinuation<Void, Never>] = []
            var createReleased = false
            @MainActor func releaseCreates() {
                createReleased = true
                let waiters = createWaiters
                createWaiters.removeAll()
                for waiter in waiters {
                    waiter.resume()
                }
            }
            var sentParams: [[String: Any]] = []
            var issuedRunIDs: Set<String> = []
            var routingReads = 0
            var rpcCount = 0
            var phase = "setup"
            var callbackViolations: [String] = []
            var callbackViolationCount = 0
            weak var diagnosticAppModel: NodeAppModel?
            weak var diagnosticCreatingModel: OpenClawChatViewModel?
            weak var ordinaryReplacementModel: OpenClawChatViewModel?
            var hasObservedOrdinaryReplacement = false
            var hasObservedOrdinaryCommands = false
            var creatingAtResponse: Bool?
            @MainActor func modelFacts(_ model: OpenClawChatViewModel?) -> String {
                "present=\(model != nil),detached=\(model?.isTransportDetached == true)," +
                    "native=\((model?.transport as? IOSGatewayChatTransport)?.nativeBinding != nil)," +
                    "original=\(model?.sessionKey == session.sessionKey)," +
                    "created=\(model.map { createdKeys.contains($0.sessionKey) } == true)," +
                    "agent=\(model?.activeAgentId == session.agentID)"
            }
            var lifetimeRows: [String] = []
            var lifetimeTotal = 0
            var lifetimeOrigin = "unobserved"
            weak var diagnosticRouter: NativeActionRouter?
            var diagnosticRootID: UUID?
            @MainActor func observeLifetime(_ tag: String) {
                lifetimeTotal += 1
                guard lifetimeRows.count < 32 else { return }
                let published = diagnosticAppModel?.chatPresentation.viewModel
                lifetimeRows.append(
                    "order=\(lifetimeTotal) phase=\(phase) origin=\(lifetimeOrigin) event=\(tag) " +
                        "root=\(diagnosticRouter?.presentationRegistrationID != nil) " +
                        "sameRoot=\(diagnosticRootID != nil && diagnosticRouter?.presentationRegistrationID == diagnosticRootID) " +
                        "chat=\(diagnosticRouter?.chatRegistrationID != nil) " +
                        "sameModel=\(diagnosticCreatingModel != nil && diagnosticCreatingModel === published) " +
                        "published[\(modelFacts(published))] creating[\(modelFacts(diagnosticCreatingModel))]")
            }
            @MainActor func lifetimeSummary() -> String {
                "lifetime total=\(lifetimeTotal) truncated=\(lifetimeTotal > 32) \(lifetimeRows.joined(separator: " | "))"
            }
            @MainActor func observeCallback(
                _ condition: Bool,
                rule: String,
                method: String,
                profile: String? = nil,
                params: [String: Any] = [:])
            {
                guard !condition else { return }
                callbackViolationCount += 1
                guard callbackViolations.count < 16 else { return }
                let profileClass = profile == nil ? "nil" : (profile == expectedProfile ? "expected" : "other")
                let published = diagnosticAppModel?.chatPresentation.viewModel
                let same = diagnosticCreatingModel != nil && diagnosticCreatingModel === published
                let commandsShape = Set(params.keys) == ["scope", "includeArgs", "agentId"]
                let subscribeShape = Set(params.keys).isSubset(of: ["key", "agentId"]) && params["key"] is String
                // Record only fixed scalar facts at the callback, never a model,
                // request dictionary, raw key, profile ID, or a later-state closure.
                callbackViolations.append(
                    "action=\(action) method=\(method) phase=\(phase) rule=\(rule) profile=\(profileClass) " +
                        "commandsShape=\(commandsShape) text=\(params["scope"] as? String == "text") args=\(params["includeArgs"] as? Bool == true) " +
                        "subscribeShape=\(subscribeShape) keyOriginal=\(params["key"] as? String == session.sessionKey) " +
                        "keyCreated=\((params["key"] as? String).map { createdKeys.contains($0) } == true) agent=\(params["agentId"] as? String == session.agentID) " +
                        "sameModel=\(same) creating[\(modelFacts(diagnosticCreatingModel))] published[\(modelFacts(published))]")
            }
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                hello: .init(
                    role: "operator",
                    scopes: ["operator.read", "operator.write"],
                    capabilities: [
                        GatewayServerCapability.profileBinding.rawValue,
                        GatewayServerCapability.chatSendRoutingContract.rawValue,
                        GatewayServerCapability.sessionSettingsCAS.rawValue,
                    ]),
                rpcHandler: { frame in
                    rpcCount += 1
                    guard let method = frame["method"] as? String else {
                        observeCallback(false, rule: "missing-method", method: "unknown")
                        return .failure(code: "INVALID_REQUEST", message: "Missing method")
                    }
                    let profile = frame["expectedProfileId"] as? String
                    let params = frame["params"] as? [String: Any] ?? [:]
                    let methodLabel: String = switch method {
                    case "users.self", "agents.list", "chat.history", "sessions.messages.subscribe", "health",
                         "sessions.list", "chat.send", "models.list", "commands.list", "chat.metadata", "tasks.list",
                         "sessions.create", "agent.wait", "config.get": method
                    default: "unknown"
                    }
                    var ordinaryReplacementBootstrap = false
                    if retiresDuringCreate, frame["expectedProfileId"] == nil,
                       let appModel = diagnosticAppModel,
                       let creating = diagnosticCreatingModel,
                       let published = appModel.chatPresentation.viewModel,
                       !hasObservedOrdinaryReplacement || ordinaryReplacementModel === published,
                       creating !== published, creating.isTransportDetached, !published.isTransportDetached,
                       let creatingTransport = creating.transport as? IOSGatewayChatTransport,
                       let publishedTransport = published.transport as? IOSGatewayChatTransport,
                       let binding = creatingTransport.nativeBinding, binding.session == session,
                       publishedTransport.nativeBinding == nil,
                       creatingTransport.gateway === appModel.operatorSession,
                       publishedTransport.gateway === appModel.operatorSession,
                       creating.sessionKey.utf8.elementsEqual(session.sessionKey.utf8),
                       published.sessionKey.utf8.elementsEqual(session.sessionKey.utf8),
                       creating.activeAgentId?.utf8.elementsEqual(session.agentID.utf8) == true,
                       published.activeAgentId?.utf8.elementsEqual(session.agentID.utf8) == true
                    {
                        // Retiring the mounted native presentation can publish an ordinary
                        // replacement. Only its two initial read shapes may omit the profile;
                        // the detached native capture and every mutation remain pinned.
                        ordinaryReplacementBootstrap = switch method {
                        case "commands.list":
                            !hasObservedOrdinaryCommands && Set(params.keys) == ["scope", "includeArgs", "agentId"] &&
                                params["scope"] as? String == "text" && params["includeArgs"] as? Bool == true &&
                                (params["agentId"] as? String)?.utf8.elementsEqual(session.agentID.utf8) == true
                        case "sessions.messages.subscribe":
                            Set(params.keys) == ["key"] &&
                                (params["key"] as? String)?.utf8.elementsEqual(session.sessionKey.utf8) == true
                        default: false
                        }
                        if ordinaryReplacementBootstrap {
                            ordinaryReplacementModel = published
                            hasObservedOrdinaryReplacement = true
                            // The fixture returns a successful catalog and never requests a refresh.
                            // A duplicate unpinned command read must still fail the native oracle.
                            if method == "commands.list" { hasObservedOrdinaryCommands = true }
                        }
                    }
                    if method == "sessions.list", params["limit"] as? Int == 80 {
                        // This is the ordinary share-route refresh scheduled by agent selection.
                        observeCallback(
                            profile == nil,
                            rule: "share-profile",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        observeCallback(
                            Set(params.keys) == ["limit", "includeGlobal", "includeUnknown", "agentId"],
                            rule: "share-shape",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        observeCallback(
                            params["includeGlobal"] as? Bool == true,
                            rule: "share-global",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        observeCallback(
                            params["includeUnknown"] as? Bool == false,
                            rule: "share-unknown",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        observeCallback(
                            params["agentId"] as? String == session.agentID,
                            rule: "share-agent",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                    } else {
                        observeCallback(
                            profile == expectedProfile || ordinaryReplacementBootstrap,
                            rule: "selected-profile",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                    }
                    switch method {
                    case "config.get":
                        return .success([
                            "config": ["session": ["mainKey": "main", "scope": "per-sender"]],
                            "runtimeConfig": ["session": ["mainKey": "main", "scope": "per-sender"]],
                        ])
                    case "users.self":
                        return .success(["profile": ["id": session.owner.profileID]])
                    case "agents.list":
                        routingReads += 1
                        return .success([
                            "defaultId": "main", "mainKey": "main", "scope": "per-sender",
                            "agents": [["id": "main"]],
                        ])
                    case "chat.history":
                        guard let key = params["sessionKey"] as? String else {
                            observeCallback(
                                false,
                                rule: "missing-history-key",
                                method: methodLabel,
                                profile: profile,
                                params: params)
                            return .failure(code: "INVALID_REQUEST", message: "Missing session key")
                        }
                        return .success([
                            "sessionKey": key, "sessionId": "native-session", "messages": [],
                            "sessionInfo": [
                                "key": key, "agentId": session.agentID, "sessionId": "native-session",
                                "permissionMode": "guarded", "toolOverrides": [:],
                            ],
                        ])
                    case "sessions.messages.subscribe":
                        guard let key = params["key"] as? String else {
                            observeCallback(
                                false,
                                rule: "missing-subscribe-key",
                                method: methodLabel,
                                profile: profile,
                                params: params)
                            return .failure(code: "INVALID_REQUEST", message: "Missing session key")
                        }
                        return .success(["subscribed": true, "key": key])
                    case "health":
                        return .success(["ok": true])
                    case "sessions.list":
                        return .success(["ts": 0, "count": 1, "sessions": [[
                            "key": session.sessionKey, "agentId": session.agentID, "sessionId": "native-session",
                            "permissionMode": "guarded", "toolOverrides": [:],
                        ]]])
                    case "chat.send":
                        sentParams.append(params)
                        let runID = "native-run"
                        issuedRunIDs.insert(runID)
                        return .success(["runId": runID, "status": "ok"])
                    case "agent.wait":
                        // Run adoption may start a waiter before terminal-ACK reconciliation.
                        // Only this fixture's successfully issued runs have a completed result.
                        let valid = Set(params.keys) == ["runId", "timeoutMs"] &&
                            issuedRunIDs.contains(params["runId"] as? String ?? "") &&
                            (params["timeoutMs"] as? Int ?? 0) > 0
                        observeCallback(
                            valid,
                            rule: "issued-run-wait",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        guard valid else { return .failure(code: "INVALID_REQUEST", message: "Invalid fixture wait") }
                        return .success(["status": "ok"])
                    case "models.list":
                        return .success(["models": []])
                    case "commands.list":
                        return .success(["commands": []])
                    case "chat.metadata":
                        return .success(["swarmEnabled": false])
                    case "tasks.list":
                        return .success(["tasks": []])
                    case "sessions.create":
                        createdProfiles.append(profile)
                        createdAgentIDs.append(params["agentId"] as? String)
                        createdParentKeys.append(params["parentSessionKey"] as? String)
                        guard let key = params["key"] as? String else {
                            observeCallback(
                                false,
                                rule: "missing-create-key",
                                method: methodLabel,
                                profile: profile,
                                params: params)
                            return .failure(code: "INVALID_REQUEST", message: "Missing session key")
                        }
                        createdKeys.append(key)
                        beforeCreateResponse?()
                        beforeCreateResponse = nil
                        if renewsDuringCreate || testsReadiness {
                            return .deferred {
                                if !createReleased { await withCheckedContinuation { createWaiters.append($0) } }
                                return .success(["ok": true, "key": key])
                            }
                        }
                        return .success(["ok": true, "key": key])
                    default:
                        observeCallback(
                            false,
                            rule: "unexpected-method",
                            method: methodLabel,
                            profile: profile,
                            params: params)
                        return .failure(code: "INVALID_REQUEST", message: "Unexpected fixture method: \(method)")
                    }
                })
            let appModel = NodeAppModel(audioAdmissionInitiallyAllowed: isDictation)
            diagnosticAppModel = appModel
            let gateway = appModel.operatorSession
            let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let router = NativeActionRouter(appModel: appModel, gatewayController: gatewayController)
            routerLifetime = router
            diagnosticRouter = router
            let originalLifetimeObservation = router.testLifetimeObservation
            router.testLifetimeObservation = { observeLifetime($0) }
            defer { router.testLifetimeObservation = originalLifetimeObservation }
            let originalSelectionDidChange = appModel.chatSelectionDidChange
            appModel.chatSelectionDidChange = {
                let previousOrigin = lifetimeOrigin
                lifetimeOrigin = "selection-callback"
                defer { lifetimeOrigin = previousOrigin }
                observeLifetime("selection-before")
                originalSelectionDidChange?()
                observeLifetime("selection-after")
            }
            // This fixture is the only callback installer after its Router. Restore
            // on every exit, after the existing transport/UI join attempts below.
            defer { appModel.chatSelectionDidChange = originalSelectionDidChange }
            let presentation = NativeChatPresentation()
            let presentationID = router
                .registerPresentation(
                    onRetire: { disposition in
                        let tag = switch disposition {
                        case .departure: "retire-departure"
                        case .chatModal: "retire-modal"
                        case .chatSessionTransition: "retire-session"
                        }
                        observeLifetime(tag)
                        presentation.binding = nil
                    },
                    onSessionAdopted: { previous, binding in
                        guard presentation.binding == nil || presentation.binding?.canReuse(previous) == true
                        else { return }
                        presentation.binding = binding
                    }) { request, binding, _ in
                        appModel.setSelectedAgentId(request.session.agentID)
                        appModel.focusChatSession(request.session.sessionKey)
                        presentation.binding = binding
                }
            diagnosticRootID = presentationID
            var releaseRestore: CheckedContinuation<Void, Never>?
            var restoreReturned = false
            var restoreWaiters: [(requestID: Int, continuation: CheckedContinuation<Void, Never>)] = []
            var releasedRestoreRequests: Set<Int> = []
            var restoreAllReleased = false
            @MainActor func releaseRestores(for requestID: Int? = nil) {
                if let requestID { releasedRestoreRequests.insert(requestID) } else { restoreAllReleased = true }
                let ready = restoreWaiters.filter { requestID == nil || $0.requestID == requestID }
                restoreWaiters.removeAll { requestID == nil || $0.requestID == requestID }
                for waiter in ready {
                    waiter.continuation.resume()
                }
            }
            appModel.testChatSessionRoutingRestoreHandler = {
                if testsReadiness {
                    let requestID = appModel.newChatRequestID
                    if !restoreAllReleased, !releasedRestoreRequests.contains(requestID) {
                        await withCheckedContinuation { restoreWaiters.append((requestID, $0)) }
                    }
                } else {
                    // Unbound New Chat synchronizes again after this first cold restore gate.
                    if sidebarReturn || renewsDuringCreate || isUnbound, restoreReturned { return }
                    await withCheckedContinuation { releaseRestore = $0 }
                }
                restoreReturned = true
            }
            var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
            options.deviceAuthGatewayID = session.owner.gatewayID
            options.allowStoredDeviceAuth = false
            var window: UIWindow?
            var previousKeyWindow: UIWindow?
            let releaseWindow: () -> Void = {
                // Restore only while this fixture still owns key status. Teardown can
                // synchronously install a successor that must not be overridden.
                if let window, window.isKeyWindow, let scene = window.windowScene,
                   let previousKeyWindow, !previousKeyWindow.isHidden,
                   previousKeyWindow.windowScene === scene
                {
                    previousKeyWindow.makeKey()
                }
                window?.isHidden = true
                window?.rootViewController = nil
                window = nil
                previousKeyWindow = nil
            }
            let outcome: Result<Void, Error>
            do {
                defer {
                    phase = "cleanup"
                    releaseRestores()
                    releaseRestore?.resume()
                    releaseRestore = nil
                    appModel.testChatSessionRoutingRestoreHandler = nil
                    beforeCreateResponse = nil
                    releaseCreates()
                    releaseWindow()
                    do {
                        let previousOrigin = lifetimeOrigin
                        lifetimeOrigin = "fixture-unregister"
                        defer { lifetimeOrigin = previousOrigin }
                        observeLifetime("fixture-unregister")
                        router.unregisterPresentation(presentationID)
                    }
                    appModel.setOperatorConnected(false)
                    appModel.activeGatewayConnectConfig = nil
                    appModel.voiceWake.stop()
                }
                let fixtureConfig = GatewayConnectConfig(
                    url: fixture.url(), stableID: session.owner.gatewayID, tls: nil,
                    token: nil, bootstrapToken: nil, password: nil, nodeOptions: options)
                if !connectsDuringRestore {
                    try await gateway.connect(
                        url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: nil,
                        onConnected: {}, onDisconnected: { _ in },
                        onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                    appModel.activeGatewayConnectConfig = fixtureConfig
                }
                appModel.connectedGatewayID = session.owner.gatewayID
                appModel.setOperatorConnected(!connectsDuringRestore)
                appModel.focusChatSession(testsReadiness ? nil : session.sessionKey)
                let cachedRouting = try #require(OpenClawChatSessionRoutingIdentity(
                    scope: "per-sender", mainSessionKey: "restored-main", defaultAgentID: "main"))
                if testsReadiness {
                    let databases = try OpenClawClientDatabases(
                        directoryURL: #require(NodeAppModel.chatDatabaseDirectoryURL()))
                    let store = databases.store(gatewayID: session.owner.gatewayID)
                    await store.storeSessionRoutingIdentity(cachedRouting)
                    await store.retire()
                }
                window = try Self.hostNativeChat(
                    NativeChatHost(presentation: presentation, presentationID: isUnbound ? nil : presentationID)
                        .environment(appModel)
                        .environment(gatewayController)
                        .environment(router),
                    previousKeyWindow: &previousKeyWindow)
                if !testsReadiness {
                    let restoreDeadline = ContinuousClock.now + .seconds(2)
                    while releaseRestore == nil, ContinuousClock.now < restoreDeadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    let release = try #require(releaseRestore)

                    if !isOrdinary {
                        phase = "opening"
                        let opening: OpenClawNativeOpenRequest = (action == "reopen" || action == "profile-reopen")
                            ? .compose(session, draft: "retained idle text") : .session(session)
                        observeLifetime("initial-open-start")
                        let opened = await router.open(opening)
                        switch opened {
                        case .opened: observeLifetime("initial-open-opened")
                        case .cancelled: observeLifetime("initial-open-cancelled")
                        case .unavailable: observeLifetime("initial-open-unavailable")
                        }
                        #expect(opened == .opened, "\(lifetimeSummary())")
                        #expect(presentation.binding?.session == session)
                    } else {
                        #expect(presentation.binding == nil)
                    }
                    releaseRestore = nil
                    release.resume()
                    let releaseDeadline = ContinuousClock.now + .seconds(2)
                    while !restoreReturned, ContinuousClock.now < releaseDeadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    try #require(restoreReturned)
                }
                phase = "presented"
                try #require(createdProfiles.isEmpty)
                #expect(testsReadiness || restoreReturned)
                if testsReadiness {
                    let owner = appModel.chatPresentation
                    let current: @MainActor () -> IOSChatViewModelOwner.Presentation = {
                        .init(binding: presentation.binding, router: router, id: presentationID)
                    }
                    @MainActor func queueNewChat() throws -> Int {
                        do {
                            let previousOrigin = lifetimeOrigin
                            lifetimeOrigin = "fixture-user-navigation"
                            defer { lifetimeOrigin = previousOrigin }
                            observeLifetime("fixture-user-navigation")
                            try #require(
                                router.userNavigationDidChange(presentationID: presentationID),
                                "\(lifetimeSummary())")
                        }
                        owner.requestNewChat(appModel: appModel, presentation: current())
                        return appModel.newChatRequestID
                    }
                    if action == "ordinary-selection-readiness" {
                        let initialDeadline = ContinuousClock.now + .seconds(2)
                        while !restoreWaiters.contains(where: { $0.requestID == 0 }),
                              ContinuousClock.now < initialDeadline
                        {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(restoreWaiters.contains { $0.requestID == 0 })
                        let initialRestores = restoreWaiters.filter { $0.requestID == 0 }.count
                        let initialSynchronizations = Set(presentation.startedSynchronizations.keys)
                        let initialScope = owner.taskIdentity(
                            appModel: appModel, nativeBinding: presentation.binding, presentationID: presentationID)
                        let authority = try #require(router.capturePresentationAuthority(presentationID))
                        try #require(router.userNavigationDidChange(presentationID: presentationID))
                        #expect(!router.isCurrentPresentation(authority))
                        #expect(owner.taskIdentity(
                            appModel: appModel, nativeBinding: presentation.binding,
                            presentationID: presentationID) == initialScope)
                        // No restore or New Chat counter changes before the real .task wakes.
                        let successorDeadline = ContinuousClock.now + .seconds(2)
                        while restoreWaiters.filter({ $0.requestID == 0 }).count == initialRestores,
                              ContinuousClock.now < successorDeadline
                        {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(restoreWaiters.filter { $0.requestID == 0 }.count > initialRestores)
                        #expect(!Set(presentation.startedSynchronizations.keys)
                            .subtracting(initialSynchronizations).isEmpty)
                        #expect(appModel.newChatRequestID == 0)
                        #expect(owner.viewModel == nil)
                    }
                    let first = try queueNewChat()
                    let waitingDeadline = ContinuousClock.now + .seconds(2)
                    while !restoreWaiters.contains(where: { $0.requestID == first }),
                          ContinuousClock.now < waitingDeadline
                    {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    try #require(restoreWaiters.contains { $0.requestID == first })
                    try #require(createdKeys.isEmpty)
                    var latest = first
                    var explicitParentBeforeRestore: String?
                    if connectsDuringRestore {
                        #expect(appModel.activeGatewayConnectConfig == nil)
                        try await gateway.connect(
                            url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: nil,
                            onConnected: {}, onDisconnected: { _ in },
                            onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                        appModel.activeGatewayConnectConfig = fixtureConfig
                        appModel.setOperatorConnected(true)
                    }
                    if action == "ordinary-pending-user-aba" {
                        let original = appModel.chatSessionKey
                        explicitParentBeforeRestore = original
                        appModel.focusChatSession("agent:main:other")
                        appModel.focusChatSession(original)
                    } else if action == "ordinary-pending-account-aba" {
                        appModel.activeGatewayConnectConfig = GatewayConnectConfig(
                            url: fixture.url(), stableID: session.owner.gatewayID, tls: nil,
                            token: "replacement-fixture-account", bootstrapToken: nil, password: nil,
                            nodeOptions: options)
                        appModel.activeGatewayConnectConfig = fixtureConfig
                    }
                    if action.contains("-pending-") {
                        releaseRestores()
                        let rejectedDeadline = ContinuousClock.now + .seconds(2)
                        while presentation.synchronizedRequestID != first,
                              ContinuousClock.now < rejectedDeadline
                        {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(presentation.synchronizedRequestID == first)
                        #expect(owner.currentNewChatRequest(appModel: appModel, presentation: current()) == nil)
                        try #require(createdKeys.isEmpty)
                        latest = try queueNewChat()
                    } else if action == "ordinary-stale-sync" {
                        latest = try queueNewChat()
                        let replacementDeadline = ContinuousClock.now + .seconds(2)
                        while !restoreWaiters.contains(where: { $0.requestID == latest }),
                              ContinuousClock.now < replacementDeadline
                        {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(restoreWaiters.contains { $0.requestID == latest })
                        releaseRestores(for: latest)
                    } else {
                        releaseRestores()
                    }
                    let createDeadline = ContinuousClock.now + .seconds(2)
                    while createWaiters.isEmpty, ContinuousClock.now < createDeadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    try #require(!createWaiters.isEmpty)
                    let request = try #require(
                        owner.currentNewChatRequest(appModel: appModel, presentation: current()),
                        "\(lifetimeSummary())")
                    #expect(request.id == latest)
                    let invocations = presentation.startedNewChats.filter { $0.value.requestID == latest }
                    try #require(invocations.count == 1)
                    let invocationID = try #require(invocations.keys.first)
                    #expect(invocations[invocationID]?.taskID == ObjectIdentifier(request))
                    #expect(!appModel.consumeNewChatRequest(latest))
                    if action == "ordinary-stale-sync" {
                        let obsolete = Set(presentation.startedSynchronizations
                            .filter { $0.value != latest }.map(\.key))
                        releaseRestores()
                        let oldDeadline = ContinuousClock.now + .seconds(2)
                        while !obsolete.isSubset(of: presentation.completedSynchronizations),
                              ContinuousClock.now < oldDeadline
                        {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(obsolete.isSubset(of: presentation.completedSynchronizations))
                        #expect(owner.currentNewChatRequest(appModel: appModel, presentation: current()) === request)
                    }
                    #expect(appModel.chatSessionRoutingContract == cachedRouting.contract)
                    #expect(appModel.chatDeliveryAgentId == "main")
                    let restoredTarget = try #require(owner.transport).sessionTarget(for: cachedRouting.mainSessionKey)
                    #expect(restoredTarget.sessionKey == "agent:main:restored-main")
                    #expect(restoredTarget.agentID == nil)
                    // Cached routing does not erase the explicit focus restored by user ABA.
                    let expectedParent = try #require(owner.transport).sessionTarget(
                        for: explicitParentBeforeRestore ?? cachedRouting.mainSessionKey)
                    #expect(createdAgentIDs == [expectedParent.agentID])
                    #expect(createdParentKeys == [expectedParent.sessionKey])
                    let creating = try #require(owner.viewModel)
                    #expect(creating.isCreatingSession)
                    releaseCreates()
                    let completionDeadline = ContinuousClock.now + .seconds(2)
                    while presentation.completedNewChats[invocationID] == nil,
                          ContinuousClock.now < completionDeadline
                    {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    let adopted = try #require(presentation.completedNewChats[invocationID])
                    #expect(adopted)
                    #expect(!creating.isCreatingSession)
                    #expect(createdKeys.count == 1)
                    #expect(createdProfiles == [nil])
                    #expect(presentation.startedNewChats.values.filter { $0.requestID == latest }.count == 1)
                    #expect(appModel.chatSessionKey == createdKeys.first)
                    #expect(creating.errorText == nil)
                    #expect(sentParams.isEmpty)
                } else if renewsDuringCreate {
                    let chat = try #require(appModel.chatPresentation.viewModel)
                    let owner = appModel.chatPresentation
                    let originalTarget = chat.currentSessionTarget
                    chat.input = "retained new-chat draft"
                    let registrationDeadline = ContinuousClock.now + .seconds(2)
                    while router.chatRegistrationID == nil, ContinuousClock.now < registrationDeadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    try #require(router.chatRegistrationID != nil)
                    do {
                        let previousOrigin = lifetimeOrigin
                        lifetimeOrigin = "fixture-user-navigation"
                        defer { lifetimeOrigin = previousOrigin }
                        observeLifetime("fixture-user-navigation")
                        try #require(
                            router.userNavigationDidChange(presentationID: presentationID),
                            "\(lifetimeSummary())")
                    }
                    owner.requestNewChat(
                        appModel: appModel,
                        presentation: .init(binding: presentation.binding, router: router, id: presentationID))
                    let requestID = appModel.newChatRequestID
                    let createDeadline = ContinuousClock.now + .seconds(2)
                    while createWaiters.isEmpty, ContinuousClock.now < createDeadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    try #require(!createWaiters.isEmpty)
                    let current: @MainActor () -> IOSChatViewModelOwner.Presentation = {
                        .init(binding: presentation.binding, router: router, id: presentationID)
                    }
                    let request = try #require(
                        owner.currentNewChatRequest(appModel: appModel, presentation: current()),
                        "\(lifetimeSummary())")
                    #expect(request.id == requestID)
                    let invocations = presentation.startedNewChats.filter { $0.value.requestID == requestID }
                    try #require(invocations.count == 1)
                    let invocationID = try #require(invocations.keys.first)
                    #expect(invocations[invocationID]?.taskID == ObjectIdentifier(request))
                    #expect(!appModel.consumeNewChatRequest(requestID))
                    #expect(chat.isCreatingSession)
                    #expect(owner.viewModel === chat)
                    #expect((owner.transport?.nativeBinding == nil) == isOrdinary)
                    let previousRegistration = router.chatRegistrationID
                    let registration = try #require(router.registerChat(
                        chat, ownerID: owner.ownerID, agentID: owner.transportAgentID,
                        transport: owner.transport, presentationID: presentationID))
                    #expect(registration != previousRegistration)
                    let renewedDeadline = ContinuousClock.now + .seconds(2)
                    while presentation.synchronizedRegistrationID != registration,
                          ContinuousClock.now < renewedDeadline
                    {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    try #require(presentation.synchronizedRegistrationID == registration)
                    #expect(owner.currentNewChatRequest(appModel: appModel, presentation: current()) === request)
                    #expect(presentation.completedNewChats[invocationID] == nil)
                    if action.hasSuffix("-departure") {
                        do {
                            let previousOrigin = lifetimeOrigin
                            lifetimeOrigin = "fixture-unregister"
                            defer { lifetimeOrigin = previousOrigin }
                            observeLifetime("fixture-unregister")
                            router.unregisterPresentation(presentationID)
                        }
                        releaseWindow()
                        // Join actual task cancellation before releasing the server reply.
                        // Ordinary chat deliberately has no synchronous native-authority fence.
                        let departureDeadline = ContinuousClock.now + .seconds(2)
                        while presentation.completedNewChats[invocationID] == nil,
                              ContinuousClock.now < departureDeadline
                        {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        let departed = try #require(presentation.completedNewChats[invocationID])
                        #expect(!departed)
                    }
                    releaseCreates()
                    let completionDeadline = ContinuousClock.now + .seconds(2)
                    while presentation.completedNewChats[invocationID] == nil,
                          ContinuousClock.now < completionDeadline
                    {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    let adopted = try #require(presentation.completedNewChats[invocationID])
                    #expect(adopted == !action.hasSuffix("-departure"))
                    #expect(!chat.isCreatingSession)
                    #expect(createdKeys.count == 1)
                    #expect(createdProfiles == [expectedProfile])
                    #expect(presentation.startedNewChats.values.filter { $0.requestID == requestID }.count == 1)
                    #expect(sentParams.isEmpty)
                    if adopted {
                        #expect(appModel.chatSessionKey == createdKeys[0])
                        #expect(chat.errorText == nil)
                    } else {
                        #expect(chat.currentSessionTarget == originalTarget)
                        #expect(appModel.chatSessionKey == originalTarget.sessionKey)
                    }
                } else if sidebarReturn {
                    let chat = try #require(appModel.chatPresentation.viewModel)
                    let binding = try #require(presentation.binding)
                    let oldRegistration = try #require(router.chatRegistrationID)
                    let originalTarget = chat.currentSessionTarget
                    chat.input = "retained sidebar draft"
                    if action == "sidebar-attachment" {
                        chat.attachments = [.init(
                            url: nil, data: Data([1]), fileName: "draft.png", mimeType: "image/png", preview: nil)]
                    }
                    let attachmentIDs = chat.attachments.map(\.id)
                    let oldAuthority = chat.captureSessionTransitionAuthority()
                    #expect(oldAuthority())
                    _ = try await Self.composer(in: #require(window), expectedText: chat.input)
                    let ordinarySyncs = presentation.ordinarySynchronizations
                    presentation.isVisible = false
                    let hiddenDeadline = ContinuousClock.now + .seconds(2)
                    while presentation.binding != nil || router.chatRegistrationID != nil ||
                        presentation.ordinarySynchronizations == ordinarySyncs, ContinuousClock.now < hiddenDeadline
                    {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    try #require(presentation.binding == nil && router.chatRegistrationID == nil)
                    try #require(presentation.ordinarySynchronizations > ordinarySyncs)
                    #expect(!oldAuthority())
                    #expect(appModel.chatPresentation.viewModel === chat)
                    #expect(appModel.chatPresentation.transport?.nativeBinding === binding)
                    #expect(chat.currentSessionTarget == originalTarget)
                    #expect(chat.input == "retained sidebar draft")
                    #expect(chat.attachments.map(\.id) == attachmentIDs)
                    if action.hasPrefix("sidebar-queued") {
                        appModel.chatPresentation.requestNewChat(
                            appModel: appModel,
                            presentation: .init(
                                binding: presentation.binding, router: router,
                                id: isUnbound ? nil : presentationID))
                        let queued = appModel.newChatRequestID
                        let queueDeadline = ContinuousClock.now + .seconds(2)
                        while presentation.synchronizedRequestID != queued, ContinuousClock.now < queueDeadline {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(presentation.synchronizedRequestID == queued)
                        #expect(createdKeys.isEmpty)
                    }
                    if action == "sidebar-queued-retired" {
                        do {
                            let previousOrigin = lifetimeOrigin
                            lifetimeOrigin = "fixture-user-navigation"
                            defer { lifetimeOrigin = previousOrigin }
                            observeLifetime("fixture-user-navigation")
                            try #require(
                                router.userNavigationDidChange(presentationID: presentationID),
                                "\(lifetimeSummary())")
                        }
                    }
                    presentation.isVisible = true
                    if !action.hasPrefix("sidebar-queued") {
                        let visibleDeadline = ContinuousClock.now + .seconds(2)
                        while router.chatRegistrationID == nil, ContinuousClock.now < visibleDeadline {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(router.chatRegistrationID != nil && router.chatRegistrationID != oldRegistration)
                        #expect(presentation.binding == nil)
                        #expect(appModel.chatPresentation.viewModel === chat)
                        #expect(appModel.chatPresentation.transport?.nativeBinding === binding)
                        #expect(chat.input == "retained sidebar draft")
                        #expect(chat.attachments.map(\.id) == attachmentIDs)
                        #expect(chat.captureSessionTransitionAuthority()())
                        #expect(!oldAuthority())
                        for id in attachmentIDs {
                            chat.removeAttachment(id)
                        }
                        appModel.chatPresentation.requestNewChat(
                            appModel: appModel,
                            presentation: .init(
                                binding: presentation.binding, router: router,
                                id: isUnbound ? nil : presentationID))
                    } else if action == "sidebar-queued-retired" {
                        let registrationDeadline = ContinuousClock.now + .seconds(2)
                        while router.chatRegistrationID == nil ||
                            presentation.synchronizedRegistrationID != router.chatRegistrationID,
                            ContinuousClock.now < registrationDeadline
                        {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(router.chatRegistrationID != nil)
                        try #require(presentation.synchronizedRegistrationID == router.chatRegistrationID)
                        try #require(createdKeys.isEmpty)
                        #expect(appModel.chatPresentation.currentNewChatRequest(
                            appModel: appModel,
                            presentation: .init(binding: nil, router: router, id: presentationID)) == nil)
                        do {
                            let previousOrigin = lifetimeOrigin
                            lifetimeOrigin = "fixture-user-navigation"
                            defer { lifetimeOrigin = previousOrigin }
                            observeLifetime("fixture-user-navigation")
                            try #require(
                                router.userNavigationDidChange(presentationID: presentationID),
                                "\(lifetimeSummary())")
                        }
                        appModel.chatPresentation.requestNewChat(
                            appModel: appModel,
                            presentation: .init(binding: nil, router: router, id: presentationID))
                    }
                    let createDeadline = ContinuousClock.now + .seconds(2)
                    while createdKeys.isEmpty || chat.isCreatingSession, ContinuousClock.now < createDeadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    #expect(createdKeys.count == 1)
                    #expect(createdProfiles == [expectedProfile])
                    #expect(appModel.chatSessionKey == createdKeys.first)
                    #expect(appModel.chatPresentation.viewModel === chat)
                    let adoptedBinding = try #require(presentation.binding)
                    #expect(adoptedBinding.session.sessionKey == createdKeys.first)
                    #expect(appModel.chatPresentation.transport?.nativeBinding?.canReuse(adoptedBinding) == true)
                    #expect(chat.captureSessionTransitionAuthority()())
                    #expect(!oldAuthority())
                    #expect(sentParams.isEmpty)
                } else if action == "new-chat" || isUnbound || retiresDuringCreate {
                    let prepared: OpenClawNativePreparedSend? = if retiresDuringCreate {
                        try await router.prepareSend(to: session, message: "retired confirmation").send
                    } else {
                        nil
                    }
                    let creatingModel = try #require(appModel.chatPresentation.viewModel)
                    diagnosticCreatingModel = creatingModel
                    let creatingTarget = creatingModel.currentSessionTarget
                    let creatingHistoryRequestID = creatingModel.lastIssuedHistoryRequestID
                    if retiresDuringCreate {
                        beforeCreateResponse = {
                            creatingAtResponse = creatingModel.isCreatingSession
                            phase = "retiring"
                            // Retire while sessions.create is in flight, before the fixture sends its reply.
                            do {
                                let previousOrigin = lifetimeOrigin
                                lifetimeOrigin = "fixture-unregister"
                                defer { lifetimeOrigin = previousOrigin }
                                observeLifetime("fixture-unregister")
                                router.unregisterPresentation(presentationID)
                            }
                            releaseWindow()
                            phase = "retired"
                        }
                    }
                    // A's suspended restore cannot consume the native command.
                    phase = "creating"
                    appModel.chatPresentation.requestNewChat(
                        appModel: appModel,
                        presentation: .init(
                            binding: presentation.binding, router: router,
                            id: isUnbound ? nil : presentationID))
                    let commandDeadline = ContinuousClock.now + .seconds(2)
                    while ContinuousClock.now < commandDeadline {
                        if retiresDuringCreate {
                            if !createdKeys.isEmpty, !creatingModel.isCreatingSession { break }
                        } else if appModel.chatSessionKey != session.sessionKey {
                            break
                        }
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    let hasPreparedRequest = appModel.chatPresentation.currentNewChatRequest(
                        appModel: appModel,
                        presentation: .init(
                            binding: presentation.binding, router: router,
                            id: isUnbound ? nil : presentationID)) != nil
                    let createdKey = try #require(
                        createdKeys.first,
                        Comment(
                            rawValue: "new-chat prepared=\(hasPreparedRequest) " +
                                "syncStarted=\(presentation.startedSynchronizations.count) " +
                                "syncCompleted=\(presentation.completedSynchronizations.count) " +
                                "createStarted=\(presentation.startedNewChats.count) " +
                                "createCompleted=\(presentation.completedNewChats.count) " +
                                "createSucceeded=\(presentation.completedNewChats.values.filter(\.self).count)"))
                    #expect(createdProfiles == [expectedProfile])
                    if let prepared {
                        // The original owner's defer settles even when retirement suppresses
                        // bootstrap. A history request does not define create completion.
                        try #require(!creatingModel.isCreatingSession)
                        #expect(creatingModel.currentSessionTarget == creatingTarget)
                        #expect(creatingModel.lastIssuedHistoryRequestID == creatingHistoryRequestID)
                        #expect(appModel.chatSessionKey == session.sessionKey)
                        await #expect(throws: Error.self) { try await prepared.submit() }
                        #expect(sentParams.isEmpty)
                    } else {
                        #expect(appModel.chatSessionKey == createdKey)
                    }
                } else if isDictation {
                    let reserved = action == "dictation-reserved"
                    let originalBinding = try #require(presentation.binding)
                    var releaseDictation: CheckedContinuation<Void, Never>?
                    let suspendDictation: @MainActor () async -> Void = {
                        await withCheckedContinuation { releaseDictation = $0 }
                    }
                    if reserved {
                        appModel.talkMode._test_setPTTReservedHandler(suspendDictation)
                    } else {
                        appModel.testTalkCapturePreparationHandler = suspendDictation
                    }
                    defer {
                        appModel.testTalkCapturePreparationHandler = nil
                        appModel.talkMode._test_setPTTReservedHandler(nil)
                    }
                    let transcription = Task { @MainActor in try await appModel.transcribeChatDraft() }
                    let verification: Result<Void, Error>
                    do {
                        let deadline = ContinuousClock.now + .seconds(2)
                        while releaseDictation == nil, ContinuousClock.now < deadline {
                            try await Task.sleep(for: .milliseconds(10))
                        }
                        try #require(releaseDictation != nil)
                        try #require(appModel.isChatDictationPending == !reserved)
                        try #require(appModel.isChatDictationActive == reserved)
                        let captureID = appModel.talkMode._test_activePushToTalkCaptureId()
                        #expect((captureID != nil) == reserved)
                        #expect(!appModel.talkMode._test_audioSessionIsActive())

                        #expect(await router.open(.compose(session, draft: nil)) == .opened)
                        let outcome = await router.open(.compose(session, draft: "must not join dictation"))
                        if case let .unavailable(reason) = outcome {
                            #expect(!reason.isEmpty)
                        } else {
                            Issue.record("Compose must reject a draft while dictation owns the composer")
                        }
                        #expect(presentation.binding?.canReuse(originalBinding) == true)
                        #expect(appModel.isChatDictationPending == !reserved)
                        #expect(appModel.isChatDictationActive == reserved)
                        #expect(appModel.talkMode._test_activePushToTalkCaptureId() == captureID)
                        #expect(!appModel.talkMode._test_audioSessionIsActive())
                        verification = .success(())
                    } catch {
                        verification = .failure(error)
                    }
                    // Both barriers precede permission/audio work. Cancel the owner
                    // before releasing either barrier, including on assertion failure.
                    transcription.cancel()
                    appModel.cancelChatDictation()
                    releaseDictation?.resume()
                    releaseDictation = nil
                    await #expect(throws: Error.self) { try await transcription.value }
                    try verification.get()
                    #expect(!appModel.isChatDictationPending)
                    #expect(!appModel.isChatDictationActive)
                    #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
                    #expect(await router.open(.compose(session, draft: "after dictation")) == .opened)
                    #expect(sentParams.isEmpty)
                    #expect(createdProfiles.isEmpty)
                } else {
                    if action == "reopen" || action == "profile-reopen" {
                        let oldBinding = try #require(presentation.binding)
                        let oldConfirmation = try await router.prepareSend(to: session, message: "old confirmation")
                            .send
                        if action == "profile-reopen" {
                            let reused = try #require(presentation.binding)
                            #expect(reused !== oldBinding && oldBinding.canReuse(reused))
                            let input = try await Self.composer(
                                in: #require(window),
                                expectedText: "retained idle text")
                            phase = "retiring"
                            #expect(await oldBinding.accepts(EventFrame(
                                type: "event", event: "presence", payload: nil, recipientprofileid: "other-profile")) ==
                                false)
                            #expect(await reused.isCurrent() == false)
                            phase = "retired"
                            let countBeforeSync = rpcCount
                            #expect(input.text == "retained idle text")
                            let coordinator = try #require(input.delegate as? ChatComposerTextViewIOS.Coordinator)
                            // Change the actual editor binding. Its protected-composer observer
                            // must not turn a pre-retirement presentation into a fresh connection.
                            coordinator.parent.text = ""
                            let syncDeadline = ContinuousClock.now + .seconds(2)
                            while input.text != "", ContinuousClock.now < syncDeadline {
                                try await Task.sleep(for: .milliseconds(10))
                            }
                            try #require(input.text == "")
                            #expect(presentation.binding === reused, "\(lifetimeSummary())")
                            #expect(await reused.isCurrent() == false)
                            #expect(rpcCount == countBeforeSync)
                        } else {
                            await gateway.disconnect()
                            try await gateway.connect(
                                url: fixture.url(), credentials: .init(), connectOptions: options, sessionBox: nil,
                                onConnected: {}, onDisconnected: { _ in },
                                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                        }
                        let reopening: OpenClawNativeOpenRequest = action == "profile-reopen"
                            ? .compose(session, draft: "retained idle text") : .session(session)
                        phase = "reopening"
                        observeLifetime("reopen-start")
                        let reopened = await router.open(reopening)
                        switch reopened {
                        case .opened: observeLifetime("reopen-opened")
                        case .cancelled: observeLifetime("reopen-cancelled")
                        case .unavailable: observeLifetime("reopen-unavailable")
                        }
                        #expect(reopened == .opened, "\(lifetimeSummary())")
                        #expect(presentation.binding !== oldBinding)
                        #expect((presentation.binding?.route == oldBinding.route) == (action == "profile-reopen"))
                        #expect(await oldBinding.isCurrent() == false)
                        let overwrite = await router.open(.compose(session, draft: "must not replace idle text"))
                        if case let .unavailable(reason) = overwrite {
                            #expect(reason.contains("current draft"))
                        } else {
                            Issue.record("Explicit reopen must preserve the original idle text")
                        }
                        await #expect(throws: Error.self) { try await oldConfirmation.submit() }
                        #expect(sentParams.isEmpty)
                    }
                    let prepared = try await router.prepareSend(to: session, message: "native submission").send
                    let run = try await prepared.submit()
                    #expect(run.session == session)
                    #expect(run.runID == "native-run")
                    #expect(routingReads > 0)
                    let contract = try #require(presentation.binding?.sessionRoutingContract)
                    #expect(sentParams.count == 1)
                    #expect(sentParams.first?["expectedSessionRoutingContract"] as? String == contract)
                    #expect(sentParams.first?["expectedPermissionMode"] as? String == "guarded")
                    #expect(sentParams.first?["expectedToolOverrides"] as? [String: Bool] == [:])
                }
                outcome = .success(())
            } catch {
                outcome = .failure(error)
            }
            // Close transport and join reply writers even if the body or a terminal wait throws.
            router.testLifetimeObservation = originalLifetimeObservation
            await gateway.disconnect()
            await fixture.stopAndWait()
            let completion: Result<Void, Error>
            do {
                let taskDeadline = ContinuousClock.now + .seconds(2)
                while !Set(presentation.startedNewChats.keys).isSubset(of: Set(presentation.completedNewChats.keys)),
                      ContinuousClock.now < taskDeadline
                {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(Set(presentation.startedNewChats.keys)
                    .isSubset(of: Set(presentation.completedNewChats.keys)))
                let syncDeadline = ContinuousClock.now + .seconds(2)
                while !Set(presentation.startedSynchronizations.keys)
                    .isSubset(of: presentation.completedSynchronizations),
                    ContinuousClock.now < syncDeadline
                {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(Set(presentation.startedSynchronizations.keys)
                    .isSubset(of: presentation.completedSynchronizations))
                await appModel.purgeChatTranscriptCache(gatewayID: session.owner.gatewayID)
                completion = .success(())
            } catch {
                // Unknown task lifetime retains its cache; report this even if the body also failed.
                Issue.record("Hosted chat tasks did not finish; retaining fixture cache")
                completion = .failure(error)
            }
            // NW callbacks have no originating Swift Testing task. Assert after
            // admission closes and all retained reply writers join, even on body failure.
            #expect(
                callbackViolationCount == 0,
                "count=\(callbackViolationCount) overflow=\(callbackViolationCount > 16) \(callbackViolations.joined(separator: " | "))")
            if let creatingAtResponse { #expect(creatingAtResponse) }
            if case .failure = outcome { print(lifetimeSummary()) }
            if case .failure = completion { print(lifetimeSummary()) }
            try outcome.get()
            try completion.get()
        }
        if action == "retired-new-chat" {
            // Hosting, registration, restore, and prepared-send references have left scope.
            let deadline = ContinuousClock.now + .seconds(2)
            while routerLifetime != nil, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(routerLifetime == nil)
        }
    }

    @Test @MainActor func `streaming assistant bubble builds mixed prose and code`() {
        let text = """
        Earlier prose stays visible.

        ```swift
        let answer = 42
        ```

        Trailing streamed words fade in.
        """

        let root = ChatStreamingAssistantBubble(
            text: text,
            markdownVariant: .standard,
            showsReasoning: false,
            assistantName: "OpenClaw",
            assistantAvatarText: "OC",
            assistantAvatarTint: nil,
            showsAssistantAvatar: true,
            isClean: false)

        _ = Self.host(root, size: CGSize(width: 393, height: 400))
    }

    @Test @MainActor func `assistant usage footer builds across dynamic type sizes`() throws {
        let usage = try JSONDecoder().decode(
            OpenClawChatUsage.self,
            from: Data(#"{"input":12000,"output":300,"cacheRead":438400,"cacheWrite":307000,"cost":{"total":0.0123}}"#
                .utf8))
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: "A completed assistant response with per-run usage.",
                thinking: nil,
                thinkingSignature: nil,
                mimeType: nil,
                fileName: nil,
                content: nil,
                id: nil,
                name: nil,
                arguments: nil)],
            timestamp: nil,
            usage: usage)

        for typeSize in [DynamicTypeSize.large, .accessibility2] {
            let root = ChatMessageBubble(
                message: message,
                style: .standard,
                markdownVariant: .standard,
                userAccent: nil,
                displayOptions: [],
                assistantName: "OpenClaw",
                assistantAvatarText: "OC",
                assistantAvatarTint: nil,
                showsAssistantAvatar: true,
                isClean: false,
                contextWindowTokens: 1_000_000,
                userMessageExpanded: false,
                onToggleUserMessageExpanded: {},
                inlineWidgetResolverReady: true,
                inlineWidgetResourceResolver: { _, _ in nil },
                mediaArtifactResolverReady: false,
                mediaPlaybackAllowed: { true },
                loadMediaArtifact: { _, _, _ in nil })
                .environment(\.dynamicTypeSize, typeSize)

            _ = Self.host(root, size: CGSize(width: 320, height: 280))
        }
    }

    @Test @MainActor func `gateway trust prompt alert presents when prompt appears after initial render`() async {
        let appModel = NodeAppModel()
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .environment(gatewayController)

        let window = Self.host(root)
        await Self.triggerGatewayTrustPrompt(controller: gatewayController)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @Test @MainActor func `exec approval dialog builds on compact screens with accessibility text`() throws {
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        let layouts: [(CGSize, DynamicTypeSize)] = [
            (CGSize(width: 320, height: 568), .accessibility5),
            (CGSize(width: 568, height: 320), .accessibility3),
        ]
        for (size, typeSize) in layouts {
            let appModel = NodeAppModel()
            let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-layout",
                commandText: String(repeating: "/usr/bin/find /private/var/mobile/Documents ", count: 12),
                warningText: String(
                    repeating: "This command can modify files outside the current workspace. ",
                    count: 12),
                allowedDecisions: ["allow-once", "allow-always", "deny"],
                host: "gateway.example.com",
                nodeId: "node-mobile",
                agentId: "main",
                expiresAtMs: Int64.max))
            appModel._test_presentExecApprovalPrompt(prompt)

            let root = Color.clear
                .execApprovalPromptDialog()
                .environment(appModel)
                .environment(\.dynamicTypeSize, typeSize)
            windows.append(Self.host(root, size: size))
        }
    }

    @Test @MainActor func `root prompt alert stack presents gateway trust prompt`() async {
        let appModel = NodeAppModel()
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .environment(appModel)
            .environment(gatewayController)

        let window = Self.host(root)
        await Self.triggerGatewayTrustPrompt(controller: gatewayController)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @Test @MainActor func `root prompt alert stack still presents deep link prompt`() async throws {
        let appModel = NodeAppModel()
        appModel.gatewayConnected = true
        let gatewayController = Self.gatewayControllerWithCapturedTLSFingerprint(appModel: appModel)
        let root = Color.clear
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .environment(appModel)
            .environment(gatewayController)

        let window = Self.host(root)
        let url = try #require(URL(string: "openclaw://agent?message=hello%20from%20deep%20link"))
        await appModel.handleDeepLink(url: url)
        await Self.waitForPresentedAlert(in: window)

        #expect(window.rootViewController?.presentedViewController is UIAlertController)
    }

    @MainActor private static func gatewayControllerWithCapturedTLSFingerprint(
        appModel: NodeAppModel)
        -> GatewayConnectionController
    {
        GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("abc123") })
    }

    @MainActor private static func triggerGatewayTrustPrompt(controller: GatewayConnectionController) async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.clearFingerprint(stableID: stableID)
        await controller.connectManual(host: host, port: port, useTLS: true)
    }

    @MainActor private static func waitForPresentedAlert(in window: UIWindow) async {
        for _ in 0..<10 {
            if window.rootViewController?.presentedViewController != nil { return }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}
