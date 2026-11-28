import Foundation
import Observation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// One chat-wide state for the strip above the phone composer: one sentence and at most one action.
/// Owners post a status into their own slot (`id`) and clear it when it stops being true; the strip
/// shows the highest-priority status that is due, so a lower one comes back when a graver one clears.
public struct OpenClawChatStatus: Sendable {
    /// How the strip draws the leading mark. Progress is the system spinner; nothing is red.
    public enum Tone: Sendable {
        case progress
        case info
        case error
    }

    /// What, besides its owner, removes the status.
    public enum Clearing: Equatable, Sendable {
        /// Only the owner clears it, by posting again or calling `clear`.
        case byOwner
        /// Also leaves when the person sends a message.
        case onSend
        /// Also leaves by itself this long after it shows (longer with VoiceOver running).
        case after(Duration)
    }

    /// Whether the status belongs to the open chat or to the connection.
    public enum Scope: Sendable {
        /// Leaves when the person opens another chat.
        case chat
        /// Outlives chat switches; its owner clears it.
        case app
    }

    public struct Action: Sendable {
        public let title: String
        /// The strip shows a spinner in the action's place until this returns.
        public let perform: @MainActor @Sendable () async -> Void

        public init(title: String, perform: @escaping @MainActor @Sendable () async -> Void) {
            self.title = title
            self.perform = perform
        }
    }

    /// The owner's slot. Posting with the same id replaces that owner's earlier status.
    public var id: String
    public var priority: Int
    public var text: String
    /// A name inside `text` that shortens at its tail when the sentence would not fit on one line, so the
    /// rest of the sentence and the action stay whole.
    public var truncatable: String?
    public var tone: Tone
    public var action: Action?
    public var clearing: Clearing
    public var scope: Scope
    /// The status waits this long before it shows; a brief blip never reaches the screen.
    public var appearDelay: Duration

    public init(
        id: String,
        priority: Int,
        text: String,
        truncatable: String? = nil,
        tone: Tone,
        action: Action? = nil,
        clearing: Clearing = .byOwner,
        scope: Scope = .chat,
        appearDelay: Duration = .zero)
    {
        self.id = id
        self.priority = priority
        self.text = text
        self.truncatable = truncatable
        self.tone = tone
        self.action = action
        self.clearing = clearing
        self.scope = scope
        self.appearDelay = appearDelay
    }

    /// A status with an action spans the composer's width; one that only informs is a centered pill.
    public var isWide: Bool {
        self.action != nil
    }
}

extension OpenClawChatStatus: Equatable {
    /// Two statuses look and read the same; the action's closure is not part of what shows.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.priority == rhs.priority && lhs.text == rhs.text &&
            lhs.truncatable == rhs.truncatable && lhs.tone == rhs.tone &&
            lhs.action?.title == rhs.action?.title && lhs.clearing == rhs.clearing
    }
}

/// The board's priority table (F32), highest first. Owners outside it pick the row they sit beside.
public enum OpenClawChatStatusPriority {
    public static let unreachable = 100
    public static let notConnected = 90
    public static let reconnecting = 70
}

/// The one owner of what the strip above the composer shows. One per chat view model.
@MainActor
@Observable
public final class OpenClawChatStatusStrip {
    struct Entry: Equatable {
        var status: OpenClawChatStatus
        var postedAt: ContinuousClock.Instant
        /// Breaks priority ties: the later post wins.
        var order: UInt64
        /// Set for `.after`: when the status leaves by itself.
        var expiresAt: ContinuousClock.Instant?
    }

    private(set) var entries: [String: Entry] = [:]
    private var openSurfaces: Set<String> = []
    /// The app's toast, where the outcome of something the person just did goes: the strip holds only
    /// the chat's standing state. The phone app sets it.
    @ObservationIgnored public weak var toasts: OpenClawToastPresenter?
    private var nextOrder: UInt64 = 0
    /// Bumped when a delay or expiry falls due, so readers resolve again.
    private var tick = 0
    @ObservationIgnored private let now: () -> ContinuousClock.Instant
    @ObservationIgnored private let voiceOverRunning: () -> Bool
    @ObservationIgnored private var timers: [String: Task<Void, Never>] = [:]

