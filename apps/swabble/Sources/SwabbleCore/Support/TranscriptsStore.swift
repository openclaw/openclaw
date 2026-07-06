import Foundation

public actor TranscriptsStore {
    public static let shared = TranscriptsStore()

    private var entries: [String] = []
    private let limit = 100
    private let fileURL: URL

    public init() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/swabble", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("transcripts.log")
        if let data = try? Data(contentsOf: fileURL),
           let text = String(data: data, encoding: .utf8) {
            entries = text.split(separator: "\n").map(String.init).suffix(limit)
        }
    }

    public func append(text: String) {
        entries.append(text)
        if entries.count > limit {
            entries.removeFirst(entries.count - limit)
        }
        let body = entries.joined(separator: "\n")
        try? body.write(to: fileURL, atomically: false, encoding: .utf8)
    }

    public func latest() -> [String] { entries }
}
