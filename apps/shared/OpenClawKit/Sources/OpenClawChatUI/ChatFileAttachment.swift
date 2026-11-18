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

    @State private var requestID: UUID?
    @State private var isLoading = false
    @State private var downloadedFile: ChatDownloadedFile?
    @State private var showsError = false

    var body: some View {
        Button {
            self.requestID = UUID()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc")
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.label)
                        .font(OpenClawChatTypography.footnote)
                        .lineLimit(2)
                    Text(self.isLoading ? "Downloading…" : "Download file")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if self.isLoading {
                    ProgressView()
                } else {
                    Image(systemName: "arrow.down.circle")
                }
            }
            .padding(10)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!self.resolverReady || self.isLoading)
        .accessibilityIdentifier("chat-file-download")
        .task(id: self.requestID) {
            guard self.requestID != nil else { return }
            await self.download()
        }
        .onChange(of: self.resolverReady) { _, ready in
            if !ready { self.requestID = nil }
        }
        .alert("Unable to Download File", isPresented: self.$showsError) {
            Button(role: .cancel) {} label: {
                Text("OK").font(OpenClawChatTypography.body)
            }
        } message: {
            Text("Reconnect and try again. If the file has expired or was removed, ask the assistant to send it again.")
                .font(OpenClawChatTypography.body)
        }
        #if os(iOS)
        .sheet(item: self.$downloadedFile) { file in
            // The sheet retains the file until the system activity finishes.
            OpenClawChatFileShareSheet(fileURL: file.url, onCompletion: { _ = file })
        }
        #endif
    }

    @MainActor private func download() async {
        self.isLoading = true
        defer {
            self.isLoading = false
            self.requestID = nil
        }
        do {
            let loaded = try await self.load(self.artifactId)
            try Task.checkCancellation()
            guard case let .data(media) = loaded else {
                self.showsError = true
                return
            }
            try Task.checkCancellation()
            let fileName = self.fileName
            let file = try await Task.detached(priority: .userInitiated) {
                try ChatDownloadedFile(data: media.data, fileName: fileName)
            }.value
            try Task.checkCancellation()
            #if os(macOS)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = file.url.lastPathComponent
            panel.begin { response in
                guard response == .OK, let destination = panel.url else { return }
                do {
                    let data = try Data(contentsOf: file.url)
                    try data.write(to: destination, options: .atomic)
                } catch {
                    self.showsError = true
                }
            }
            #else
            self.downloadedFile = file
            #endif
        } catch is CancellationError {
            // Leaving the message or changing Gateway cancels the export.
        } catch {
            if !Task.isCancelled { self.showsError = true }
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
