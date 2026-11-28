import Foundation
import Observation
import SwiftUI

/// A short, transient message that something just happened where the person isn't looking.
///
/// The iPhone app shows one at a time, under the chat's top bar and above any sheet. Every action
/// a toast offers is also reachable somewhere else in the app; the toast is a shortcut.
public struct OpenClawToast {
    /// Picks the system notification haptic; a plain confirmation (Copied) plays none.
    public enum Kind: Equatable {
        case confirmation
        case success
        case warning
        case error
    }

    public struct Action {
        public let title: String
        public let perform: @MainActor () -> Void

        public init(title: String, perform: @escaping @MainActor () -> Void) {
            self.title = title
            self.perform = perform
        }

        public static func tryAgain(_ perform: @escaping @MainActor () -> Void) -> Action {
            Action(title: String(localized: "Try again"), perform: perform)
        }

        public static func undo(_ perform: @escaping @MainActor () -> Void) -> Action {
            Action(title: String(localized: "Undo"), perform: perform)
        }
    }

    public var text: String
    public var systemImage: String?
    public var kind: Kind
    public var action: Action?
    /// What VoiceOver reads once when the toast appears; defaults to the text.
    public var announcement: String?

    public init(
        _ text: String,
        systemImage: String? = nil,
        kind: Kind = .confirmation,
        action: Action? = nil,
        announcement: String? = nil)
    {
        self.text = text
        self.systemImage = systemImage
        self.kind = kind
        self.action = action
        self.announcement = announcement
    }

    public static func copied(_ text: String = String(localized: "Copied")) -> OpenClawToast {
        OpenClawToast(text, systemImage: "doc.on.doc")
    }

    public static func failure(_ text: String, retry: (@MainActor () -> Void)? = nil) -> OpenClawToast {
        OpenClawToast(
            text,
            systemImage: "exclamationmark.circle",
            kind: .error,
            action: retry.map(Action.tryAgain))
    }
}

/// The toast rules as plain state, so they can be tested without a clock or a view.
///
/// One toast at a time: a new one replaces the current one in place. About 2 s without an action and
/// about 5 s with one. A touch holds the timer. While an assistive technology that moves focus by
/// itself is running (VoiceOver, Switch Control), a toast with an action stays until it is dismissed.
public struct OpenClawToastSchedule {
    public static let plainLifetime: Duration = .seconds(2)
    public static let actionLifetime: Duration = .seconds(5)

    public struct Entry: Identifiable {
        public let id: Int
        public let toast: OpenClawToast
        /// When the toast leaves on its own; nil while it is held or when it stays until dismissed.
        public fileprivate(set) var deadline: ContinuousClock.Instant?
        /// Time left when a touch held the timer.
        fileprivate var remaining: Duration?
    }

    public private(set) var current: Entry?
    private var lastID = 0
    private var isHeld = false

    public init() {}

    public static func lifetime(for toast: OpenClawToast, assistiveTechnologyRunning: Bool) -> Duration? {
        guard toast.action != nil else { return self.plainLifetime }
        return assistiveTechnologyRunning ? nil : self.actionLifetime
    }

    /// Shows `toast`, replacing whatever is showing. Returns the new entry's id.
    @discardableResult
    public mutating func post(
        _ toast: OpenClawToast,
        at now: ContinuousClock.Instant,
        assistiveTechnologyRunning: Bool) -> Int
    {
        self.lastID += 1
        let lifetime = Self.lifetime(for: toast, assistiveTechnologyRunning: assistiveTechnologyRunning)
        var entry = Entry(id: self.lastID, toast: toast, deadline: nil, remaining: lifetime)
        if !self.isHeld, let lifetime {
            entry.deadline = now + lifetime
            entry.remaining = nil
        }
        self.current = entry
        return entry.id
    }

    /// A finger is on the capsule: the toast stays until the finger lifts.
    public mutating func hold(at now: ContinuousClock.Instant) {
        guard !self.isHeld else { return }
        self.isHeld = true
        guard var entry = self.current, let deadline = entry.deadline else { return }
        entry.remaining = max(.zero, deadline - now)
        entry.deadline = nil
        self.current = entry
    }

    /// The finger lifted: the toast gets back the time it had left.
    public mutating func release(at now: ContinuousClock.Instant) {
        guard self.isHeld else { return }
        self.isHeld = false
        guard var entry = self.current, let remaining = entry.remaining else { return }
        entry.deadline = now + remaining
        entry.remaining = nil
        self.current = entry
    }

    /// Removes the toast if its time is up. Returns true when it removed one.
    public mutating func expire(at now: ContinuousClock.Instant) -> Bool {
        guard let deadline = self.current?.deadline, now >= deadline else { return false }
        self.current = nil
        return true
    }

    /// Removes the toast `id`; a stale id (already replaced) does nothing.
    public mutating func dismiss(id: Int) {
        guard self.current?.id == id else { return }
        self.current = nil
        self.isHeld = false
    }
}

/// The one owner of the app's toast. Anything can post to it; the iPhone app draws what it holds.
@MainActor
@Observable
public final class OpenClawToastPresenter {
    public private(set) var schedule = OpenClawToastSchedule()
    @ObservationIgnored private var expiry: Task<Void, Never>?
    @ObservationIgnored private let assistiveTechnologyRunning: @MainActor () -> Bool

    public init(assistiveTechnologyRunning: @escaping @MainActor () -> Bool = { false }) {
        self.assistiveTechnologyRunning = assistiveTechnologyRunning
    }

    public var current: OpenClawToastSchedule.Entry? {
        self.schedule.current
    }

    public func post(_ toast: OpenClawToast) {
        self.schedule.post(toast, at: .now, assistiveTechnologyRunning: self.assistiveTechnologyRunning())
        self.armExpiry()
    }

    public func hold() {
        self.schedule.hold(at: .now)
        self.armExpiry()
    }

    public func release() {
        self.schedule.release(at: .now)
        self.armExpiry()
    }

    public func dismiss(id: Int) {
        self.schedule.dismiss(id: id)
        self.armExpiry()
    }

    /// Runs the toast's action, then dismisses it.
    public func performAction(id: Int) {
        guard let entry = self.current, entry.id == id, let action = entry.toast.action else { return }
        self.dismiss(id: id)
        action.perform()
    }

    private func armExpiry() {
        self.expiry?.cancel()
        guard let deadline = self.schedule.current?.deadline else { return }
        self.expiry = Task { @MainActor [weak self] in
            try? await Task.sleep(until: deadline, clock: .continuous)
            guard !Task.isCancelled, let self else { return }
            _ = self.schedule.expire(at: .now)
        }
    }
}

extension EnvironmentValues {
    /// Set by the iPhone app. Nil elsewhere (macOS keeps its own feedback), so callers branch on it.
    @Entry public var openClawToastPresenter: OpenClawToastPresenter?
}
