import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

enum ChatInfoRead<Value: Sendable>: Sendable {
    case loading, loaded(Value), failed

    /// A failed re-read (the page reappears after the gallery) keeps what is already on screen.
    func replaced(by next: Self) -> Self {
        if case .loaded = self, case .failed = next { return self }
        return next
    }
}

extension ChatInfoVisit {
    static let stripLimit = 10

    static func mediaQuery(for target: OpenClawChatSessionTarget) -> ArtifactsListParams {
        // Same catalog as Control UI Outputs; do not also scan for image previews or include uploads.
        ArtifactsListParams(sessionkey: target.sessionKey, agentid: target.agentID, messagerole: "assistant")
    }

    /// The catalog arrives in transcript order; the page shows the newest first.
    static func newestFirst(_ items: [ArtifactSummary]) -> [ArtifactSummary] {
        items.enumerated().sorted { lhs, rhs in
            let left = lhs.element.messageseq ?? -1
            let right = rhs.element.messageseq ?? -1
            return left != right ? left > right : lhs.offset > rhs.offset
        }.map(\.element)
    }

    @MainActor func loadMedia(in app: NodeAppModel) async -> ChatInfoRead<[ArtifactSummary]> {
        if app.isLocalChatFixtureEnabled {
            let read = await ScreenshotFixtureMode.infoRead("media") {
                ScreenshotFixtureMode.infoMedia(for: self.catalogTarget.sessionKey)
            }
            if case let .loaded(items) = read { return .loaded(Self.newestFirst(items)) }
            return read
        }
        guard let gatewayID = self.catalogGatewayID,
              let route = await app.operatorSession.currentRoute(ifGatewayID: gatewayID),
              let bytes = try? JSONEncoder().encode(Self.mediaQuery(for: self.catalogTarget)), let json = String(
                  bytes: bytes,
                  encoding: .utf8),
              let data = try? await app.operatorSession.request(
                  method: "artifacts.list",
                  paramsJSON: json,
                  ifCurrentRoute: route),
              let list = try? await GatewayPayloadDecoding.decode(ArtifactsListResult.self, from: data),
              list.nextcursor == nil, list.omittedoversized != true else { return .failed }
        return .loaded(Self.newestFirst(list.artifacts))
    }

    /// Everything that changes a tile's picture. Size guards transcript ids, which repeat by position after a reset.
    @MainActor func thumbnailKey(for item: ArtifactSummary, in app: NodeAppModel) -> String? {
        guard let gatewayID = app.isLocalChatFixtureEnabled ? ScreenshotFixtureMode.gatewayID : self.catalogGatewayID
        else { return nil }
        let target = self.catalogTarget
        return [
            gatewayID, target.agentID ?? "", target.sessionKey, item.id, String(item.sizebytes ?? -1),
            String(IOSMediaArtifactLoader.tilePreviewWidth),
        ].joined(separator: "\n")
    }

    @MainActor func readArtifact(_ item: ArtifactSummary, thumbnail: Bool, in app: NodeAppModel) async throws -> Data {
        let loader = IOSMediaArtifactLoader(connectionProvider: app.chatMediaConnection)
        if thumbnail, app.isLocalChatFixtureEnabled {
            return try await loader.tileThumbnail(
                from: ScreenshotFixtureMode.infoThumbnail(for: item),
                expectedGatewayID: ScreenshotFixtureMode.gatewayID)
        }
        guard let gatewayID = self.catalogGatewayID,
              let route = await app.operatorSession.currentRoute(ifGatewayID: gatewayID)
        else { throw URLError(.notConnectedToInternet) }
        let target = self.catalogTarget
        let params = ArtifactsDownloadParams(
            sessionkey: target.sessionKey,
            agentid: target.agentID,
            messagerole: "assistant",
            artifactid: item.id,
            transport: thumbnail ? nil : "http",
            previewwidth: thumbnail ? IOSMediaArtifactLoader.tilePreviewWidth : nil)
        let bytes = try JSONEncoder().encode(params)
        guard let json = String(bytes: bytes, encoding: .utf8) else { throw URLError(.badURL) }
        let gateway = app.operatorSession
        let data = try await gateway.request(method: "artifacts.download", paramsJSON: json, ifCurrentRoute: route)
        let result = try await GatewayPayloadDecoding.decode(ArtifactsDownloadResult.self, from: data)
        guard result.artifact.id == item.id, await gateway.currentRoute() == route else { throw CancellationError() }
        let payload: Data
        if thumbnail {
            payload = try await loader.tileThumbnail(from: result, expectedGatewayID: gatewayID)
        } else {
            guard case let .data(media) = try await loader.load(
                response: result, kind: item.type == "image" ? .image : .file, expectedGatewayID: gatewayID)
            else { throw URLError(.cannotDecodeContentData) }
            payload = media.data
        }
        guard await gateway.currentRoute() == route else { throw CancellationError() }
        return payload
    }
}