    public convenience init() {
        self.init(now: { ContinuousClock.now }, voiceOverRunning: { OpenClawChatStatusStrip.isVoiceOverRunning })
    }

    init(now: @escaping () -> ContinuousClock.Instant, voiceOverRunning: @escaping () -> Bool) {
        self.now = now
        self.voiceOverRunning = voiceOverRunning
    }

    /// Every change the strip shows eases in one transaction, so the transcript above moves with the
    /// strip's row instead of jumping: no bounce, no travel of its own.
    static let animation: Animation = .smooth(duration: 0.24)

    /// What the strip shows now, if anything.
    public var current: OpenClawChatStatus? {
        _ = self.tick
        return Self.resolve(Array(self.entries.values), now: self.now())
    }

    /// Posts or replaces the owner's status. Reposting the same sentence keeps its place in time, so an
    /// owner can post on every change without restarting its delay or its timer.
    public func post(_ status: OpenClawChatStatus) {
        let at = self.now()
        if var existing = self.entries[status.id], existing.status == status {
            existing.status = status
            self.entries[status.id] = existing
            return
        }
        self.nextOrder &+= 1
        var expiresAt: ContinuousClock.Instant?
        if case let .after(duration) = status.clearing {
            expiresAt = at + status.appearDelay + (self.voiceOverRunning() ? duration * 2.5 : duration)
        }
        withAnimation(Self.animation) {
            self.entries[status.id] = Entry(status: status, postedAt: at, order: self.nextOrder, expiresAt: expiresAt)
        }
        self.schedule(id: status.id, delay: status.appearDelay, expiresAt: expiresAt, from: at)
    }

    public func clear(_ id: String) {
        self.timers.removeValue(forKey: id)?.cancel()
        guard self.entries[id] != nil else { return }
        withAnimation(Self.animation) { _ = self.entries.removeValue(forKey: id) }
    }

    /// A message went out: statuses that only last until the next send leave.
    public func didSend() {
        for (id, entry) in self.entries where entry.status.clearing == .onSend {
            self.clear(id)
        }
    }

    /// Another chat opened: statuses about the previous chat leave; connection states stay.
    func chatDidChange() {
        for (id, entry) in self.entries where entry.status.scope == .chat {
            self.clear(id)
        }
    }

    /// A sheet that shows its own failures in its footer opened or closed, so the toast doesn't repeat them.
    public func surfaceDidOpen(_ name: String) {
        self.openSurfaces.insert(name)
    }

    public func surfaceDidClose(_ name: String) {
        self.openSurfaces.remove(name)
    }

    func isSurfaceOpen(_ name: String) -> Bool {
        self.openSurfaces.contains(name)
    }

    /// The priority rule as a pure function: among statuses that are due and not expired, the highest
    /// priority wins, and the later post breaks a tie.
    nonisolated static func resolve(
        _ entries: [Entry],
        now: ContinuousClock.Instant) -> OpenClawChatStatus?
    {
        entries
            .filter { entry in
                now >= entry.postedAt + entry.status.appearDelay &&
                    entry.expiresAt.map { now < $0 } ?? true
            }
            .max { lhs, rhs in
                (lhs.status.priority, lhs.order) < (rhs.status.priority, rhs.order)
            }?
            .status
    }

    private func schedule(
        id: String,
        delay: Duration,
        expiresAt: ContinuousClock.Instant?,
        from start: ContinuousClock.Instant)
    {
        self.timers.removeValue(forKey: id)?.cancel()
        guard delay > .zero || expiresAt != nil else { return }
        self.timers[id] = Task { [weak self] in
            if delay > .zero {
                try? await Task.sleep(until: start + delay, clock: .continuous)
                guard !Task.isCancelled, let self else { return }
                withAnimation(Self.animation) { self.tick &+= 1 }
            }
            if let expiresAt {
                try? await Task.sleep(until: expiresAt, clock: .continuous)
                guard !Task.isCancelled, let self else { return }
                self.timers.removeValue(forKey: id)
                withAnimation(Self.animation) { _ = self.entries.removeValue(forKey: id) }
            }
        }
    }

    private static var isVoiceOverRunning: Bool {
        #if canImport(UIKit)
        UIAccessibility.isVoiceOverRunning
        #else
        false
        #endif
    }
}
