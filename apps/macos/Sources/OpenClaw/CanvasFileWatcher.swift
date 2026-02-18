import Foundation

final class CanvasFileWatcher: @unchecked Sendable {
    private let watcher: CoalescingFSEventsWatcher

    init(url: URL, onChange: @escaping () -> Void) {
        self.watcher = CoalescingFSEventsWatcher(
            paths: [url.path],
            queueLabel: "ai.openclaw.canvaswatcher",
            onChange: onChange)
    }

    deinit {
        self.stop()
    }

    func start() {
        self.watcher.start()
    }

    func stop() {
        self.watcher.stop()
    }
}