struct ChatInfoMedia: View {
    let visit: ChatInfoVisit
    @Environment(NodeAppModel.self) private var app
    @State private var media: ChatInfoRead<[ArtifactSummary]> = .loading
    @State private var attempt = 0
    @State private var stripVisible = false
    @State private var requestedID: String?
    @State private var showsGallery = false

    private var items: [ArtifactSummary] {
        if case let .loaded(items) = self.media { return items }
        return []
    }

    var body: some View {
        ChatInfoSection(title: "Media and files") {
            if !self.items.isEmpty {
                Button { self.showsGallery = true } label: {
                    HStack(spacing: 1) {
                        Text("See all").font(OpenClawType.footnoteMedium).foregroundStyle(OpenClawBrand.textStrong)
                        Image(systemName: "chevron.right").font(OpenClawType.caption2SemiBold)
                            .foregroundStyle(OpenClawBrand.textTertiary)
                    }.contentShape(.rect)
                }
                .buttonStyle(.plain).accessibilityLabel(Text("See all media and files"))
                .accessibilityIdentifier("chat-info-media-see-all")
            }
        } content: {
            self.card
        }
        .task(id: self.attempt) {
            let media = await self.visit.loadMedia(in: self.app)
            if !Task.isCancelled { self.media = self.media.replaced(by: media) }
        }
        .modifier(ChatInfoArtifactViewer(visit: self.visit, items: self.items, requestedID: self.$requestedID))
        .navigationDestination(isPresented: self.$showsGallery) {
            ChatInfoGallery(visit: self.visit, items: self.items)
        }
    }

    @ViewBuilder private var card: some View {
        switch self.media {
        case .loading:
            // Quiet tiles in the strip's box, so arriving items do not move the sections below.
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(0..<6, id: \.self) { _ in
                        OpenClawBrand.surfaceMuted.frame(width: 72, height: 72).clipShape(.rect(cornerRadius: 10))
                    }
                }.padding(12)
            }.scrollDisabled(true).scrollIndicators(.hidden).accessibilityHidden(true)
        case .failed: self.discovery(.failed)
        case let .loaded(items) where items.isEmpty: self.discovery(.empty)
        case let .loaded(items):
            ScrollView(.horizontal) {
                // Ten tiles at most; each tile still waits until it is on screen before fetching.
                HStack(spacing: 6) {
                    ForEach(items.prefix(ChatInfoVisit.stripLimit), id: \.id) { item in
                        ChatInfoMediaButton(
                            visit: self.visit,
                            item: item,
                            stripVisible: self.stripVisible,
                            isOpening: self.requestedID != nil,
                            open: { self.requestedID = item.id })
                            .frame(width: 72, height: 72).clipShape(.rect(cornerRadius: 10))
                    }
                    if items.count > ChatInfoVisit.stripLimit {
                        Button { self.showsGallery = true } label: {
                            VStack(spacing: 5) {
                                Image(systemName: "square.grid.2x2").font(OpenClawType.title3)
                                    .accessibilityHidden(true)
                                Text("See all").font(OpenClawType.footnoteMedium)
                            }
                            .foregroundStyle(OpenClawBrand.textStrong)
                            .frame(width: 72, height: 72)
                            .background(OpenClawBrand.selection, in: .rect(cornerRadius: 10))
                        }
                        .buttonStyle(.plain).accessibilityLabel(Text("See all media and files"))
                        .accessibilityIdentifier("chat-info-media-see-all-tile")
                    }
                }.padding(12)
            }.scrollIndicators(.hidden).accessibilityIdentifier("chat-info-media-strip")
                // The parent scrolls vertically; the tiles themselves observe the horizontal viewport.
                .onScrollVisibilityChange(threshold: 0.16) { self.stripVisible = $0 }
        }
    }

    private func discovery(_ state: ChatInfoDiscoveryRow.State) -> some View {
        ChatInfoDiscoveryRow(
            symbol: "doc",
            title: String(localized: "No files yet"),
            detail: self.visit.isProfile ? String(localized: "Files from the main chat show up here") :
                String(localized: "Ask for an image or a file and it shows up here"),
            failure: String(localized: "Couldn’t load media and files"),
            state: state)
        {
            self.media = .loading
            self.attempt += 1
        }
    }

    static func symbol(for item: ArtifactSummary) -> String {
        switch item.type {
        case "image": "photo"
        case "video": "film"
        case "audio": "waveform"
        default:
            if let mime = item.mimetype, let kind = UTType(mimeType: mime), kind.conforms(to: .sourceCode) {
                "chevron.left.forwardslash.chevron.right"
            } else {
                "doc"
            }
        }
    }
}

