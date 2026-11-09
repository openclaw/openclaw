import Foundation

/// A replaceable projection, never read truth. APNs carries invalidations, not badge values.
@MainActor
final class UnreadAppIconBadge {
    private struct Refresh {
        let revision: UInt64
        let read: @MainActor () async throws -> Int
    }

    private let apply: @MainActor (Int) async throws -> Void
    private var revision: UInt64 = 0
    private var pending: Refresh?
    private var worker: Task<Void, Never>?
    private var application: Task<Void, Never>?

    init(apply: @escaping @MainActor (Int) async throws -> Void) {
        self.apply = apply
    }

    /// Ordinary connection loss invalidates reads without inferring zero unread.
    func invalidate() {
        self.revision &+= 1
        self.pending = nil
    }

    /// Privacy resets must not wait for an offline read. No session is marked read.
    @discardableResult
    func reset() -> Task<Void, Never> {
        self.invalidate()
        return self.enqueueApplication(0)
    }

    func refresh(read: @escaping @MainActor () async throws -> Int) async {
        self.revision &+= 1
        self.pending = Refresh(revision: self.revision, read: read)
        if self.worker == nil {
            self.worker = Task { [weak self] in
                guard let self else { return }
                while let refresh = self.pending {
                    self.pending = nil
                    do {
                        let count = try await refresh.read()
                        guard refresh.revision == self.revision, count >= 0 else { continue }
                        await self.enqueueApplication(count, revision: refresh.revision).value
                    } catch {
                        // Failed/stale reads retain the last accepted projection. Foreground,
                        // reconnect, or the next invalidation retries the canonical owner.
                    }
                }
                self.worker = nil
            }
        }
        await self.worker?.value
        await self.application?.value
    }

    private func enqueueApplication(_ count: Int, revision: UInt64? = nil) -> Task<Void, Never> {
        let previous = self.application
        let task = Task { [weak self] in
            // An already-started old-scope OS write settles before its privacy reset.
            await previous?.value
            guard let self, revision == nil || revision == self.revision else { return }
            try? await self.apply(count)
        }
        self.application = task
        return task
    }
}
