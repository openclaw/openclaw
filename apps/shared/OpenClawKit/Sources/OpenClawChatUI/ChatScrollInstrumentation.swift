import os
import SwiftUI
#if DEBUG && os(iOS)
import ObjectiveC
import UIKit
#endif

private let chatScrollSignposter = OSSignposter(subsystem: "ai.openclawfoundation.app", category: "ChatScroll")

/// Instruments-visible intervals for the transcript's scroll-affecting work (category `ChatScroll`).
/// They ship: names are static strings and no message is formatted, so a disabled signposter costs a
/// branch.
public enum ChatScrollSignpost {
    static func interval<T>(_ name: StaticString, _ body: () throws -> T) rethrows -> T {
        let state = chatScrollSignposter.beginInterval(name)
        defer { chatScrollSignposter.endInterval(name, state) }
        return try body()
    }

    /// Toggles a disclosure inside `animation`; the interval ends when the animation completes,
    /// then `completion` runs.
    @MainActor
    static func disclosureToggle(
        _ animation: Animation?,
        _ toggle: () -> Void,
        completion: @escaping @MainActor () -> Void = {})
    {
        let state = chatScrollSignposter.beginInterval("DisclosureToggle")
        withAnimation(animation, toggle) {
            chatScrollSignposter.endInterval("DisclosureToggle", state)
            completion()
        }
    }

    /// Use as `.transaction(value: isPresented, ChatScrollSignpost.sidebarDrawer)`, inside the
    /// drawer's `.animation(_:value:)`: the interval spans the open or close animation.
    public static func sidebarDrawer(_ transaction: inout Transaction) {
        let state = chatScrollSignposter.beginInterval("SidebarDrawer")
        transaction.addAnimationCompletion {
            chatScrollSignposter.endInterval("SidebarDrawer", state)
        }
    }
}

/// An interval whose begin and end happen in different calls.
struct ChatScrollSignpostInterval {
    private let name: StaticString
    private var state: OSSignpostIntervalState?

    init(_ name: StaticString) {
        self.name = name
    }

    mutating func begin() {
        self.end()
        self.state = chatScrollSignposter.beginInterval(self.name)
    }

    mutating func end() {
        guard let state else { return }
        chatScrollSignposter.endInterval(self.name, state)
        self.state = nil
    }
}

#if os(iOS)
/// Names the code writing the transcript scroller's offset for the behavior probe's `offset`
/// events. Outside a DEBUG build launched with `--openclaw-behavior-probe` this is a direct call.
@MainActor
enum ChatScrollWriter {
    @inline(__always)
    static func perform<T>(_ tag: StaticString, _ body: () throws -> T) rethrows -> T {
        #if DEBUG
        guard ChatBehaviorProbe.isRecording else { return try body() }
        let previous = ChatScrollOffsetLog.tag
        ChatScrollOffsetLog.tag = tag
        defer { ChatScrollOffsetLog.tag = previous }
        #endif
        return try body()
    }

    /// Marks `scroll` as the transcript scroller whose offset writes are logged.
    @inline(__always)
    static func watch(_ scroll: UIScrollView) {
        #if DEBUG
        ChatScrollOffsetLog.watch(scroll)
        #endif
    }
}
#endif

#if DEBUG && os(iOS)
/// Swizzles `UIScrollView`'s `setContentOffset:`, `setContentOffset:animated:` and `setBounds:`
/// (origin changes the first two did not make), once and only while the probe records. Each write
/// on the watched scroller that moves y logs `{e:"offset", k:<writer>, v:"<oldY>-><newY>"}`;
/// animated writes log their target and suffix the writer with `~anim`. Untagged writes are `user`
/// while the scroller tracks, drags or decelerates, else `system:` plus the first caller frames
/// outside UIKit, QuartzCore, CoreFoundation, libdispatch and the runtime.
@MainActor
private enum ChatScrollOffsetLog {
    static var tag: StaticString?
    private weak static var transcript: UIScrollView?
    private static var depth = 0
    private static var installed = false

    private typealias SetPoint = @convention(c) (UIScrollView, Selector, CGPoint) -> Void
    private typealias SetPointAnimated = @convention(c) (UIScrollView, Selector, CGPoint, Bool) -> Void
    private typealias SetRect = @convention(c) (UIScrollView, Selector, CGRect) -> Void

    static func watch(_ scroll: UIScrollView) {
        guard ChatBehaviorProbe.isRecording else { return }
        self.transcript = scroll
        guard !self.installed else { return }
        self.installed = true
        self.install()
    }

