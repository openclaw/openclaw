import Foundation

final class ConfigFileWatcher: @unchecked Sendable {
    private let watcher: CoalescingFSEventsWatcher

    init(url: URL, onChange: @escaping () -> Void) {
        let watchedDirPath = url.deletingLastPathComponent().path
        let targetPath = url.path
        let targetName = url.lastPathComponent
        self.watcher = CoalescingFSEventsWatcher(
            paths: [watchedDirPath],
            queue: DispatchQueue(label: "ai.openclaw.configwatcher"),
            shouldNotify: { _, eventPaths in
                guard let eventPaths else { return true }
                let paths = unsafeBitCast(eventPaths, to: NSArray.self)
                for case let path as String in paths {
                    if path == targetPath { return true }
                    if path.hasSuffix("/\(targetName)") { return true }
                    if path == watchedDirPath { return true }
                }
                return false
            },
            onChange: onChange)
    }

    func start() {
        self.watcher.start()
    }

    func stop() {
        self.watcher.stop()
    }
}
