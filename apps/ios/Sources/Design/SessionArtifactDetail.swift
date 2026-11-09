import OpenClawChatUI
import PDFKit
import SwiftUI
import UniformTypeIdentifiers

struct SessionArtifactDetail: View {
    let artifact: IOSSessionArtifact
    let load: @MainActor @Sendable () async throws -> OpenClawChatMediaData
    @State private var showsFullImage = false
    @State private var hasLoadedFile = false
    @State private var preview: Preview = .unavailable
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var retry = 0
    @State private var isSharing = false
    @State private var sharedFile: ChatDownloadedFile?
    @State private var shareTask: Task<Void, Never>?

    enum Preview {
        case text(String, truncated: Bool)
        case image(UIImage)
        case pdf(PDFDocument)
        case unavailable
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(self.artifact.title)
                    .font(OpenClawType.headline)
                    .textSelection(.enabled)
                if let size = self.artifact.sizeDescription {
                    Text(size).font(OpenClawType.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            Divider()
            self.previewContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("Preview")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { self.share() } label: {
                    Label {
                        Text("Share").font(OpenClawType.body)
                    } icon: {
                        if self.isSharing {
                            ProgressView()
                        } else {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                }
                .disabled(!self.hasLoadedFile || self.isLoading || self.isSharing)
                .accessibilityLabel("Share or save file")
                .accessibilityIdentifier("artifact-share")
            }
        }
        .task(id: self.retry) { await self.fetch() }
        .onDisappear { self.shareTask?.cancel() }
        .sheet(item: self.$sharedFile) { file in
            OpenClawChatFileShareSheet(fileURL: file.url, onCompletion: { _ = file })
        }
        .accessibilityIdentifier("artifact-detail")
    }

    @ViewBuilder
    private var previewContent: some View {
        if self.isLoading {
            VStack(spacing: 12) {
                ProgressView()
                Text("Loading preview…").font(OpenClawType.body)
            }
        } else if let error = self.errorMessage {
            VStack(spacing: 16) {
                Text(error).font(OpenClawType.body).multilineTextAlignment(.center)
                Button { self.retry += 1 } label: {
                    Text("Try again").font(OpenClawType.body)
                }
            }
            .padding()
        } else {
            switch self.preview {
            case let .text(text, truncated):
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if truncated {
                            Text("Preview shortened. Save the file to read the full contents.")
                                .font(OpenClawType.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Text(verbatim: text)
                            .font(OpenClawType.monoSmall)
                            .accessibilityIdentifier("artifact-preview-text")
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding()
                }
            case let .image(image):
                Button {
                    self.showsFullImage = true
                } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .padding()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(self.artifact.title)
                .accessibilityHint("Opens image preview")
                .fullScreenCover(isPresented: self.$showsFullImage) {
                    ChatMediaImagePreview(image: image) { self.showsFullImage = false }
                }
            case let .pdf(document):
                ArtifactPDFPreview(document: document)
            case .unavailable:
                VStack(spacing: 12) {
                    Image(systemName: self.artifact.symbol)
                        .font(.system(size: 44))
                        .foregroundStyle(.secondary)
                    Text(self.artifact.canDownload ? "No preview available" : "Download unavailable")
                        .font(OpenClawType.headline)
                    Text(self.artifact.canDownload
                        ? "Use Share to save this file or open it in another app."
                        : "This item cannot be downloaded from the Gateway. Ask for it to be shared again as a file.")
                        .font(OpenClawType.subhead)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            }
        }
    }

    private func fetch() async {
        guard self.artifact.canDownload else { return }
        self.isLoading = true
        self.errorMessage = nil
        defer { self.isLoading = false }
        do {
            let media = try await self.load()
            try Task.checkCancellation()
            let image = if Self.previewKind(mimeType: media.mimeType) == .image,
                           media.data.count <= OpenClawChatMediaKind.image.maximumDownloadBytes
            {
                await Task.detached(priority: .userInitiated) { ChatMediaImageDecoder.decode(media.data) }.value
            } else {
                nil as UIImage?
            }
            try Task.checkCancellation()
            self.hasLoadedFile = true
            switch Self.previewKind(mimeType: media.mimeType) {
            case .text:
                let limit = 256 * 1024
                let prefix = media.data.prefix(limit)
                let truncated = media.data.count > limit
                // A preview boundary may split one UTF-8 scalar. Other invalid data stays export-only.
                let text = (0...(truncated ? 3 : 0)).lazy.compactMap {
                    String(bytes: prefix.dropLast($0), encoding: .utf8)
                }.first
                self.preview = text.map { .text($0, truncated: truncated) } ?? .unavailable
            case .image:
                self.preview = image.map(Preview.image) ?? .unavailable
            case .pdf:
                // Keep document parsing bounded; the original remains exportable.
                self.preview = media.data.count <= 8 * 1024 * 1024 && media.data.starts(with: Data("%PDF-".utf8))
                    ? PDFDocument(data: media.data).map(Preview.pdf) ?? .unavailable : .unavailable
            case .none:
                self.preview = .unavailable
            }
        } catch is CancellationError {
            if !Task.isCancelled {
                self.errorMessage = String(localized: "The Gateway connection changed. Try again to reload this file.")
            }
        } catch {
            if !Task.isCancelled { self.errorMessage = IOSSessionArtifactsModel.message(for: error) }
        }
    }

    enum PreviewKind { case text, image, pdf, none }

    static func previewKind(mimeType: String) -> PreviewKind {
        let mime = mimeType.split(separator: ";", maxSplits: 1).first?.lowercased() ?? ""
        // Text is rendered literally, including HTML/SVG source; never in a web view.
        if mime.hasPrefix("text/") || ["application/json", "application/xml", "image/svg+xml"]
            .contains(mime) { return .text }
        if ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]
            .contains(mime) { return .image }
        return mime == "application/pdf" ? .pdf : .none
    }

    private func share() {
        guard !self.isSharing, self.hasLoadedFile else { return }
        self.isSharing = true
        self.shareTask = Task {
            defer { self.isSharing = false }
            do {
                // Export is a new user action: obtain bytes again under the captured live authority.
                let refreshed = try await self.load()
                try Task.checkCancellation()
                var name = self.artifact.title
                if (name as NSString).pathExtension.isEmpty,
                   let ext = UTType(mimeType: refreshed.mimeType)?.preferredFilenameExtension
                { name += ".\(ext)" }
                let fileName = name
                let file = try await Task.detached(priority: .userInitiated) {
                    try ChatDownloadedFile(data: refreshed.data, fileName: fileName)
                }.value
                try Task.checkCancellation()
                self.sharedFile = file
            } catch is CancellationError {
                if !Task.isCancelled {
                    self
                        .errorMessage =
                        String(localized: "The Gateway connection changed. Try again before sharing this file.")
                }
            } catch {
                if !Task.isCancelled { self.errorMessage = IOSSessionArtifactsModel.message(for: error) }
            }
        }
    }
}

private struct ArtifactPDFPreview: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context _: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.accessibilityIdentifier = "artifact-preview-pdf"
        view.document = self.document
        return view
    }

    func updateUIView(_ uiView: PDFView, context _: Context) {
        if uiView.document !== self.document { uiView.document = self.document }
    }
}
