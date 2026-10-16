import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct RootSidebarModelSessionEventsTests {
    @MainActor
    private final class Clock {
        var sleepers: [CheckedContinuation<Void, Never>] = []

        func sleep(_ delay: Duration) async throws {
            #expect(delay == .milliseconds(200))
            await withCheckedContinuation { self.sleepers.append($0) }
            try Task.checkCancellation()
        }

        func advance() {
            let sleepers = self.sleepers
            self.sleepers = []
            for sleeper in sleepers {
                sleeper.resume()
            }
        }
    }

    @MainActor
    private final class Loads {
        var rosters = 0
        var active = 0
        var maximumActive = 0
        var row = RootSidebarModelSessionEventsTests.row()
        var includeRow = true
        var hold = false
        var release: CheckedContinuation<Void, Never>?

        func loadRoster() async -> ChatSessionRosterSnapshot {
            self.rosters += 1
            self.active += 1
            self.maximumActive = max(self.maximumActive, self.active)
            let rows = self.includeRow ? [self.row] : []
            if self.hold {
                await withCheckedContinuation { self.release = $0 }
            }
            self.active -= 1
            return ChatSessionRosterSnapshot(sessions: rows, isCached: false)
        }
    }

    func eventBurst() async throws {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        await model.refreshSessions(appModel: appModel)
        loads.rosters = 0

        for index in 0..<20 {
            loads.row = Self.row(label: "Row \(index)")
            let frame = try Self.event(
                reason: index == 18 ? "groups" : "patch",
                row: [3, 7, 14, 18].contains(index) ? nil : loads.row)
            #expect(await model.handleSessionEvent(frame, appModel: appModel) == false)
            await Task.yield()
        }
        #expect(model.sessions.first?.label == "Row 19")
        #expect(clock.sleepers.count <= 1)
        await self.settle(clock: clock, until: { loads.rosters >= 1 && !model.isRefreshing })
        print("SESSION_EVENT_BURST rosterLoads=\(loads.rosters) events=20")
        #expect(loads.rosters == 1)
        #expect(loads.maximumActive == 1)
    }

    @Test func `complete row snapshot updates metadata without a list load`() async throws {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        await model.refreshSessions(appModel: appModel)
        loads.rosters = 0
        var row = Self.row(label: "Renamed")
        row.category = "Research"
        row.pinned = true
        row.totalTokens = 42
        row.color = "blue"
        _ = try await model.handleSessionEvent(Self.event(row: row), appModel: appModel)
        #expect(model.sessions.first?.label == "Renamed")
        #expect(model.sessions.first?.category == "Research")
        #expect(model.sessions.first?.pinned == true)
        #expect(model.sessions.first?.totalTokens == 42)
        #expect(model.sessions.first?.color == "blue")
        await Task.yield()
        #expect(clock.sleepers.isEmpty)
        #expect(loads.rosters == 0)
    }

    @Test func `in flight invalidations retain only one trailing roster load`() async throws {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        await model.refreshSessions(appModel: appModel)
        loads.rosters = 0
        loads.hold = true
        _ = try await model.handleSessionEvent(Self.event(), appModel: appModel)
        await self.settle(clock: clock, until: { loads.release != nil })
        for index in 0..<20 {
            _ = try await model.handleSessionEvent(
                Self.event(reason: index == 10 ? "groups" : "delete"), appModel: appModel)
        }
        #expect(loads.rosters == 1)
        loads.hold = false
        loads.release?.resume()
        loads.release = nil
        await self.settle(clock: clock, until: { loads.rosters == 2 && !model.isRefreshing })
        #expect(loads.rosters == 2)
        #expect(loads.maximumActive == 1)
    }

    @Test func `row patches arriving during a roster load survive without another fetch`() async throws {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        await model.refreshSessions(appModel: appModel)
        loads.rosters = 0
        loads.hold = true
        _ = try await model.handleSessionEvent(Self.event(), appModel: appModel)
        await self.settle(clock: clock, until: { loads.release != nil })
        _ = try await model.handleSessionEvent(Self.event(row: Self.row(label: "Live row")), appModel: appModel)
        #expect(model.sessions.first?.label == "Live row")
        loads.hold = false
        loads.release?.resume()
        loads.release = nil
        await self.settle(clock: clock, until: { !model.isRefreshing })
        #expect(model.sessions.first?.label == "Live row")
        #expect(loads.rosters == 1)
    }

    @Test func `live observer updates survive an in flight roster snapshot`() async throws {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        loads.row.status = "running"
        loads.row.hasActiveRun = true
        loads.row.activeRunIds = ["run-1"]
        loads.row.observerDigest = .init(
            runId: "run-1", revision: 1, updatedAt: 100, headline: "Old", health: "stuck")
        self.configure(model, clock: clock, loads: loads)
        await model.refreshSessions(appModel: appModel)
        loads.rosters = 0
        loads.hold = true
        _ = try await model.handleSessionEvent(Self.event(), appModel: appModel)
        await self.settle(clock: clock, until: { loads.release != nil })
        let digest = SessionObserverDigest(
            sessionkey: loads.row.key,
            runid: "run-1",
            revision: 2,
            updatedat: 200,
            headline: "Live",
            health: .stuck)
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(digest))
        _ = await model.handleSessionEvent(EventFrame(
            type: "event", event: "session.observer", payload: AnyCodable(payload)), appModel: appModel)
        #expect(model.sessions.first?.observerDigest?.headline == "Live")
        loads.hold = false
        loads.release?.resume()
        loads.release = nil
        await self.settle(clock: clock, until: { !model.isRefreshing })
        #expect(model.sessions.first?.observerDigest?.headline == "Live")
        #expect(loads.rosters == 1)
    }

    @Test func `unknown deleted archived and malformed rows refetch`() async throws {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        await model.refreshSessions(appModel: appModel)
        loads.rosters = 0
        var unknown = Self.row()
        unknown.key = "agent:main:unknown"
        var archived = Self.row()
        archived.archived = true
        for frame in try [
            Self.event(row: unknown),
            Self.event(reason: "delete", row: Self.row()),
            Self.event(row: archived),
            EventFrame(type: "event", event: "sessions.changed", payload: AnyCodable(["session": 7])),
        ] {
            _ = await model.handleSessionEvent(frame, appModel: appModel)
            await Task.yield()
        }
        await self.settle(clock: clock, until: { loads.rosters == 1 && !model.isRefreshing })
        #expect(loads.rosters == 1)
    }

    @Test func `connection and pull refresh load the roster`() async {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        await model.refresh(appModel: appModel)
        #expect(loads.rosters == 1)
        #expect(clock.sleepers.isEmpty)
    }

    @Test func `sequence gap keeps the immediate full refresh`() async {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        #expect(await model.handleSessionEvent(
            EventFrame(type: "event", event: "seqGap"), appModel: appModel))
        #expect(loads.rosters == 1)
        #expect(clock.sleepers.isEmpty)
    }

    @Test func `older roster snapshots do not overwrite a newer held row`() async {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        loads.row.updatedAt = 200
        loads.row.label = "Newer"
        await model.refreshSessions(appModel: appModel)
        loads.row.updatedAt = 100
        loads.row.label = "Older"
        await model.refreshSessions(appModel: appModel)
        #expect(model.sessions.first?.label == "Newer")
        #expect(model.sessions.first?.updatedAt == 200)
    }

    @Test func `delete invalidation clears a buffered row patch before roster replay`() async throws {
        let appModel = NodeAppModel()
        let model = RootSidebarModel()
        let clock = Clock()
        let loads = Loads()
        self.configure(model, clock: clock, loads: loads)
        await model.refreshSessions(appModel: appModel)
        loads.includeRow = false
        loads.hold = true
        _ = try await model.handleSessionEvent(Self.event(), appModel: appModel)
        await self.settle(clock: clock, until: { loads.release != nil })
        _ = try await model.handleSessionEvent(Self.event(row: Self.row(label: "Patched")), appModel: appModel)
        _ = try await model.handleSessionEvent(Self.event(reason: "delete"), appModel: appModel)
        loads.hold = false
        loads.release?.resume()
        loads.release = nil
        for _ in 0..<1000 {
            await Task.yield()
            if !model.isRefreshing { break }
        }
        #expect(model.sessions.isEmpty)
        await self.settle(clock: clock, until: { loads.rosters == 3 && !model.isRefreshing })
        #expect(model.sessions.isEmpty)
    }

    private func configure(_ model: RootSidebarModel, clock: Clock, loads: Loads) {
        model.sessionRefreshSleep = { try await clock.sleep($0) }
        model.testRosterLoad = { await loads.loadRoster() }
    }

    private func settle(clock: Clock, until complete: () -> Bool) async {
        for _ in 0..<1000 {
            clock.advance()
            await Task.yield()
            if complete() { return }
        }
        Issue.record("Scheduled session refresh did not settle")
    }

    private static func row(label: String = "Original") -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(
            key: "agent:main:work", kind: "direct", updatedAt: 100, sessionId: "work-id", label: label)
    }

    private static func event(
        reason: String = "patch", row: OpenClawChatSessionEntry? = nil) throws -> EventFrame
    {
        var payload: [String: Any] = ["sessionKey": row?.key ?? "agent:main:work", "reason": reason]
        if let row {
            payload["session"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(row))
        }
        return EventFrame(type: "event", event: "sessions.changed", payload: AnyCodable(payload))
    }
}

@MainActor
struct RootSidebarModelSessionBurstTests {
    @Test func `twenty events need one roster load`() async throws {
        try await RootSidebarModelSessionEventsTests().eventBurst()
    }
}
