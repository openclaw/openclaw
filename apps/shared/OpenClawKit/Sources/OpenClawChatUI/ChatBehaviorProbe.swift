import SwiftUI
#if DEBUG && os(iOS)
import QuartzCore
import UIKit
#endif

/// Frame probe for `pnpm ios:behavior`. With `--openclaw-behavior-probe` in a DEBUG iOS build it
/// writes `Library/Caches/behavior-probe.jsonl`: on every display frame where something moved, the
/// window-space top and bottom of each tagged view; plus mount, scroll-phase, body-evaluation and
/// mark events. Timestamps are Unix milliseconds so the host script can line them up with its own
/// actions. Every entry point is a no-op otherwise.
@MainActor
enum ChatBehaviorProbe {
    static func countBody(_ name: String) {
        #if DEBUG && os(iOS)
        ChatBehaviorRecorder.shared?.event(["e": "body", "k": name])
        #endif
    }

    /// Timestamps an app-side action (`send`) so the host can measure from it.
    static func mark(_ name: String) {
        #if DEBUG && os(iOS)
        ChatBehaviorRecorder.shared?.event(["e": "mark", "k": name])
        #endif
    }
}

/// A tagged view. Typed rather than string keys: string literals passed to a View helper read as
/// user-visible copy to the native i18n inventory.
enum ChatBehaviorProbeTarget {
    case composer
    case live
    case row(ChatTranscriptRow)

    /// `composer`, `live`, or the row's role (or `other`) and its stable id.
    var key: String {
        switch self {
        case .composer: "composer"
        case .live: "live"
        case let .row(.message(message)): "\(message.role.lowercased())/\(message.presentationID)"
        case let .row(row): "other/\(row.id)"
        }
    }
}

extension View {
    /// Records this view's on-screen frame and mounts. Release builds never build the key.
    @ViewBuilder
    func chatBehaviorProbe(_ target: ChatBehaviorProbeTarget) -> some View {
        #if DEBUG && os(iOS)
        if let recorder = ChatBehaviorRecorder.shared {
            let key = target.key
            onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { recorder.update(key, $0) }
                .onAppear { recorder.event(["e": "mount", "k": key]) }
                .onDisappear { recorder.unmount(key) }
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// Records user scroll phases, so the host can tell the reader's own motion from layout motion.
    @ViewBuilder
    func chatBehaviorProbeScroll() -> some View {
        #if DEBUG && os(iOS)
        if let recorder = ChatBehaviorRecorder.shared {
            onScrollPhaseChange { _, phase in
                recorder.event(["e": "phase", "v": String(describing: phase)])
            }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

#if DEBUG && os(iOS)
@MainActor
private final class ChatBehaviorRecorder: NSObject {
    static let shared: ChatBehaviorRecorder? =
        ProcessInfo.processInfo.arguments.contains("--openclaw-behavior-probe") ? ChatBehaviorRecorder() : nil

    private var frames: [String: CGRect] = [:]
    private var written: [String: CGRect] = [:]
    private var buffer = Data()
    private var lastFlush = CACurrentMediaTime()
    private let handle: FileHandle?
    /// Display-link timestamps use the media clock; convert once to Unix milliseconds.
    private let clockOffsetMs = Date().timeIntervalSince1970 * 1000 - CACurrentMediaTime() * 1000

    override private init() {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("behavior-probe.jsonl")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.handle = try? FileHandle(forWritingTo: url)
        super.init()
        self.event(["e": "start", "pid": Int(ProcessInfo.processInfo.processIdentifier)])
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(self.keyboardShow),
            name: UIResponder.keyboardWillShowNotification,
            object: nil)
        center.addObserver(
            self,
            selector: #selector(self.keyboardHide),
            name: UIResponder.keyboardWillHideNotification,
            object: nil)
    }

    @objc private func keyboardShow() {
        self.event(["e": "mark", "k": "keyboard-show"])
    }

    @objc private func keyboardHide() {
        self.event(["e": "mark", "k": "keyboard-hide"])
    }

    func update(_ key: String, _ rect: CGRect) {
        self.frames[key] = rect
    }

    func unmount(_ key: String) {
        self.frames[key] = nil
        self.event(["e": "unmount", "k": key])
    }

    func event(_ fields: [String: Any]) {
        var line = fields
        line["t"] = (Date().timeIntervalSince1970 * 1000).rounded()
        self.append(line)
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        if self.frames != self.written {
            var rects: [String: [Double]] = [:]
            for (key, rect) in self.frames {
                rects[key] = [Double(rect.minY), Double(rect.maxY)]
            }
            self.append(["t": (now * 1000 + self.clockOffsetMs).rounded(), "f": rects])
            self.written = self.frames
        }
        if now - self.lastFlush > 0.25 {
            self.flush()
            self.lastFlush = now
        }
    }

    private func append(_ line: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: line) else { return }
        self.buffer.append(data)
        self.buffer.append(0x0A)
    }

    private func flush() {
        guard !self.buffer.isEmpty else { return }
        try? self.handle?.write(contentsOf: self.buffer)
        self.buffer.removeAll(keepingCapacity: true)
    }
}
#endif