    private static func install() {
        let setOffset = #selector(setter: UIScrollView.contentOffset)
        self.swizzle(setOffset) { imp in
            let original = unsafeBitCast(imp, to: SetPoint.self)
            let block: @convention(block) (UIScrollView, CGPoint) -> Void = { view, point in
                MainActor.assumeIsolated {
                    self.write(view, animated: false) { original(view, setOffset, point) }
                }
            }
            return block
        }
        let setOffsetAnimated = #selector(UIScrollView.setContentOffset(_:animated:))
        self.swizzle(setOffsetAnimated) { imp in
            let original = unsafeBitCast(imp, to: SetPointAnimated.self)
            let block: @convention(block) (UIScrollView, CGPoint, Bool) -> Void = { view, point, animated in
                MainActor.assumeIsolated {
                    self.write(view, animated: animated, target: point.y) {
                        original(view, setOffsetAnimated, point, animated)
                    }
                }
            }
            return block
        }
        let setBounds = #selector(setter: UIView.bounds)
        self.swizzle(setBounds) { imp in
            let original = unsafeBitCast(imp, to: SetRect.self)
            let block: @convention(block) (UIScrollView, CGRect) -> Void = { view, rect in
                MainActor.assumeIsolated {
                    guard self.depth == 0, view === self.transcript,
                          abs(rect.origin.y - view.bounds.origin.y) > 0.01
                    else { return original(view, setBounds, rect) }
                    self.write(view, animated: false) { original(view, setBounds, rect) }
                }
            }
            return block
        }
    }

    /// Replaces `selector` on UIScrollView itself; an inherited method gets an override instead,
    /// so the superclass (every UIView for `setBounds:`) is untouched.
    private static func swizzle(_ selector: Selector, _ make: (IMP) -> Any) {
        let cls: AnyClass = UIScrollView.self
        guard let method = class_getInstanceMethod(cls, selector) else { return }
        let replacement = imp_implementationWithBlock(make(method_getImplementation(method)))
        if !class_addMethod(cls, selector, replacement, method_getTypeEncoding(method)) {
            method_setImplementation(method, replacement)
        }
    }

    private static func write(
        _ view: UIScrollView,
        animated: Bool,
        target: CGFloat? = nil,
        _ apply: () -> Void)
    {
        guard self.depth == 0, view === self.transcript else { return apply() }
        let old = view.contentOffset.y
        self.depth += 1
        apply()
        self.depth -= 1
        let new = animated ? target ?? view.contentOffset.y : view.contentOffset.y
        guard abs(new - old) > 0.01 else { return }
        ChatBehaviorProbe.offset(
            self.writer(view, animated: animated),
            String(format: "%.1f->%.1f", Double(old), Double(new)))
    }

    private static func writer(_ view: UIScrollView, animated: Bool) -> String {
        if let tag {
            return animated ? "\(tag)~anim" : tag.description
        }
        // While the reader drags or flings, every untagged write is theirs (UIKit pan and
        // deceleration, the Gestures framework) except List's own compensation, which runs inside
        // SwiftUI's collection view update (`performBatchUpdates` / `layoutSubviews`).
        if view.isTracking || view.isDragging || view.isDecelerating, !self.isListUpdate() { return "user" }
        return "system:" + self.callerFrames()
    }

    /// Whether SwiftUI's List collection view is updating its rows above this write. Mangled
    /// symbols keep the type name, so no demangling is needed.
    private static func isListUpdate() -> Bool {
        for line in Thread.callStackSymbols.dropFirst() {
            if line.contains("UpdateCoalescingCollectionView") { return true }
            // Below the run loop is every main-thread stack.
            if line.contains(" CoreFoundation ") { return false }
        }
        return false
    }

    private static let skippedModules: Set<Substring> = [
        "UIKitCore", "UIKit", "QuartzCore", "CoreFoundation", "libdispatch.dylib", "libobjc.A.dylib",
        "GraphicsServices", "dyld", "libswift_Concurrency.dylib", "Foundation", "UpdateCycle",
    ]

    /// Up to three caller frames above the run loop as `Module.symbol`, capped at 240 characters.
    private static func callerFrames() -> String {
        var frames: [String] = []
        for line in Thread.callStackSymbols.dropFirst() {
            // "12  SwiftUI  0x00000001a2b3c4d5 $s7SwiftUI... + 40"
            let fields = line.split(separator: " ", maxSplits: 3)
            guard fields.count == 4 else { continue }
            // Below the run loop is every main-thread stack (UIApplicationMain, App.main, main).
            if fields[1] == "CoreFoundation" { break }
            guard !self.skippedModules.contains(fields[1]), !fields[1].hasPrefix("libsystem") else { continue }
            var symbol = fields[3]
            if let offset = symbol.range(of: " + ", options: .backwards) {
                symbol = symbol[..<offset.lowerBound]
            }
            let name = self.demangle(String(symbol))
            guard !name.contains("ChatScrollOffsetLog"), !name.contains("thunk"),
                  !name.contains("assumeIsolated") else { continue }
            frames.append("\(fields[1]).\(name.prefix(80))")
            if frames.count == 3 { break }
        }
        return frames.isEmpty ? "?" : String(frames.joined(separator: " < ").prefix(240))
    }

    private static func demangle(_ symbol: String) -> String {
        symbol.utf8CString.withUnsafeBufferPointer { buffer in
            guard let demangled = chatSwiftDemangle(buffer.baseAddress, UInt(buffer.count - 1), nil, nil, 0)
            else { return symbol }
            defer { free(demangled) }
            return String(cString: demangled)
        }
    }
}

@_silgen_name("swift_demangle")
private func chatSwiftDemangle(
    _ mangledName: UnsafePointer<CChar>?,
    _ mangledNameLength: UInt,
    _ outputBuffer: UnsafeMutablePointer<CChar>?,
    _ outputBufferSize: UnsafeMutablePointer<UInt>?,
    _ flags: UInt32) -> UnsafeMutablePointer<CChar>?
#endif
