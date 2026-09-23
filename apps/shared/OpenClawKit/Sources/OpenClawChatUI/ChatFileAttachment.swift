import Foundation
import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Owns only the temporary copy handed to the system exporter, not Gateway paths.
final class ChatDownloadedFile: Identifiable, Sendable {
    let id = UUID()
    let url: URL
    private let directory: URL

    init(data: Data, fileName: String) throws {
        let name = (fileName.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
        let safeName = name.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
            .map(String.init).joined()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-chat-file-\(UUID().uuidString)", isDirectory: true)
        self.directory = directory
        self.url = directory.appendingPathComponent(
            safeName.isEmpty || safeName == "." || safeName == ".." ? "Attachment" : safeName,
            isDirectory: false)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try data.write(to: self.url, options: .atomic)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    deinit {
        try? FileManager.default.removeItem(at: self.directory)
    }
}

struct ChatFileAttachment: View {
    let artifactId: String
    let label: String
    let fileName: String
    let resolverReady: Bool
    let load: @MainActor @Sendable (String) async throws -> OpenClawChatLoadedMedia?

    private struct DownloadRequest: Identifiable {
        let id = UUID()
        let capture: OpenClawChatModalPresentations.Capture
    }

    @State private var request: DownloadRequest?
    @ChatModalState private var modals

    var body: some View {
        Button {
            // Capture the reader and chat owner at the tap, before the download
            // suspends. A later completion cannot borrow a replacement screen.
            guard let capture = self.modals.capture() else { return }
            self.request = DownloadRequest(capture: capture)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc")
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.label)
                        .font(OpenClawChatTypography.footnote)
                        .lineLimit(2)
                    Text(self.request != nil ? "Downloading…" : "Download file")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if self.request != nil {
                    ProgressView()
                } else {
                    Image(systemName: "arrow.down.circle")
                }
            }
            .padding(10)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!self.resolverReady || self.request != nil)
        .accessibilityIdentifier("chat-file-download")
        .task(id: self.request?.id) {
            guard let request = self.request else { return }
            await self.download(request)
        }
        .onChange(of: self.resolverReady) { _, ready in
            if !ready { self.request = nil }
        }
        .modifier(self.$modals)
    }

    @MainActor private func download(_ request: DownloadRequest) async {
        let owner = self.modals.owner
        let capture = request.capture
        defer {
            if self.request?.id == request.id { self.request = nil }
        }
        do {
            guard capture.isCurrent else { return }
            let loaded = try await self.load(self.artifactId)
            try Task.checkCancellation()
            guard case let .data(media) = loaded else {
                owner.present((), at: \.fileError, capture: capture)
                return
            }
            guard capture.isCurrent else { return }
            try Task.checkCancellation()
            let fileName = self.fileName
            let file = try await Task.detached(priority: .userInitiated) {
                try ChatDownloadedFile(data: media.data, fileName: fileName)
            }.value
            try Task.checkCancellation()
            guard capture.isCurrent else { return }
            #if os(macOS)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = file.url.lastPathComponent
            panel.begin { response in
                guard response == .OK, let destination = panel.url else { return }
                do {
                    let data = try Data(contentsOf: file.url)
                    try data.write(to: destination, options: .atomic)
                } catch {
                    owner.present((), at: \.fileError, capture: capture)
                }
            }
            #else
            owner.present(file, at: \.fileExport, capture: capture)
            #endif
        } catch is CancellationError {
            // Leaving the message or changing Gateway cancels the export.
        } catch {
            if !Task.isCancelled { owner.present((), at: \.fileError, capture: capture) }
        }
    }
}

#if os(iOS)
/// System file sharing used by chat attachments, transcript export, and workspace files.
public struct OpenClawChatFileShareSheet: UIViewControllerRepresentable {
    public let fileURL: URL
    private let onCompletion: (() -> Void)?

    public init(fileURL: URL, onCompletion: (() -> Void)? = nil) {
        self.fileURL = fileURL
        self.onCompletion = onCompletion
    }

    public func makeUIViewController(context _: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [self.fileURL], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in self.onCompletion?() }
        return controller
    }

    public func updateUIViewController(_: UIActivityViewController, context _: Context) {}
}
#endif
