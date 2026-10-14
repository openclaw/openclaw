import CoreServices
import Foundation

final class CoalescingFSEventsWatcher: @unchecked Sendable {
    private final class StreamContext {
        weak var watcher: CoalescingFSEventsWatcher?

        init(watcher: CoalescingFSEventsWatcher) {
            self.watcher = watcher
        }
    }

    private let queue: DispatchQueue
    private let queueKey = DispatchSpecificKey<UInt8>()
    // Stream lifecycle and pending notifications belong to the event queue.
    private var stream: FSEventStreamRef?
    private var pending: DispatchWorkItem?

    private let paths: [String]
    private let shouldNotify: (Int, UnsafeMutableRawPointer?) -> Bool
    private let onChange: () -> Void
    private let coalesceDelay: TimeInterval

    init(
        paths: [String],
        queue: DispatchQueue,
        coalesceDelay: TimeInterval = 0.12,
        shouldNotify: @escaping (Int, UnsafeMutableRawPointer?) -> Bool = { _, _ in true },
        onChange: @escaping () -> Void)
    {
        self.paths = paths
        self.queue = queue
        self.coalesceDelay = coalesceDelay
        self.shouldNotify = shouldNotify
        self.onChange = onChange
        self.queue.setSpecific(key: self.queueKey, value: 1)
    }

    deinit {
        self.stop()
        self.queue.setSpecific(key: self.queueKey, value: nil)
    }

    func start() {
        self.onQueue {
            self.startStream()
        }
    }

    func stop() {
        self.onQueue {
            self.pending?.cancel()
            self.pending = nil
            guard let stream = self.stream else { return }
            self.stream = nil
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    private func onQueue(_ action: () -> Void) {
        // A callback can stop or release its watcher on this same queue.
        if DispatchQueue.getSpecific(key: self.queueKey) != nil {
            action()
        } else {
            self.queue.sync(execute: action)
        }
    }

    private func startStream() {
        guard self.stream == nil else { return }

        let streamContext = StreamContext(watcher: self)
        let retainedContext = Unmanaged.passRetained(streamContext)
        var context = FSEventStreamContext(
            version: 0,
            info: retainedContext.toOpaque(),
            retain: nil,
            release: { pointer in
                guard let pointer else { return }
                Unmanaged<StreamContext>.fromOpaque(pointer).release()
            },
            copyDescription: nil)

        let paths = self.paths as CFArray
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents |
                kFSEventStreamCreateFlagUseCFTypes |
                kFSEventStreamCreateFlagNoDefer)

        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            Self.callback,
            &context,
            paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.05,
            flags)
        else {
            retainedContext.release()
            return
        }

        self.stream = stream
        FSEventStreamSetDispatchQueue(stream, self.queue)
        if FSEventStreamStart(stream) == false {
            self.stream = nil
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }
}

extension CoalescingFSEventsWatcher {
    private static let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, _, _ in
        guard let info else { return }
        let context = Unmanaged<StreamContext>.fromOpaque(info).takeUnretainedValue()
        context.watcher?.handleEvents(
            numEvents: numEvents,
            eventPaths: eventPaths)
    }

    private func handleEvents(
        numEvents: Int,
        eventPaths: UnsafeMutableRawPointer?)
    {
        guard self.stream != nil, numEvents > 0,
              self.shouldNotify(numEvents, eventPaths), self.pending == nil else { return }

        let notification = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pending = nil
            self.onChange()
        }
        self.pending = notification
        self.queue.asyncAfter(deadline: .now() + self.coalesceDelay, execute: notification)
    }
}
