import Foundation

struct PairedNode: Codable, Equatable {
    var nodeId: String
    var displayName: String?
    var platform: String?
    var version: String?
    var deviceFamily: String?
    var modelIdentifier: String?
    var token: String
    var createdAtMs: Int
    var lastSeenAtMs: Int?
}

actor PairedNodesStore {
    private let fileURL: URL
    private var nodes: [String: PairedNode] = [:]

    init(fileURL: URL) {
        self.fileURL = fileURL
    }

    func load() {
        do {
            let data = try Data(contentsOf: self.fileURL)
            let decoded = try JSONDecoder().decode([String: PairedNode].self, from: data)
            self.nodes = decoded
        } catch {
            self.nodes = [:]
        }
    }

    func all() -> [PairedNode] {
        self.nodes.values.sorted { a, b in (a.displayName ?? a.nodeId) < (b.displayName ?? b.nodeId) }
    }

    func find(nodeId: String) -> PairedNode? {
        self.nodes[nodeId]
    }

    func upsert(_ node: PairedNode) async throws {
        self.nodes[node.nodeId] = node
        try await self.persist()
    }

    func touchSeen(nodeId: String) async throws {
        guard var node = self.nodes[nodeId] else { return }
        node.lastSeenAtMs = Int(Date().timeIntervalSince1970 * 1000)
        self.nodes[nodeId] = node
        try await self.persist()
    }

    private func persist() async throws {
        let dir = self.fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(self.nodes)
        try data.write(to: self.fileURL, options: [.atomic])
    }
}
