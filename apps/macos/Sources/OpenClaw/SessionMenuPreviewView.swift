import OpenClawChatUI
import OpenClawKit
import OSLog
import SwiftUI

struct SessionPreviewItem: Identifiable {
    let id: String
    let role: PreviewRole
    let text: String
}

enum PreviewRole: String {
    case user
    case assistant
    case tool
    case system
    case other

    var label: String {
        switch self {
        case .user: "User"
        case .assistant: "Agent"
        case .tool: "Tool"
        case .system: "System"
        case .other: "Other"
        }
    }
}

actor SessionPreviewCache {
    static let shared = SessionPreviewCache()

    private struct CacheEntry {
        let snapshot: SessionMenuPreviewSnapshot
        let updatedAt: Date
    }

    private var entries: [String: CacheEntry] = [:]

    func cachedSnapshot(for sessionKey: String, maxAge: TimeInterval) -> SessionMenuPreviewSnapshot? {
        guard let entry = self.entries[sessionKey] else { return nil }
        guard Date().timeIntervalSince(entry.updatedAt) < maxAge else { return nil }
        return entry.snapshot
    }

    func store(snapshot: SessionMenuPreviewSnapshot, for sessionKey: String) {
        self.entries[sessionKey] = CacheEntry(snapshot: snapshot, updatedAt: Date())
    }

    func lastSnapshot(for sessionKey: String) -> SessionMenuPreviewSnapshot? {
        self.entries[sessionKey]?.snapshot
    }
}

actor SessionPreviewLimiter {
    static let shared = SessionPreviewLimiter(maxConcurrent: 2)

    private let maxConcurrent: Int
    private var available: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(maxConcurrent: Int) {
        let normalized = max(1, maxConcurrent)
        self.maxConcurrent = normalized
        self.available = normalized
    }

    func withPermit<T>(_ operation: () async throws -> T) async throws -> T {
        await self.acquire()
        defer { self.release() }
        if Task.isCancelled { throw CancellationError() }
        return try await operation()
    }

    private func acquire() async {
        if self.available > 0 {
            self.available -= 1
            return
        }
        await withCheckedContinuation { cont in
            self.waiters.append(cont)
        }
    }

    private func release() {
        if !self.waiters.isEmpty {
            self.waiters.removeFirst().resume()
            return
        }
        self.available = min(self.available + 1, self.maxConcurrent)
    }
}

struct SessionMenuPreviewSnapshot {
    let items: [SessionPreviewItem]
    let status: SessionMenuPreviewView.LoadStatus
}

struct SessionMenuPreviewView: View {
    let maxLines: Int
    let title: String
    let items: [SessionPreviewItem]
    let status: LoadStatus

    @Environment(\.menuItemHighlighted) private var isHighlighted

    enum LoadStatus: Equatable {
        case loading
        case ready
        case empty
        case error(String)
    }

    private var primaryColor: Color {
        if self.isHighlighted {
            return Color(nsColor: .selectedMenuItemTextColor)
        }
        return Color(nsColor: .labelColor)
    }

    private var secondaryColor: Color {
        if self.isHighlighted {
            return Color(nsColor: .selectedMenuItemTextColor).opacity(0.85)
        }
        return Color(nsColor: .secondaryLabelColor)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(self.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.secondaryColor)
                Spacer(minLength: 8)
            }

