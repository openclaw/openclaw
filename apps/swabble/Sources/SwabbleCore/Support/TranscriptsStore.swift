import Foundation

public actor TranscriptsStore {
    public static let shared = TranscriptsStore()

    private var entries: [String] = []
    private let fileURL: URL

    public init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let dir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/swabble", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            self.fileURL = dir.appendingPathComponent("transcripts.log")
        }
        if let data = try? Data(contentsOf: self.fileURL),
           let text = String(data: data, encoding: .utf8)
        {
            self.entries = text.split(separator: "\n").map(String.init)
        }
    }

    public func append(text: String, maxEntries: Int) {
        self.entries.append(text)
        let overflow = self.entries.count - max(maxEntries, 0)
        if overflow > 0 {
            self.entries.removeFirst(overflow)
        }
        let body = self.entries.joined(separator: "\n")
        try? body.write(to: self.fileURL, atomically: false, encoding: .utf8)
    }

    public func latest() -> [String] {
        self.entries
    }
}
