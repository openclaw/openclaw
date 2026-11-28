#if os(iOS)
import Foundation
import UIKit

/// Optional enrichment on opening a PR. The chat subscription stays summary-only.
public protocol ChatPRReaderTransport: Sendable {
    func pullRequestOverview(url: String, sessionKey: String) async throws -> Data?
}

struct ChatPRReaderOverview: Decodable {
    let url: String
    let author: String?
    let createdAt: String?
    let imageUrl: String?
    struct Checks: Decodable {
        struct Item: Decodable { let name: String
            let state: String
        }

        let items: [Item]
    }

    let checks: Checks?

    var date: Date? {
        guard let createdAt else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(createdAt))
            ?? (try? Date.ISO8601FormatStyle().parse(createdAt))
    }

    var avatar: UIImage? {
        // The GitHub reader returns a bounded inline raster. Never fetch arbitrary image URLs from the phone.
        guard let imageUrl, let comma = imageUrl.firstIndex(of: ","),
              ["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64", "data:image/gif;base64"]
                  .contains(String(imageUrl[..<comma])),
                  let bytes = Data(base64Encoded: String(imageUrl[imageUrl.index(after: comma)...])) else { return nil }
        return UIImage(data: bytes)
    }

    static func decode(_ data: Data, for url: String) -> Self? {
        guard let result = try? JSONDecoder().decode(Self.self, from: data), result.url == url else { return nil }
        return result
    }
}
#endif
