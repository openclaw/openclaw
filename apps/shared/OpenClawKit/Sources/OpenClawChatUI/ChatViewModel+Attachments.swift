import AVFoundation
import Foundation
import ImageIO
import OpenClawKit
import UniformTypeIdentifiers

private enum ChatAttachmentReadError: Error {
    case tooLarge
    case unreadable
}

extension OpenClawChatViewModel {
    /// Bound memory for resize input independently of the encoded upload budget.
    private static let maxImageSourceBytes = 64 * 1024 * 1024

    public func addAttachments(urls: [URL]) {
        self.addAttachments(urls: urls, for: nil)
    }

    func addAttachments(urls: [URL], for session: SessionSnapshot?) {
        guard self.ownsAttachmentSession(session) else { return }
        let preparations = urls.map { url in
            let id = self.beginAttachmentPreparation(
                fileName: url.lastPathComponent,
                mimeType: Self.mimeType(for: url) ?? "application/octet-stream")
            self.setAttachmentPreparationReload(id) {
                await self.loadAttachments(urls: [url], expectedSession: session, preparations: [id])
            }
            return id
        }
        self.runAttachmentPreparation(preparations) {
            await self.loadAttachments(urls: urls, expectedSession: session, preparations: preparations)
        }
    }

    public func addImageAttachment(data: Data, fileName: String, mimeType: String) {
        let preparation = self.beginAttachmentPreparation(fileName: fileName, mimeType: mimeType)
        self.runAttachmentPreparation([preparation]) {
            let advertisedLimits = await self.transport.attachmentLimits()
            await self.stageImageAttachment(
                url: nil,
                data: data,
                fileName: fileName,
                mimeType: mimeType,
                advertisedLimits: advertisedLimits,
                preparation: preparation)
        }
    }

    func addImageAttachment(
        data: Data,
        fileName: String,
        mimeType: String,
        for session: SessionSnapshot,
        preparation: UUID? = nil) async
    {
        guard self.isCurrentSession(session) else { return }
        self.beginAttachmentStaging()
        defer { self.endAttachmentStaging() }
        let advertisedLimits = await self.transport.attachmentLimits()
        await self.stageImageAttachment(
            url: nil,
            data: data,
            fileName: fileName,
            mimeType: mimeType,
            advertisedLimits: advertisedLimits,
            expectedSession: session,
            preparation: preparation)
    }

    /// On iPhone a picked item gets its tile at once, at its final size, with a spinner until it is staged.
    /// Elsewhere the composer has no tile to show, so preparation keeps reporting through `errorText`.
    func beginAttachmentPreparation(
        fileName: String,
        mimeType: String,
        preview: OpenClawPlatformImage? = nil,
        durationSeconds: Double? = nil) -> UUID?
    {
        #if os(iOS)
        let id = UUID()
        self.preparingAttachments.append(OpenClawPreparingAttachment(
            id: id,
            fileName: fileName,
            mimeType: mimeType,
            preview: preview,
            durationSeconds: durationSeconds))
        return id
        #else
        return nil
        #endif
    }

    /// What the tile's retry runs: the same read again, under the same id and staging pin.
    func setAttachmentPreparationReload(_ id: UUID?, _ work: @escaping @MainActor () async -> Void) {
        guard let id, let index = self.preparingAttachments.firstIndex(where: { $0.id == id }) else { return }
        self.preparingAttachments[index].reload = { [weak self] in
            guard let self, let index = self.preparingAttachments.firstIndex(where: { $0.id == id }) else { return }
            self.preparingAttachments[index].failure = nil
            self.preparingAttachments[index].failureIsTransient = false
            self.runAttachmentPreparation([id], work)
        }
    }

