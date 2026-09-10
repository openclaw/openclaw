import Foundation
import OpenClawKit

struct OpenClawWidgetSnapshot: Sendable {
    enum TerminalOutcome: Equatable, Sendable {
        case completed, failed, cancelled, timedOut
    }

    enum SessionState: Sendable {
        case unknown, queued, running, terminal(TerminalOutcome)
    }

    enum Subject: Sendable {
        case session(OpenClawNativeSessionRef, sessionID: String, state: SessionState)
        case run(OpenClawNativeRunRef, sessionID: String, outcome: TerminalOutcome?)

        var sessionID: String {
            switch self {
            case let .session(_, sessionID, _), let .run(_, sessionID, _): sessionID
            }
        }

        fileprivate var openRequest: OpenClawNativeOpenRequest {
            switch self {
            case let .session(reference, _, _): .session(reference)
            case let .run(reference, _, _): .inspect(reference)
            }
        }

        fileprivate var state: OpenClawWidgetPresentation.State {
            switch self {
            case .session(_, _, .unknown), .run(_, _, nil): .unknown
            case .session(_, _, .queued): .queued
            case .session(_, _, .running): .running
            case let .session(_, _, .terminal(outcome)), let .run(_, _, outcome?): .terminal(outcome)
            }
        }

        fileprivate var kind: OpenClawWidgetPresentation.Kind {
            switch self {
            case .session: .conversation
            case .run: .run
            }
        }
    }

    let subject: Subject
    let label: String
    // A fact-owned timestamp, not sessions.status observedAt or the row's updatedAt.
    // A poll or projection rewrite must never make unchanged facts look newer.
    let sourceRecordedAt: Date?
    let queryObservedAt: Date

    init(subject: Subject, label: String, sourceRecordedAt: Date?, queryObservedAt: Date) {
        self.subject = subject
        self.label = Self.boundedLabel(label)
        self.sourceRecordedAt = sourceRecordedAt
        self.queryObservedAt = queryObservedAt
    }

    private static func boundedLabel(_ label: String) -> String {
        var result = ""
        var byteCount = 0
        for character in label.prefix(96) {
            let text = String(character)
            guard byteCount + text.utf8.count <= 384 else { break }
            result.append(character)
            byteCount += text.utf8.count
        }
        return result
    }
}

struct OpenClawWidgetPresentation: Equatable, Sendable {
    enum Kind: Sendable {
        case conversation, run

        var text: String {
            switch self {
            case .conversation: String(localized: "Conversation")
            case .run: String(localized: "Run")
            }
        }
    }

    enum State: Equatable, Sendable {
        case unknown, queued, running, terminal(OpenClawWidgetSnapshot.TerminalOutcome)
        case unconfigured, unavailable, permissionRequired, locked, hidden, expired

        var text: String {
            switch self {
            case .unknown: String(localized: "Unknown")
            case .queued: String(localized: "Queued")
            case .running: String(localized: "Running")
            case .terminal(.completed): String(localized: "Completed")
            case .terminal(.failed): String(localized: "Failed")
            case .terminal(.cancelled): String(localized: "Cancelled")
            case .terminal(.timedOut): String(localized: "Timed out")
            case .unconfigured: String(localized: "No selection")
            case .unavailable: String(localized: "Unavailable")
            case .permissionRequired: String(localized: "Access required")
            case .locked: String(localized: "Unlock to view")
            case .hidden: String(localized: "Details hidden")
            case .expired: String(localized: "Status expired")
            }
        }
    }

    enum Freshness: Sendable {
        case unknown, recent, stale, expired
    }

    enum Privacy: Sendable {
        case visible, locked, hidden
    }

    enum Availability: Sendable {
        case connected, offline, unavailable, permissionDenied, ownerInvalidated
    }

    let state: State
    let freshness: Freshness
    let kind: Kind?
    let label: String?
    let recordedAt: Date?
    let isOffline: Bool
    let contextText: String
    let openRequest: OpenClawNativeOpenRequest?

