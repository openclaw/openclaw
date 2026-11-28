import Foundation

/// Share requests inherit thinking from the destination session and model.
struct ShareAgentRequestPayload: Codable {
    struct Attachment: Codable {
        var type: String
        var mimeType: String
        var fileName: String
        var content: String
    }

    var message: String
    var sessionKey: String?
    var deliver: Bool
    var attachments: [Attachment]?
    var receipt: Bool
    var receiptText: String?
    var to: String?
    var channel: String?
    var timeoutSeconds: Int?
    var key: String?
}