    /// Runs under the staging pin. A tile its work neither staged nor failed (its chat went away mid-read)
    /// is removed when the work ends.
    @discardableResult
    func runAttachmentPreparation(
        _ preparations: [UUID?],
        _ work: @escaping @MainActor () async -> Void) -> Task<Void, Never>
    {
        self.beginAttachmentStaging()
        return Task {
            defer {
                self.preparingAttachments.removeAll { $0.failure == nil && preparations.contains($0.id) }
                self.endAttachmentStaging()
            }
            await work()
        }
    }

    /// The iPhone tile says what failed as a sentence that starts with the attachment's name; without a tile the
    /// chat error keeps its wording.
    static func couldNotAttachMessage(_ fileName: String, preparation: UUID?) -> String {
        preparation == nil
            ? String(format: String(localized: "Could not attach: %@"), fileName)
            : self.couldNotAttachSentence(fileName)
    }

    static func couldNotAttachSentence(_ name: String) -> String {
        String(format: String(localized: "Couldn’t attach %@."), name)
    }

    static func tooLargeMessage(_ fileName: String, preparation: UUID?) -> String {
        preparation == nil
            ? String(format: String(localized: "Too large to send: %@"), fileName)
            : String(format: String(localized: "%@ is too large to send."), fileName)
    }

    /// What a person calls an attachment: a recorded voice note is "Voice note", never its temporary file name.
    static func displayName(_ attachment: OpenClawPendingAttachment) -> String {
        attachment.mimeType.hasPrefix("audio/") && attachment.durationSeconds != nil
            ? String(localized: "Voice note")
            : attachment.fileName
    }

    private static func unsupportedImageMessage(_ fileName: String) -> String {
        String(format: String(localized: "%@ isn’t a supported image."), fileName)
    }

    /// The tile names the failure by its case instead of printing the processor's own text. `encodeFailed` covers
    /// both "could not fit the upload limit" and a failed JPEG encode, so it says only that the file did not attach.
    static func imageProcessingMessage(_ error: Error, fileName: String) -> String {
        switch error as? ChatImageProcessor.ProcessError {
        case .notAnImage, .decodeFailed: self.unsupportedImageMessage(fileName)
        case .encodeFailed, nil: self.couldNotAttachSentence(fileName)
        }
    }

    func isAttachmentPreparationRemoved(_ id: UUID?) -> Bool {
        guard let id else { return false }
        return !self.preparingAttachments.contains { $0.id == id }
    }

    /// A failure shows on its tile when there is one, and the first one in a run is the one kept.
    /// A removed tile was cancelled, so its failure is dropped. Without a tile it is the chat's error.
    func reportAttachmentFailure(_ message: String, preparation id: UUID?, transient: Bool = false) {
        guard let id else {
            self.errorText = message
            return
        }
        guard let index = self.preparingAttachments.firstIndex(where: { $0.id == id }),
              self.preparingAttachments[index].failure == nil
        else { return }
        self.preparingAttachments[index].failure = message
        self.preparingAttachments[index].failureIsTransient = transient
    }

    func validateAttachmentBudgetForSend(
        _ draftAttachments: [OpenClawPendingAttachment],
        session: SessionSnapshot) async -> Bool
    {
        guard !draftAttachments.isEmpty else { return self.isCurrentSession(session) }
        let limits = await self.transport.attachmentLimits() ?? .legacyClientFallback
        guard self.isCurrentSession(session) else { return false }
        return self.validateAttachmentBudget(draftAttachments, limits: limits)
    }

    private func validateAttachmentBudget(
        _ candidates: [OpenClawPendingAttachment],
        limits: GatewayAttachmentLimits,
        preparation: UUID? = nil) -> Bool
    {
        // Every attachment shares one base64-encoded chat.send frame. Subtract
        // from the decoded budget to include prior selections without sum overflow.
        var remaining = limits.maxBytes
        for attachment in candidates {
            guard attachment.data.count <= remaining else {
                // The chat error keeps the file name; a tile says what a person calls it.
                let name = preparation == nil ? attachment.fileName : Self.displayName(attachment)
                // On a tile, say whether the file is too large on its own or only with what is already attached.
                let message = preparation != nil && attachment.data.count <= limits.maxBytes
                    ? String(format: String(localized: "%@ is too large to send with the other attachments."), name)
                    : Self.tooLargeMessage(name, preparation: preparation)
                self.reportAttachmentFailure(message, preparation: preparation)
                return false
            }
            remaining -= attachment.data.count
        }
        return true
    }