/// One tappable artifact; the strip and the gallery size it.
struct ChatInfoMediaButton: View {
    let visit: ChatInfoVisit
    let item: ArtifactSummary
    let stripVisible: Bool
    let isOpening: Bool
    let open: () -> Void
    @Environment(NodeAppModel.self) private var app

    var body: some View {
        let supported = self.item.download["mode"]?.value as? String != "unsupported"
        let key = self.visit.thumbnailKey(for: self.item, in: self.app)
        Button(action: self.open) {
            ChatInfoMediaTile(
                symbol: ChatInfoMedia.symbol(for: self.item),
                isImage: supported && self.item.type == "image",
                stripVisible: self.stripVisible,
                cached: key.flatMap(ChatInfoThumbnails.image(for:)))
            {
                let data = try await self.visit.readArtifact(self.item, thumbnail: true, in: self.app)
                guard let image = UIImage(data: data) else { throw URLError(.cannotDecodeContentData) }
                if let key { ChatInfoThumbnails.store(image, for: key) }
                return image
            }
        }.buttonStyle(.plain).accessibilityLabel(Text(verbatim: self.item.title))
            .accessibilityIdentifier("chat-info-media-" + self.item.id)
            .disabled(!supported || self.isOpening)
    }
}

/// Opens a requested artifact the same way from the strip and the gallery: images in Quick Look, files in Share.
struct ChatInfoArtifactViewer: ViewModifier {
    let visit: ChatInfoVisit
    let items: [ArtifactSummary]
    @Binding var requestedID: String?
    @Environment(NodeAppModel.self) private var app
    @State private var sharedFile: ChatDownloadedFile?
    @State private var imageFile: ChatDownloadedFile?
    @State private var previewURL: URL?

    func body(content: Content) -> some View {
        content
            .task(id: self.requestedID) {
                guard let id = self.requestedID, let item = self.items.first(where: { $0.id == id }) else { return }
                defer { if self.requestedID == id { self.requestedID = nil } }
                do {
                    let data = try await self.visit.readArtifact(item, thumbnail: false, in: self.app)
                    let file = try await Task.detached(priority: .userInitiated) {
                        try ChatDownloadedFile(data: data, fileName: item.title)
                    }.value
                    try Task.checkCancellation()
                    if item.type == "image" { self.imageFile = file
                        self.previewURL = file.url
                    } else { self.sharedFile = file }
                } catch {
                    guard !Task.isCancelled else { return }
                    self.app.toasts.post(.failure(String(localized: "Couldn’t open this file")))
                }
            }
            .quickLookPreview(self.$previewURL)
            .onChange(of: self.previewURL) { _, url in if url == nil { self.imageFile = nil } }
            .sheet(item: self.$sharedFile) { file in OpenClawChatFileShareSheet(
                fileURL: file.url,
                onCompletion: { _ = file }) }
    }
}

/// Tile thumbnails for the life of the app, so the gallery and a reopened page draw what a tile already fetched.
/// Memory only, like the transcript's images; keys come from `ChatInfoVisit.thumbnailKey`.
@MainActor
enum ChatInfoThumbnails {
    private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()

    static func image(for key: String) -> UIImage? {
        self.images.object(forKey: key as NSString)
    }

    static func store(_ image: UIImage, for key: String) {
        let pixels = image.size.width * image.scale * image.size.height * image.scale
        self.images.setObject(image, forKey: key as NSString, cost: Int(pixels) * 4)
    }
}

private struct ChatInfoMediaTile: View {
    let symbol: String
    let isImage: Bool
    let stripVisible: Bool
    let cached: UIImage?
    let load: () async throws -> UIImage
    @State private var visible = false
    @State private var image: UIImage?

    var body: some View {
        let shown = self.image ?? self.cached
        let canLoad = self.isImage && self.stripVisible && self.visible && shown == nil
        OpenClawBrand.surfaceMuted
            .overlay {
                if let image = shown {
                    Image(uiImage: image).resizable().scaledToFill().accessibilityHidden(true)
                } else {
                    Image(systemName: self.symbol).font(.title3).foregroundStyle(OpenClawBrand.textSecondary)
                }
            }
            .clipped()
            .contentShape(.rect)
            .onScrollVisibilityChange(threshold: 0.01) { self.visible = $0 }
            .task(id: canLoad) {
                // A failed read tries again while the tile stays on screen; showing it again starts over.
                guard canLoad else { return }
                for pause in [0, 1, 3, 9] {
                    try? await Task.sleep(for: .seconds(pause))
                    guard !Task.isCancelled else { return }
                    if let image = try? await self.load() {
                        if !Task.isCancelled { self.image = image }
                        return
                    }
                }
            }
    }
}
