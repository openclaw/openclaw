import Foundation

final class CanvasFileWatcher: @unchecked Sendable {
    private let watcher: CoalescingFSEventsWatcher
    private let pollingWatcher: PollingDirectoryWatcher

    init(url: URL, onChange: @escaping () -> Void) {
        // Both producers can stop together from onChange without waiting on each other.
        let queue = DispatchQueue(label: "ai.openclaw.canvaswatcher")
        self.watcher = CoalescingFSEventsWatcher(
            paths: [url.path],
            queue: queue,
            onChange: onChange)
        self.pollingWatcher = PollingDirectoryWatcher(
            url: url,
            queue: queue,
            onChange: onChange)
    }

    func start() {
        self.startEventStream()
        self.setPollingEnabled(true)
    }

    func startEventStream() {
        self.watcher.start()
    }

    func setPollingEnabled(_ enabled: Bool) {
        if enabled {
            self.pollingWatcher.start()
        } else {
            self.pollingWatcher.stop()
        }
    }

    func stop() {
        self.watcher.stop()
        self.pollingWatcher.stop()
    }

    var isPolling: Bool {
        self.pollingWatcher.isRunning
    }
}

private final class PollingDirectoryWatcher: @unchecked Sendable {
    private struct FileSignature: Equatable {
        let modifiedAt: TimeInterval
        let size: Int
    }

    private let url: URL
    private let queue: DispatchQueue
    private let queueKey = DispatchSpecificKey<UInt8>()
    private let onChange: () -> Void
    private var timer: DispatchSourceTimer?
    private var lastSnapshot: [String: FileSignature] = [:]

    init(url: URL, queue: DispatchQueue, onChange: @escaping () -> Void) {
        self.url = url
        self.queue = queue
        self.onChange = onChange
        self.queue.setSpecific(key: self.queueKey, value: 1)
    }

    deinit {
        self.stop()
        self.queue.setSpecific(key: self.queueKey, value: nil)
    }

    func start() {
        self.onQueue {
            guard self.timer == nil else { return }
            self.lastSnapshot = self.snapshot()

            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 0.15, repeating: 0.25)
            timer.setEventHandler { [weak self] in
                self?.poll()
            }
            self.timer = timer
            timer.resume()
        }
    }

    func stop() {
        self.onQueue {
            self.timer?.cancel()
            self.timer = nil
            self.lastSnapshot = [:]
        }
    }

    var isRunning: Bool {
        self.onQueue {
            self.timer != nil
        }
    }

    private func onQueue<T>(_ action: () -> T) -> T {
        if DispatchQueue.getSpecific(key: self.queueKey) != nil {
            return action()
        }
        return self.queue.sync(execute: action)
    }

    private func poll() {
        guard self.timer != nil else { return }
        let next = self.snapshot()
        guard next != self.lastSnapshot else { return }
        self.lastSnapshot = next
        self.onChange()
    }

    private func snapshot() -> [String: FileSignature] {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        guard let enumerator = FileManager.default.enumerator(
            at: self.url,
            includingPropertiesForKeys: keys,
            options: [.skipsPackageDescendants])
        else { return [:] }

        var result: [String: FileSignature] = [:]
        for case let fileURL as URL in enumerator {
            guard let values = try? fileURL.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true
            else { continue }

            let relativePath = String(fileURL.path.dropFirst(self.url.path.count + 1))
            result[relativePath] = FileSignature(
                modifiedAt: values.contentModificationDate?.timeIntervalSinceReferenceDate ?? 0,
                size: values.fileSize ?? 0)
        }
        return result
    }
}