    /// A prepared attachment carries its tile's id, so it takes the tile's place without moving.
    @discardableResult
    private func stageAttachment(
        _ attachment: OpenClawPendingAttachment,
        limits: GatewayAttachmentLimits,
        preparation: UUID? = nil) -> Bool
    {
        // Removed while it was being read: the user cancelled it.
        guard !self.isAttachmentPreparationRemoved(preparation) else { return true }
        guard self.validateAttachmentBudget(
            self.attachments + [attachment],
            limits: limits,
            preparation: preparation)
        else { return false }
        self.preparingAttachments.removeAll { $0.id == attachment.id }
        self.attachments.append(attachment)
        return true
    }

    /// Removing a tile that is still preparing cancels it; its read finishes and is dropped.
    public func removeAttachment(_ id: OpenClawPendingAttachment.ID) {
        preparingAttachments.removeAll { $0.id == id }
        attachments.removeAll { $0.id == id }
        applyDeferredExternalStateIfReady()
    }

    func restoreEditorAttachments(_ editorAttachments: [OpenClawChatEditorAttachment]?) {
        self.attachments = (editorAttachments ?? []).enumerated().compactMap { index, attachment in
            guard let data = Data(base64Encoded: attachment.data),
                  data.count <= Self.maxAttachmentBytes,
                  let contentType = UTType(mimeType: attachment.mimeType),
                  contentType.conforms(to: .image)
            else { return nil }
            let fileExtension = contentType.preferredFilenameExtension ?? "img"
            return OpenClawPendingAttachment(
                url: nil,
                data: data,
                fileName: "image-\(index + 1).\(fileExtension)",
                mimeType: attachment.mimeType,
                preview: OpenClawPlatformImage(data: data))
        }
    }

    /// True while replacing this model could move an attachment across chats.
    /// An attachment saved in its session's durable draft belongs to that draft instead.
    public var isAttachmentOwnerPinned: Bool {
        attachmentOwnerIsActive() ||
            isSendingAttachmentDraft ||
            attachmentStagingCount > 0 ||
            attachments.contains { composerDraftAttachmentPositions[$0.id] == nil }
    }

    func canCreateSessionForImmediateSwitch() -> Bool {
        guard !self.isAttachmentOwnerPinned else {
            self.errorText = String(
                localized: "Remove attachments or wait for delivery to resolve before starting a new chat.")
            return false
        }
        return true
    }

    /// Applies external owner changes once recording or staging releases them.
    public func attachmentOwnerActivityChanged() {
        applyDeferredExternalStateIfReady()
    }

    /// File reads and image processing suspend before the attachment exists.
    /// Keep their original chat owner pinned until staging succeeds or fails.
    func beginAttachmentStaging() {
        attachmentStagingCount += 1
    }

    func endAttachmentStaging() {
        precondition(attachmentStagingCount > 0)
        attachmentStagingCount -= 1
        applyDeferredExternalStateIfReady()
    }