    var statusText: String {
        // Compact families omit context; put qualifications before the outcome
        // so truncation cannot make last-known facts appear live.
        switch (self.state, self.isOffline, self.freshness) {
        case (.unconfigured, _, _): String(localized: "Edit widget to select")
        case (.unavailable, _, _): String(localized: "Open OpenClaw")
        case (.permissionRequired, _, _): String(localized: "Authorize in OpenClaw")
        case (.expired, _, _): String(localized: "Check in OpenClaw")
        case (.locked, _, _), (.hidden, _, _): self.state.text
        case (_, true, .stale): String(localized: "Offline, stale: \(self.state.text)")
        case (_, true, .unknown) where self.state != .unknown:
            String(localized: "Offline, age unknown: \(self.state.text)")
        case (_, true, _): String(localized: "Offline: \(self.state.text)")
        case (_, false, .stale): String(localized: "Stale: \(self.state.text)")
        case (_, false, .unknown) where self.state != .unknown:
            String(localized: "Age unknown: \(self.state.text)")
        default: self.state.text
        }
    }

    var accessibilityLabel: String {
        self.accessibilityLabel(locale: .current, timeZone: .current)
    }

    var title: String? {
        self.label ?? self.kind?.text
    }

    func recordedTimeText(locale: Locale, timeZone: TimeZone) -> String? {
        guard let recordedAt = self.recordedAt else { return nil }
        let format = Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale, timeZone: timeZone)
        return String(localized: "Recorded \(recordedAt.formatted(format))", locale: locale)
    }

    func accessibilityLabel(locale: Locale, timeZone: TimeZone) -> String {
        [
            self.kind?.text,
            self.label,
            self.statusText,
            self.contextText,
            self.recordedTimeText(locale: locale, timeZone: timeZone),
        ]
            .compactMap(\.self)
            .filter { !$0.isEmpty }
            .joined(separator: ". ")
    }

    static func resolve(
        snapshot: OpenClawWidgetSnapshot?,
        now: Date,
        staleAfter: TimeInterval,
        expiresAfter: TimeInterval,
        privacy: Privacy,
        availability: Availability) -> Self
    {
        switch privacy {
        case .locked: return self.suppressed(.locked)
        case .hidden: return self.suppressed(.hidden)
        case .visible: break
        }
        switch availability {
        case .unavailable, .ownerInvalidated: return self.suppressed(.unavailable)
        case .permissionDenied: return self.suppressed(.permissionRequired)
        case .connected, .offline: break
        }
        guard let snapshot else { return self.suppressed(.unconfigured) }
        // A selected run is bound to the captured transcript generation even
        // though A's open request carries only the canonical logical selectors.
        guard !snapshot.subject.sessionID.isEmpty else { return self.suppressed(.unavailable) }

        let state = snapshot.subject.state
        let freshness = state == .unknown ? .unknown : self.freshness(
            recordedAt: snapshot.sourceRecordedAt,
            now: now,
            staleAfter: staleAfter,
            expiresAfter: expiresAfter)
        guard freshness != .expired else { return self.suppressed(.expired, freshness: .expired) }

        let isOffline = availability == .offline
        let context = if state == .unknown {
            String(localized: "No recorded status")
        } else if freshness == .recent, !isOffline {
            ""
        } else {
            String(localized: "Last known")
        }
        return Self(
            state: state,
            freshness: freshness,
            kind: snapshot.subject.kind,
            label: snapshot.label.isEmpty ? nil : snapshot.label,
            recordedAt: freshness == .recent || freshness == .stale ? snapshot.sourceRecordedAt : nil,
            isOffline: isOffline,
            contextText: context,
            openRequest: snapshot.subject.openRequest)
    }

    private static func suppressed(_ state: State, freshness: Freshness = .unknown) -> Self {
        let context = switch state {
        case .unconfigured, .unavailable, .permissionRequired, .expired: state.text
        default: ""
        }
        return Self(
            state: state,
            freshness: freshness,
            kind: nil,
            label: nil,
            recordedAt: nil,
            isOffline: false,
            contextText: context,
            openRequest: nil)
    }

    private static func freshness(
        recordedAt: Date?,
        now: Date,
        staleAfter: TimeInterval,
        expiresAfter: TimeInterval) -> Freshness
    {
        guard staleAfter.isFinite, expiresAfter.isFinite, staleAfter >= 0, expiresAfter > staleAfter,
              let recordedAt,
              recordedAt.timeIntervalSince1970.isFinite, recordedAt.timeIntervalSince1970 >= 0,
              now.timeIntervalSince1970.isFinite, recordedAt <= now
        else { return .unknown }
        let age = now.timeIntervalSince(recordedAt)
        if age >= expiresAfter { return .expired }
        return age >= staleAfter ? .stale : .recent
    }
}
