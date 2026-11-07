import Foundation

struct ShareAttachmentSummary: Equatable {
    var selectedImageCount = 0
    var acceptedImageCount = 0
    var videoCount = 0
    var fileCount = 0
    var unknownCount = 0

    mutating func recordUnclassifiedProvider(didIncludeContent: Bool) {
        if !didIncludeContent {
            self.unknownCount += 1
        }
    }

    var omissionMessage: String? {
        var details: [String] = []

        if self.selectedImageCount > self.acceptedImageCount {
            details.append(String(
                format: NSLocalizedString(
                    "Only %d of %d images can be sent.",
                    comment: "Share extension image attachment limit warning"),
                self.acceptedImageCount,
                self.selectedImageCount))
        }

        let unsupported = [
            Self.unsupportedCount(
                self.videoCount,
                singular: NSLocalizedString("%d video", comment: "Share extension unsupported video count"),
                plural: NSLocalizedString("%d videos", comment: "Share extension unsupported video count")),
            Self.unsupportedCount(
                self.fileCount,
                singular: NSLocalizedString("%d file", comment: "Share extension unsupported file count"),
                plural: NSLocalizedString("%d files", comment: "Share extension unsupported file count")),
            Self.unsupportedCount(
                self.unknownCount,
                singular: NSLocalizedString(
                    "%d unsupported item",
                    comment: "Share extension unsupported attachment count"),
                plural: NSLocalizedString(
                    "%d unsupported items",
                    comment: "Share extension unsupported attachment count")),
        ].compactMap(\.self)

        if !unsupported.isEmpty {
            details.append(String(
                format: NSLocalizedString(
                    "OpenClaw Share cannot send %@ yet.",
                    comment: "Share extension unsupported attachment warning"),
                unsupported.joined(separator: ", ")))
        }

        guard !details.isEmpty else { return nil }
        return details.joined(separator: " ")
    }

    private static func unsupportedCount(
        _ count: Int,
        singular: @autoclosure () -> String,
        plural: @autoclosure () -> String) -> String?
    {
        guard count > 0 else { return nil }
        return String(format: count == 1 ? singular() : plural(), count)
    }
}

enum ShareAttachmentBlockReason: Equatable {
    case imageProcessingFailed
    case omitted(String)

    static func resolve(
        hasImageProcessingError: Bool,
        summary: ShareAttachmentSummary) -> Self?
    {
        if hasImageProcessingError {
            return .imageProcessingFailed
        }
        if let omissionMessage = summary.omissionMessage {
            return .omitted(omissionMessage)
        }
        return nil
    }
}

/// Recovery must name only actions the current share can actually offer.
enum ShareImportRecovery {
    case save
    case selectDestination
    case unreadableDestination

    var canSave: Bool {
        if case .save = self { return true }
        return false
    }

    var message: String {
        switch self {
        case .save:
            NSLocalizedString(
                "Choose Save to OpenClaw to keep every item, then open the app to review and import.",
                comment: "Share extension available import recovery")
        case .selectDestination:
            NSLocalizedString(
                "Open OpenClaw, select the intended Gateway and chat, then share again.",
                comment: "Share extension missing import destination recovery")
        case .unreadableDestination:
            NSLocalizedString(
                "The saved chat destination could not be read.",
                comment: "Share extension unreadable import destination recovery") + " " +
                Self.selectDestination.message
        }
    }
}

extension ShareAttachmentBlockReason {
    func message(recovery: ShareImportRecovery) -> String {
        let reason: String = switch self {
        case .imageProcessingFailed:
            NSLocalizedString(
                "The shared image could not be prepared.",
                comment: "Share extension image processing failure")
        case let .omitted(message): message
        }
        return reason + " " + recovery.message
    }
}