    /// Stages a recorded m4a voice note and removes its temporary file.
    public func addVoiceNoteAttachment(fileURL: URL, durationSeconds: Double) async {
        let normalizedDuration = durationSeconds.isFinite
            ? min(max(0, durationSeconds), OpenClawVoiceNoteRecorder.maximumDurationSeconds)
            : 0
        // The recording is gone once read, so its tile has no retry.
        let preparation = self.beginAttachmentPreparation(
            fileName: fileURL.lastPathComponent,
            mimeType: "audio/mp4",
            durationSeconds: normalizedDuration)
        self.beginAttachmentStaging()
        defer {
            try? FileManager.default.removeItem(at: fileURL)
            self.preparingAttachments.removeAll { $0.id == preparation && $0.failure == nil }
            self.endAttachmentStaging()
        }

        let data: Data
        do {
            data = try await Task.detached(priority: .userInitiated) {
                try Data(contentsOf: fileURL)
            }.value
        } catch {
            // The recording is deleted once read, so the tile offers no retry, only another recording.
            self.reportAttachmentFailure(
                preparation == nil
                    ? String(
                        format: String(localized: "Could not attach voice note: %@"),
                        error.localizedDescription)
                    : String(localized: "Couldn’t attach voice note. Try recording again."),
                preparation: preparation)
            return
        }

        guard data.count <= Self.maxAttachmentBytes else {
            // `maxAttachmentBytes` is 5 MB.
            self.reportAttachmentFailure(
                preparation == nil
                    ? String(localized: "Voice note exceeds the 5 MB attachment limit")
                    : String(localized: "Voice note is over the 5 MB limit. Record a shorter one."),
                preparation: preparation)
            return
        }

        let limits = await self.transport.attachmentLimits() ?? .legacyClientFallback
        self.stageAttachment(
            OpenClawPendingAttachment(
                url: nil,
                data: data,
                fileName: fileURL.lastPathComponent,
                mimeType: "audio/mp4",
                preview: nil,
                durationSeconds: normalizedDuration,
                id: preparation ?? UUID()),
            limits: limits,
            preparation: preparation)
    }

    func loadAttachments(
        urls: [URL],
        expectedSession: SessionSnapshot? = nil,
        preparations: [UUID?] = []) async
    {
        // One selection owns one policy snapshot. Reacquiring route-dependent
        // limits between files can strand a partially staged batch during recovery.
        let advertisedLimits = await self.transport.attachmentLimits()
        var unreadable: [String] = []
        var oversized: [String] = []
        for (index, url) in urls.enumerated() {
            guard self.ownsAttachmentSession(expectedSession) else { return }
            let preparation = index < preparations.count ? preparations[index] : nil
            guard !self.isAttachmentPreparationRemoved(preparation) else { continue }
            do {
                try await self.addFileAttachment(
                    url: url,
                    fileName: url.lastPathComponent,
                    mimeType: Self.mimeType(for: url) ?? "application/octet-stream",
                    advertisedLimits: advertisedLimits,
                    expectedSession: expectedSession,
                    preparation: preparation)
            } catch ChatAttachmentReadError.tooLarge {
                if preparation != nil {
                    self.reportAttachmentFailure(
                        Self.tooLargeMessage(url.lastPathComponent, preparation: preparation),
                        preparation: preparation)
                } else {
                    oversized.append(url.lastPathComponent)
                }
            } catch {
                if preparation != nil {
                    self.reportAttachmentFailure(
                        Self.couldNotAttachMessage(url.lastPathComponent, preparation: preparation),
                        preparation: preparation,
                        transient: true)
                } else {
                    unreadable.append(url.lastPathComponent)
                }
            }
        }
        guard self.ownsAttachmentSession(expectedSession) else { return }
        let errors = [
            unreadable.isEmpty ? nil : String(
                format: String(localized: "Could not attach: %@"), Self.attachmentNames(unreadable)),
            oversized.isEmpty ? nil : String(
                format: String(localized: "Too large to send: %@"), Self.attachmentNames(oversized)),
        ].compactMap(\.self)
        if !errors.isEmpty { self.errorText = errors.joined(separator: "\n") }
    }

    private static func attachmentNames(_ names: [String]) -> String {
        let more = names.count > 3 ? String(format: String(localized: " +%@"), String(names.count - 3)) : ""
        return names.prefix(3).joined(separator: ", ") + more
    }

