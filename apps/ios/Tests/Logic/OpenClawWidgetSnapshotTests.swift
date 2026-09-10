import Foundation
import OpenClawKit
import Testing

struct OpenClawWidgetSnapshotTests {
    private let now = Date(timeIntervalSince1970: 100_000)
    private let session = OpenClawNativeSessionRef(
        owner: OpenClawNativeOwnerRef(gatewayID: "gateway-two", profileID: "profile-two"),
        agentID: "agent-two",
        sessionKey: "agent:agent-two:chosen")

    @Test func `opens the exact selected session or run without changing identity`() {
        let selected = OpenClawNativeSessionRef(
            owner: OpenClawNativeOwnerRef(gatewayID: "gateway-e\u{301}", profileID: "profile-\u{e9}"),
            agentID: "agent-two",
            sessionKey: String(repeating: "s", count: 512))
        let run = OpenClawNativeRunRef(session: selected, runID: String(repeating: "r", count: 256))
        let sessionSnapshot = self.snapshot(.session(selected, sessionID: "generation-two", state: .running))
        let runSnapshot = self.snapshot(.run(run, sessionID: "generation-two", outcome: .completed))

        #expect(self.resolve(sessionSnapshot).openRequest == .session(selected))
        #expect(self.resolve(runSnapshot).openRequest == .inspect(run))
        #expect(self.resolve(sessionSnapshot).kind == .conversation)
        #expect(self.resolve(runSnapshot).kind == .run)
        #expect(runSnapshot.subject.sessionID == "generation-two")
        #expect(self.resolve(runSnapshot).openRequest?.session.owner != OpenClawNativeOwnerRef(
            gatewayID: "gateway-\u{e9}",
            profileID: "profile-\u{e9}"))
    }

    @Test(arguments: [
        OpenClawWidgetSnapshot.TerminalOutcome.completed, .failed, .cancelled, .timedOut,
    ])
    func `selected terminal facts retain their outcome while offline`(_ outcome: OpenClawWidgetSnapshot
        .TerminalOutcome)
    {
        let run = OpenClawNativeRunRef(session: self.session, runID: "selected-run")
        let result = self.resolve(
            self.snapshot(.run(run, sessionID: "generation-two", outcome: outcome)),
            availability: .offline)

        #expect(result.state == .terminal(outcome))
        #expect(result.freshness == .recent)
        #expect(result.isOffline)
        #expect(result.contextText.contains("Last known"))
        #expect(result.accessibilityLabel.contains("Offline"))
        #expect(result.openRequest == .inspect(run))
    }

    @Test(arguments: [
        (600.0 as TimeInterval?, "Offline, stale: "),
        (nil, "Offline, age unknown: "),
    ])
    func `compact status preserves offline and freshness before the outcome`(
        age: TimeInterval?,
        prefix: String)
    {
        for state in [
            OpenClawWidgetSnapshot.SessionState.queued, .running, .terminal(.completed),
        ] {
            let snapshot = OpenClawWidgetSnapshot(
                subject: .session(self.session, sessionID: "generation-two", state: state),
                label: "Chosen conversation",
                sourceRecordedAt: age.map { self.now.addingTimeInterval(-$0) },
                queryObservedAt: self.now)
            let result = self.resolve(snapshot, availability: .offline)

            #expect(result.statusText.hasPrefix(prefix))
            #expect(result.statusText.hasSuffix(result.state.text))
            #expect(result.accessibilityLabel.components(separatedBy: "Offline").count == 2)
            #expect(result.accessibilityLabel.components(separatedBy: prefix).count == 2)
            #expect(!result.contextText.localizedCaseInsensitiveContains("stale"))
            #expect(!result.contextText.localizedCaseInsensitiveContains("unknown"))
        }
    }

    @Test func `a running successor cannot describe the selected unmatched run`() {
        let run = OpenClawNativeRunRef(session: self.session, runID: "older-run")
        let aggregate = self.resolve(self.snapshot(.session(
            self.session,
            sessionID: "generation-two",
            state: .running)))
        let selected = self.resolve(self.snapshot(.run(run, sessionID: "generation-two", outcome: nil)))
        let queued = self.resolve(self.snapshot(.session(self.session, sessionID: "generation-two", state: .queued)))

        #expect(aggregate.state == .running)
        #expect(queued.state == .queued)
        #expect(selected.state == .unknown)
        #expect(selected.freshness == .unknown)
        #expect(selected.kind == .run)
        #expect(selected.recordedAt == nil)
        #expect(selected.openRequest == .inspect(run))
    }

    @Test(arguments: [
        (0.0, OpenClawWidgetPresentation.Freshness.recent),
        (299.0, .recent), (300.0, .stale), (86399.0, .stale), (86400.0, .expired),
    ])
    func `fact age controls stale and expiry boundaries`(
        age: TimeInterval,
        expected: OpenClawWidgetPresentation.Freshness)
    {
        let snapshot = self.snapshot(
            .session(self.session, sessionID: "generation-two", state: .terminal(.completed)),
            recordedAt: self.now.addingTimeInterval(-age))
        let result = self.resolve(snapshot)
        #expect(result.freshness == expected)
        if expected == .expired {
            #expect(result.state == .expired)
            #expect(result.statusText.hasPrefix("Check in OpenClaw"))
            #expect(result.kind == nil)
            #expect(result.label == nil)
            #expect(result.recordedAt == nil)
            #expect(result.openRequest == nil)
            #expect(!result.accessibilityLabel.contains("Chosen conversation"))
        } else {
            #expect(result.state == .terminal(.completed))
            if expected == .stale {
                #expect(result.statusText.hasPrefix("Stale: "))
            }
        }
    }

    @Test func `observation-only updates cannot renew recorded fact freshness`() {
        let subject = OpenClawWidgetSnapshot.Subject.session(
            self.session, sessionID: "generation-two", state: .terminal(.completed))
        let recordedAt = self.now.addingTimeInterval(-600)
        let previous = OpenClawWidgetSnapshot(
            subject: subject,
            label: "Chosen conversation",
            sourceRecordedAt: recordedAt,
            queryObservedAt: self.now.addingTimeInterval(-500))
        let polled = OpenClawWidgetSnapshot(
            subject: subject, label: "Chosen conversation", sourceRecordedAt: recordedAt, queryObservedAt: self.now)

        #expect(self.resolve(previous) == self.resolve(polled))
        #expect(self.resolve(polled).freshness == .stale)
        #expect(self.resolve(polled).recordedAt == recordedAt)
        let locale = Locale(identifier: "en_US")
        let format = Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale, timeZone: .gmt)
        #expect(self.resolve(polled).recordedTimeText(locale: locale, timeZone: .gmt) ==
            "Recorded \(recordedAt.formatted(format))")
    }

    @Test(arguments: [
        nil, Date(timeIntervalSince1970: 100_001), Date(timeIntervalSince1970: -1),
        Date(timeIntervalSince1970: .infinity), Date(timeIntervalSince1970: .nan),
    ] as [Date?])
    func `missing or invalid source time never implies freshness`(_ recordedAt: Date?) {
        let snapshot = OpenClawWidgetSnapshot(
            subject: .session(self.session, sessionID: "generation-two", state: .terminal(.completed)),
            label: "Chosen conversation",
            sourceRecordedAt: recordedAt,
            queryObservedAt: self.now)
        let result = self.resolve(snapshot)
        #expect(result.freshness == .unknown)
        #expect(result.recordedAt == nil)
        #expect(result.recordedTimeText(locale: Locale(identifier: "en_US"), timeZone: .gmt) == nil)
        #expect(result.state == .terminal(.completed))
        #expect(result.statusText.hasPrefix("Age unknown: "))
    }

    @Test(arguments: [OpenClawWidgetPresentation.Privacy.locked, .hidden])
    func `privacy hides labels outcomes requests and accessibility`(
        _ privacy: OpenClawWidgetPresentation.Privacy)
    {
        let result = self.resolve(
            self.snapshot(.session(self.session, sessionID: "generation-two", state: .terminal(.failed))),
            privacy: privacy,
            availability: .offline)
        #expect(result.state == (privacy == .locked ? .locked : .hidden))
        #expect(result.kind == nil)
        #expect(result.label == nil)
        #expect(result.recordedAt == nil)
        #expect(result.recordedTimeText(locale: Locale(identifier: "en_US"), timeZone: .gmt) == nil)
        #expect(result.openRequest == nil)
        #expect(result.freshness == .unknown)
        #expect(!result.isOffline)
        #expect(result.statusText == result.state.text)
        #expect(result.accessibilityLabel == result.statusText)
    }

    @Test(arguments: [
        OpenClawWidgetPresentation.Availability.unavailable, .permissionDenied, .ownerInvalidated,
    ])
    func `unavailable ownership suppresses previously recorded details`(
        _ availability: OpenClawWidgetPresentation.Availability)
    {
        let result = self.resolve(
            self.snapshot(.session(self.session, sessionID: "generation-two", state: .terminal(.completed))),
            availability: availability)
        #expect(result.state == (availability == .permissionDenied ? .permissionRequired : .unavailable))
        let recovery = availability == .permissionDenied ? "Authorize in OpenClaw" : "Open OpenClaw"
        #expect(result.statusText.hasPrefix(recovery))
        #expect(result.kind == nil)
        #expect(result.label == nil)
        #expect(result.recordedAt == nil)
        #expect(result.openRequest == nil)
        #expect(result.accessibilityLabel.components(separatedBy: recovery).count == 2)
        #expect(!result.accessibilityLabel.contains("Chosen conversation"))
        #expect(!result.accessibilityLabel.contains("Completed"))
    }

    @Test func `missing selection or generation cannot produce an open request`() {
        #expect(self.resolve(nil).state == .unconfigured)
        #expect(self.resolve(nil).statusText.hasPrefix("Edit widget to select"))
        let invalid = self.resolve(self.snapshot(.session(self.session, sessionID: "", state: .running)))
        #expect(invalid.state == .unavailable)
        #expect(invalid.openRequest == nil)
        let run = OpenClawNativeRunRef(session: self.session, runID: "selected-run")
        #expect(self.resolve(self.snapshot(.run(run, sessionID: "", outcome: .completed))).openRequest == nil)
    }

    @Test(arguments: [
        ("a", 96),
        ("\u{1F469}\u{200D}\u{1F4BB}", 34),
        ("e\u{301}", 96),
        ("a" + String(repeating: "\u{301}", count: 200), 0),
    ])
    func `labels respect character and byte caps without splitting graphemes`(unit: String, count: Int) {
        let input = String(repeating: unit, count: 100)
        let snapshot = OpenClawWidgetSnapshot(
            subject: .session(self.session, sessionID: "generation-two", state: .running),
            label: input,
            sourceRecordedAt: self.now,
            queryObservedAt: self.now)
        #expect(snapshot.label == String(repeating: unit, count: count))
        #expect(snapshot.label.count <= 96)
        #expect(snapshot.label.utf8.count <= 384)
        #expect(self.resolve(snapshot).openRequest == .session(self.session))
    }

    private func snapshot(
        _ subject: OpenClawWidgetSnapshot.Subject,
        recordedAt: Date? = nil) -> OpenClawWidgetSnapshot
    {
        OpenClawWidgetSnapshot(
            subject: subject,
            label: "Chosen conversation",
            sourceRecordedAt: recordedAt ?? self.now,
            queryObservedAt: self.now)
    }

    private func resolve(
        _ snapshot: OpenClawWidgetSnapshot?,
        privacy: OpenClawWidgetPresentation.Privacy = .visible,
        availability: OpenClawWidgetPresentation.Availability = .connected) -> OpenClawWidgetPresentation
    {
        OpenClawWidgetPresentation.resolve(
            snapshot: snapshot,
            now: self.now,
            staleAfter: 300,
            expiresAfter: 86400,
            privacy: privacy,
            availability: availability)
    }
}