            switch self.status {
            case .loading:
                self.placeholder("Loading preview…")
            case .empty:
                self.placeholder("No recent messages")
            case let .error(message):
                self.placeholder(message)
            case .ready:
                if self.items.isEmpty {
                    self.placeholder("No recent messages")
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(self.items) { item in
                            self.previewRow(item)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.leading, 16)
        .padding(.trailing, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func previewRow(_ item: SessionPreviewItem) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Text(item.role.label)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(self.roleColor(item.role))
                .frame(width: 50, alignment: .leading)

            Text(item.text)
                .font(.caption)
                .foregroundStyle(self.primaryColor)
                .multilineTextAlignment(.leading)
                .lineLimit(self.maxLines)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func roleColor(_ role: PreviewRole) -> Color {
        if self.isHighlighted { return Color(nsColor: .selectedMenuItemTextColor).opacity(0.9) }
        switch role {
        case .user: return .accentColor
        case .assistant: return .secondary
        case .tool: return .orange
        case .system: return .gray
        case .other: return .secondary
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(self.primaryColor)
    }
}

enum SessionMenuPreviewLoader {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "SessionPreview")
    private static let previewTimeoutSeconds: Double = 4
    private static let cacheMaxAgeSeconds: TimeInterval = 30
    private static let previewMaxChars = 240

    private struct PreviewTimeoutError: LocalizedError {
        var errorDescription: String? {
            "preview timeout"
        }
    }

    static func prewarm(sessionKeys: [String], maxItems: Int) async {
        let keys = self.uniqueKeys(sessionKeys)
        guard !keys.isEmpty else { return }
        do {
            let payload = try await self.requestPreview(keys: keys, maxItems: maxItems)
            await self.cache(payload: payload, maxItems: maxItems)
        } catch {
            let errorDescription = String(describing: error)
            Self.logger.debug(
                "Session preview prewarm failed count=\(keys.count, privacy: .public) " +
                    "error=\(errorDescription, privacy: .public)")
        }
    }

    static func load(sessionKey: String, maxItems: Int) async -> SessionMenuPreviewSnapshot {
        if let cached = await SessionPreviewCache.shared.cachedSnapshot(
            for: sessionKey,
            maxAge: cacheMaxAgeSeconds)
        {
            return cached
        }

        do {
            let snapshot = try await self.fetchSnapshot(sessionKey: sessionKey, maxItems: maxItems)
            await SessionPreviewCache.shared.store(snapshot: snapshot, for: sessionKey)
            return snapshot
        } catch is CancellationError {
            return SessionMenuPreviewSnapshot(items: [], status: .loading)
        } catch {
            if let fallback = await SessionPreviewCache.shared.lastSnapshot(for: sessionKey) {
                return fallback
            }
            let errorDescription = String(describing: error)
            Self.logger.warning(
                "Session preview failed session=\(sessionKey, privacy: .public) " +
                    "error=\(errorDescription, privacy: .public)")
            return SessionMenuPreviewSnapshot(items: [], status: .error("Preview unavailable"))
        }
    }

    private static func fetchSnapshot(sessionKey: String, maxItems: Int) async throws -> SessionMenuPreviewSnapshot {
        let payload = try await self.requestPreview(keys: [sessionKey], maxItems: maxItems)
        if let entry = payload.previews.first(where: { $0.key == sessionKey }) ?? payload.previews.first {
            return self.snapshot(from: entry, maxItems: maxItems)
        }
        return SessionMenuPreviewSnapshot(items: [], status: .error("Preview unavailable"))
    }

    private static func requestPreview(
        keys: [String],
        maxItems: Int) async throws -> OpenClawSessionsPreviewPayload
    {
        let boundedItems = self.normalizeMaxItems(maxItems)
        let timeoutMs = Int(self.previewTimeoutSeconds * 1000)
        return try await SessionPreviewLimiter.shared.withPermit {
            try await AsyncTimeout.withTimeout(
                seconds: self.previewTimeoutSeconds,
                onTimeout: { PreviewTimeoutError() },
                operation: {
                    try await GatewayConnection.shared.sessionsPreview(
                        keys: keys,
                        limit: boundedItems,
                        maxChars: self.previewMaxChars,
                        timeoutMs: timeoutMs)
                })
        }
    }

    private static func snapshot(
        from entry: OpenClawSessionPreviewEntry,
        maxItems: Int) -> SessionMenuPreviewSnapshot
    {
        let items = self.previewItems(from: entry, maxItems: maxItems)
        let normalized = entry.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "ok":
            return SessionMenuPreviewSnapshot(items: items, status: items.isEmpty ? .empty : .ready)
        case "empty":
            return SessionMenuPreviewSnapshot(items: items, status: .empty)
        case "missing":
            return SessionMenuPreviewSnapshot(items: items, status: .error("Thread missing"))
        case "cold":
            return SessionMenuPreviewSnapshot(items: [], status: .error("History archived; open chat to restore"))
        default:
            return SessionMenuPreviewSnapshot(items: items, status: .error("Preview unavailable"))
        }
    }

    private static func cache(payload: OpenClawSessionsPreviewPayload, maxItems: Int) async {
        for entry in payload.previews {
            let snapshot = self.snapshot(from: entry, maxItems: maxItems)
            await SessionPreviewCache.shared.store(snapshot: snapshot, for: entry.key)
        }
    }

    private static func normalizeMaxItems(_ maxItems: Int) -> Int {
        max(1, min(maxItems, 50))
    }

    private static func previewItems(
        from entry: OpenClawSessionPreviewEntry,
        maxItems: Int) -> [SessionPreviewItem]
    {
        let boundedItems = self.normalizeMaxItems(maxItems)
        let built: [SessionPreviewItem] = entry.items.enumerated().compactMap { index, item in
            let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let role = PreviewRole(rawValue: item.role.lowercased()) ?? .other
            return SessionPreviewItem(id: "\(entry.key)-\(index)", role: role, text: text)
        }

        let trimmed = built.suffix(boundedItems)
        return Array(trimmed.reversed())
    }

    private static func uniqueKeys(_ keys: [String]) -> [String] {
        var seen = Set<String>()
        return keys.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}