    nonisolated static func mimeType(for url: URL) -> String? {
        let ext = url.pathExtension
        guard !ext.isEmpty else { return nil }
        return (UTType(filenameExtension: ext) ?? .data).preferredMIMEType
    }

    @discardableResult
    private func stageImageAttachment(
        url: URL?,
        data: Data,
        fileName: String,
        mimeType: String,
        advertisedLimits: GatewayAttachmentLimits?,
        expectedSession: SessionSnapshot? = nil,
        preparation: UUID? = nil) async -> ChatAttachmentReadError?
    {
        let limits = advertisedLimits ?? .legacyClientFallback
        guard self.ownsAttachmentSession(expectedSession) else { return nil }
        guard !data.isEmpty else {
            self.reportAttachmentFailure(
                Self.couldNotAttachMessage(fileName, preparation: preparation),
                preparation: preparation,
                transient: true)
            return .unreadable
        }
        if data.count > Self.maxImageSourceBytes {
            self.reportAttachmentFailure(
                Self.tooLargeMessage(fileName, preparation: preparation),
                preparation: preparation)
            return .tooLarge
        }
        let uti: UTType = {
            if let url {
                return UTType(filenameExtension: url.pathExtension) ?? .data
            }
            return UTType(mimeType: mimeType) ?? .data
        }()
        guard uti.conforms(to: .image) else {
            self.reportAttachmentFailure(
                preparation == nil
                    ? String(localized: "Only image attachments are supported right now")
                    : Self.unsupportedImageMessage(fileName),
                preparation: preparation)
            return .unreadable
        }

        let processed: Data
        do {
            processed = try await Task.detached(priority: .userInitiated) {
                try ChatImageProcessor.processForUpload(data: data)
            }.value
        } catch {
            guard self.ownsAttachmentSession(expectedSession) else { return nil }
            self.reportAttachmentFailure(
                preparation == nil
                    ? String(
                        format: String(localized: "Could not process %1$@: %2$@"),
                        fileName,
                        error.localizedDescription)
                    : Self.imageProcessingMessage(error, fileName: fileName),
                preparation: preparation)
            return .unreadable
        }

        // Image processing runs off actor. Revalidate the draft owner before
        // publishing either the attachment or any session-scoped error state.
        guard self.ownsAttachmentSession(expectedSession) else { return nil }
        if processed.count > limits.maxImageBytes {
            self.reportAttachmentFailure(
                Self.tooLargeMessage(fileName, preparation: preparation),
                preparation: preparation)
            return .tooLarge
        }

        let outputFileName: String = {
            let baseName = (fileName as NSString).deletingPathExtension
            return baseName.isEmpty ? "image.jpg" : "\(baseName).jpg"
        }()

        let preview = OpenClawPlatformImage(data: processed)
        return self.stageAttachment(
            OpenClawPendingAttachment(
                url: url,
                data: processed,
                fileName: outputFileName,
                mimeType: "image/jpeg",
                preview: preview,
                id: preparation ?? UUID()),
            limits: limits,
            preparation: preparation) ? nil : .tooLarge
    }

    func addVideoAttachment(
        url: URL,
        fileName: String,
        mimeType: String,
        expectedSession: SessionSnapshot? = nil,
        preparation: UUID? = nil) async
    {
        guard self.ownsAttachmentSession(expectedSession) else { return }
        let advertisedLimits = await self.transport.attachmentLimits()
        do {
            try await self.addFileAttachment(
                url: url,
                fileName: fileName,
                mimeType: mimeType,
                advertisedLimits: advertisedLimits,
                expectedSession: expectedSession,
                preparation: preparation)
        } catch ChatAttachmentReadError.tooLarge {
            guard self.ownsAttachmentSession(expectedSession) else { return }
            self.reportAttachmentFailure(
                Self.tooLargeMessage(fileName, preparation: preparation),
                preparation: preparation)
        } catch {
            guard self.ownsAttachmentSession(expectedSession) else { return }
            self.reportAttachmentFailure(
                Self.couldNotAttachMessage(fileName, preparation: preparation),
                preparation: preparation,
                transient: true)
        }
    }

