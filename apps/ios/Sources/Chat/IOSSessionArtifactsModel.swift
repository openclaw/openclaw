import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

struct IOSSessionArtifact: Identifiable, Sendable {
    let summary: ArtifactSummary

    var id: String {
        self.summary.id
    }

    var title: String {
        self.summary.title
    }

    var canDownload: Bool {
        let mode = self.summary.download["mode"]?.value as? String
        return mode == "bytes" || mode == "url"
    }

    var category: Category {
        let mime = self.summary.mimetype?.lowercased() ?? ""
        if mime.hasPrefix("image/") || self.summary.type == "image" { return .images }
        if mime.hasPrefix("audio/") || mime.hasPrefix("video/") { return .media }
        return .documents
    }

    var symbol: String {
        switch self.category {
        case .images: "photo"
        case .media: self.summary.mimetype?.hasPrefix("audio/") == true ? "waveform" : "film"
        case .documents: self.summary.mimetype == "application/pdf" ? "doc.richtext" : "doc.text"
        }
    }

    var sizeDescription: String? {
        self.summary.sizebytes.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
    }

    enum Category {
        case documents, images, media

        var title: String {
            switch self {
            case .documents: String(localized: "Documents")
            case .images: String(localized: "Images")
            case .media: String(localized: "Audio & video")
            }
        }
    }
}

@MainActor
@Observable
final class IOSSessionArtifactsModel {
    private(set) var artifacts: [IOSSessionArtifact] = []
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?
    @ObservationIgnored private let acquire: @Sendable () async throws -> IOSSessionArtifactAccess

    init(acquire: @escaping @Sendable () async throws -> IOSSessionArtifactAccess) {
        self.acquire = acquire
    }

    func refresh() async {
        guard !self.isLoading else { return }
        self.isLoading = true
        self.errorMessage = nil
        defer { self.isLoading = false }
        do {
            let access = try await self.acquire()
            let result = try await access.list()
            try Task.checkCancellation()
            // A managed file can recur in the transcript with the same download identity.
            var seen = Set<String>()
            self.artifacts = result.artifacts.filter { seen.insert($0.id).inserted }
                .map { IOSSessionArtifact(summary: $0) }
            self.hasLoaded = true
        } catch is CancellationError {
            if !Task.isCancelled {
                self
                    .errorMessage =
                    String(localized: "The Gateway connection changed. Refresh to reconnect to this conversation.")
            }
        } catch {
            if !Task.isCancelled { self.errorMessage = Self.message(for: error) }
        }
    }

    func download(_ artifact: IOSSessionArtifact) async throws -> OpenClawChatMediaData {
        guard artifact.canDownload, self.hasLoaded else { throw ArtifactError.unavailable }
        // Each user action reacquires the route within the presentation's captured identity.
        let access = try await self.acquire()
        let result = try await access.download(artifact.id)
        try Task.checkCancellation()
        return result
    }

    enum ArtifactError: Error {
        case unavailable
    }

    static func message(for error: any Error) -> String {
        if let error = error as? GatewayResponseError {
            if error.missingScopeDetails != nil || error.code == "FORBIDDEN" {
                return String(localized: "This connection does not have permission to access these files.")
            }
            if error.code == "METHOD_NOT_FOUND" || error.message.hasPrefix("unknown method:") {
                return String(
                    localized: "This Gateway does not support Outputs. Update the Gateway and try again.")
            }
        }
        if let error = error as? URLError, [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost]
            .contains(error.code)
        {
            return String(localized: "Reconnect to the Gateway, then try again.")
        }
        if let error = error as? OpenClawChatMediaArtifactLoader.LoadError {
            switch error {
            case .payloadTooLarge:
                return String(localized: "This file exceeds the download size supported on this device.")
            case .requestFailed(statusCode: 403):
                return String(localized: "Access to this file was denied. Refresh the list and try again.")
            case .requestFailed(statusCode: 404), .requestFailed(statusCode: 410):
                return String(localized: "This file is no longer available. Ask for it to be shared again.")
            default: break
            }
        }
        return String(
            localized: "Unable to load outputs. Reconnect or refresh and try again. The file may have been removed.")
    }
}