    private func addFileAttachment(
        url: URL,
        fileName: String,
        mimeType: String,
        advertisedLimits: GatewayAttachmentLimits?,
        expectedSession: SessionSnapshot?,
        preparation: UUID? = nil) async throws
    {
        let limits = advertisedLimits ?? .legacyClientFallback
        guard self.ownsAttachmentSession(expectedSession) else { return }
        let hasSecurityScope = url.startAccessingSecurityScopedResource()
        defer {
            if hasSecurityScope { url.stopAccessingSecurityScopedResource() }
        }
        let isImage = mimeType.hasPrefix("image/")
        let maximumSourceBytes = isImage ? Self.maxImageSourceBytes : limits.maxBytes
        let data = try await Self.readAttachmentData(from: url, maximumBytes: maximumSourceBytes)
        guard self.ownsAttachmentSession(expectedSession) else { return }
        if isImage {
            if let error = await self.stageImageAttachment(
                url: url,
                data: data,
                fileName: fileName,
                mimeType: mimeType,
                advertisedLimits: advertisedLimits,
                expectedSession: expectedSession,
                preparation: preparation)
            {
                throw error
            }
            return
        }

        var thumbnailData: Data?
        if mimeType.hasPrefix("video/") {
            thumbnailData = await Self.videoThumbnailData(data: data, fileExtension: url.pathExtension)
        }
        guard self.ownsAttachmentSession(expectedSession) else { return }
        guard self.stageAttachment(
            OpenClawPendingAttachment(
                url: nil,
                data: data,
                fileName: fileName,
                mimeType: mimeType,
                preview: thumbnailData.flatMap(OpenClawPlatformImage.init(data:)),
                id: preparation ?? UUID()),
            limits: limits,
            preparation: preparation)
        else { throw ChatAttachmentReadError.tooLarge }
    }

    private func ownsAttachmentSession(_ expectedSession: SessionSnapshot?) -> Bool {
        expectedSession.map(self.isCurrentSession) ?? true
    }

    private nonisolated static func readAttachmentData(from url: URL, maximumBytes: Int) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            guard url.isFileURL else { throw ChatAttachmentReadError.unreadable }
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true else { throw ChatAttachmentReadError.unreadable }
            if let fileSize = values.fileSize, fileSize > maximumBytes {
                throw ChatAttachmentReadError.tooLarge
            }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            // A file can grow after the metadata check; enforce the source
            // budget on the bytes actually read, before resizing or encoding.
            let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
            if data.count > maximumBytes {
                throw ChatAttachmentReadError.tooLarge
            }
            guard !data.isEmpty else { throw ChatAttachmentReadError.unreadable }
            return data
        }.value
    }

    private nonisolated static func videoThumbnailData(
        data: Data,
        fileExtension: String) async -> Data?
    {
        await Task.detached(priority: .userInitiated) {
            let fileURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-upload-preview-\(UUID().uuidString)")
                .appendingPathExtension(fileExtension)
            defer { try? FileManager.default.removeItem(at: fileURL) }
            do {
                try data.write(to: fileURL, options: [.atomic])
                let generator = AVAssetImageGenerator(asset: AVURLAsset(url: fileURL))
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: 640, height: 640)
                let image = try await generator.image(at: .zero).image
                let encoded = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(
                    encoded,
                    UTType.jpeg.identifier as CFString,
                    1,
                    nil)
                else { return nil }
                CGImageDestinationAddImage(
                    destination,
                    image,
                    [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
                guard CGImageDestinationFinalize(destination) else { return nil }
                return encoded as Data
            } catch {
                return nil
            }
        }.value
    }
}
