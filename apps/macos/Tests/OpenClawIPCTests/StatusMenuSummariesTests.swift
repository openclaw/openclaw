import AppKit
import ConcurrencyExtras
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct StatusMenuSummariesTests {
    @Test func `Automations shows the full enabled count beyond its preview`() async throws {
        try await self.withFixture(cronJobCount: 201) { fixture in
            _ = try await fixture.control.request(method: "health")
            try #require(fixture.control.state == .connected)
            let lease = try #require(await fixture.gateway.captureServerLease())
            await fixture.cron.refreshJobs()
            let jobs = fixture.cron.summary.jobs
            _ = AppKitTestSupport.application
            let item = NSMenuItem()
            fixture.summaries.configureAutomations(item)
            let preview = try #require(item.submenu).items.filter {
                ($0.representedObject as? String)?.hasPrefix("cron.job.") == true
            }
            let row = try #require(item.view)
            let window = NSWindow(contentRect: row.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = row
            defer {
                window.orderOut(nil)
                window.contentView = nil
                window.close()
                item.view = nil
            }
            window.orderFront(nil)
            row.layoutSubtreeIfNeeded()
            let elements = try await AppKitTestSupport.accessibilityElements(in: row)
            let texts = elements.filter { $0.accessibilityRole?() == .staticText }.compactMap {
                let value: Any? = $0.accessibilityValue?()
                return value as? String
            }
            try #require(fixture.gateway.serverLeaseMatchesCurrentRoute(lease))
            try #require(!jobs.isEmpty)
            try #require(fixture.requests.value.contains { $0.method == "cron.list" && $0.owner == "A" })
            try #require(preview.count == 8)
            let text = try #require(texts.first { $0.hasPrefix("\(item.title), ") })
            #expect(text == "\(item.title), 201")
        }
    }

    @Test func `cost requests use the Mac time zone`() async throws {
        try await self.withFixture { fixture in
            try await fixture.populate()
            let request = try #require(fixture.requests.value.first { $0.method == "usage.cost" })
            #expect(request.dateMode == "specific")
            #expect(request.timeZone == TimeZone.current.identifier)
        }
    }

    @Test
    func `retiring a Gateway invalidates the observed usage cache`() async throws {
        try await self.withFixture { fixture in
            try await fixture.populate()
            // Reopen the fresh cache so no pending result can supply an unrelated invalidation.
            fixture.summaries.menuDidClose()
            fixture.summaries.refresh {}
            _ = try await fixture.control.request(method: "health")
            let changed = AsyncTestGate()
            withObservationTracking {
                _ = fixture.summaries.usageSummary
            } onChange: {
                changed.open()
            }
            fixture.revision.setValue(2)
            await fixture.gateway.shutdown()
            try await changed.wait("usage cache invalidation")
            #expect(fixture.summaries.usageSummary == nil)
            #expect(!fixture.hasCostChart)
        }
    }

    @Test(arguments: ["unchanged", "reconnect", "replacement"])
    func `cached usage and cost belong to their selected Gateway`(_ transition: String) async throws {
        try await self.withFixture { fixture in
            try await fixture.populate()
            fixture.summaries.menuDidClose()
            let lease = try #require(await fixture.gateway.captureServerLease())
            if transition == "replacement" {
                fixture.revision.setValue(2)
            } else if transition == "reconnect" {
                fixture.session.latestTask()?.emitReceiveFailure()
                try await TestWait.state("retired usage server lease") {
                    !fixture.gateway.serverLeaseMatchesCurrentState(lease)
                }
                _ = try await fixture.gateway.acquireServerLease()
            }

            // AppKit renders these cached values before any asynchronous refresh.
            #expect((fixture.summaries.usageSummary != nil) == (transition != "replacement"))
            #expect(fixture.summaries.hasUsage == (transition != "replacement"))
            #expect(fixture.hasCostChart == (transition != "replacement"))
        }
    }

    @Test(arguments: ["unchanged", "reconnect", "replacement"])
    func `session menu caches belong to their selected Gateway`(_ transition: String) async throws {
        try await self.withFixture { fixture in
            _ = try await fixture.control.request(method: "health")
            await fixture.sessions.refresh()
            #expect(fixture.sessions.rows.map(\.label) == ["Gateway A"])
            if transition == "replacement" {
                fixture.revision.setValue(2)
            } else if transition == "reconnect" {
                try await fixture.reconnect()
            }

            // The menu projects these values before refreshing over the network.
            #expect((fixture.sessions.cachedSnapshot != nil) == (transition != "replacement"))
            #expect(fixture.sessions.rows.map(\.label) == (transition == "replacement" ? [] : ["Gateway A"]))
            _ = try await fixture.control.request(method: "health")
            await fixture.sessions.refresh()
            #expect(fixture.sessions.rows.map(\.label) == [transition == "replacement" ? "Gateway B" : "Gateway A"])
            #expect(fixture.requests.value.filter { $0.method == "sessions.list" }.count ==
                (transition == "replacement" ? 2 : 1))
        }
    }

    @Test(arguments: ["unchanged", "reconnect", "replacement", "failed-replacement"])
    func `session previews never reuse another Gateway history`(_ transition: String) async throws {
        try await self.withFixture { fixture in
            _ = try await fixture.control.request(method: "health")
            let first = await SessionMenuPreviewLoader.load(sessionKey: "main", maxItems: 10, gateway: fixture.gateway)
            #expect(first.items.map(\.text) == ["Gateway A"])
            if transition.hasSuffix("replacement") {
                fixture.revision.setValue(2)
                fixture.previewFails.setValue(transition == "failed-replacement")
            } else if transition == "reconnect" {
                try await fixture.reconnect()
            }

            _ = try await fixture.control.request(method: "health")
            let next = await SessionMenuPreviewLoader.load(sessionKey: "main", maxItems: 10, gateway: fixture.gateway)
            let expected = transition == "failed-replacement" ? [] :
                [transition == "replacement" ? "Gateway B" : "Gateway A"]
            #expect(next.items.map(\.text) == expected)
            if transition == "failed-replacement" {
                #expect(next.status == .error("Preview unavailable"))
            }
            #expect(fixture.requests.value.filter { $0.method == "sessions.preview" }.count ==
                (transition.hasSuffix("replacement") ? 2 : 1))
        }
    }

    @Test(arguments: ["unchanged", "reconnect", "before-action", "during-confirmation"], [false, true])
    func `session actions retain the rendered Gateway through confirmation`(
        transition: String,
        nestedMenu: Bool) async throws
    {
        try await self.withFixture { fixture in
            _ = try await fixture.control.request(method: "health")
            await fixture.sessions.refresh()
            let row = try #require(fixture.sessions.rows.first)
            let item = NSMenuItem()
            fixture.sessions.configureSessionItem(item, row: row)
            func actionItem() throws -> NSMenuItem {
                let menu = try #require(item.submenu)
                if nestedMenu {
                    let thinking = try #require(menu.items.first { $0.identifier?.rawValue == "session.thinking" })
                    return try #require(thinking.submenu?.items.first)
                }
                return try #require(menu.items.first { $0.action == NSSelectorFromString("resetSession:") })
            }
            let request = nestedMenu
                ? OpenClawChatGatewayRequests.patchSessionSettings(
                    sessionKey: row.key, agentID: nil, thinkingLevel: .some("off"), verboseLevel: nil)
                : OpenClawChatGatewayRequests.resetSession(sessionKey: row.key, agentID: nil)
            if transition == "before-action" {
                fixture.revision.setValue(2)
                _ = try await fixture.control.request(method: "health")
            } else if transition == "reconnect" {
                try await fixture.reconnect()
            }

            var confirmations = 0
            try await fixture.sessions.performSessionAction(
                actionItem(), request: request, errorTitle: "Synthetic action failed")
            {
                confirmations += 1
                if transition == "during-confirmation" {
                    fixture.revision.setValue(2)
                    _ = try? await fixture.control.request(method: "health")
                }
                return true
            }

            #expect(confirmations == (transition == "before-action" ? 0 : 1))
            let replaced = transition == "before-action" || transition == "during-confirmation"
            #expect(fixture.requests.value.filter { $0.method == request.method }.map(\.owner) ==
                (replaced ? [] : ["A"]))
            if replaced {
                await fixture.sessions.refresh(force: true)
                try fixture.sessions.configureSessionItem(item, row: #require(fixture.sessions.rows.first))
                try await fixture.sessions.performSessionAction(
                    actionItem(), request: request, errorTitle: "Synthetic action failed")
                #expect(fixture.requests.value.filter { $0.method == request.method }.map(\.owner) == ["B"])
            }
        }
    }

    @Test(arguments: [false, true])
    func `new Primary refreshes usage inside the previous Gateway cache window`(keepMenuOpen: Bool) async throws {
        try await self.withFixture { fixture in
            try await fixture.populate()
            if !keepMenuOpen { fixture.summaries.menuDidClose() }
            fixture.revision.setValue(2)
            _ = try await fixture.control.request(method: "health")
            if !keepMenuOpen { fixture.summaries.refresh {} }

            try await TestWait.state("Gateway B usage and cost request") {
                fixture.summaries.usageSummary?.contains("Gateway B") == true &&
                    fixture.requests.value.contains { $0.owner == "B" && $0.method == "usage.cost" }
            }
            #expect(fixture.requests.value.contains { $0.owner == "B" && $0.method == "usage.status" })
            #expect(!fixture.hasCostChart)
        }
    }

    @Test func `cold usage retry belongs to its visible Gateway`() async throws {
        try await self.withFixtures(count: 3) { fixtures in
            // Each Gateway owns its retry timer; share only the isolated app state.
            async let unchanged: Void = self.checkColdUsageRetry("unchanged", fixture: fixtures[0])
            async let replacement: Void = self.checkColdUsageRetry("replacement", fixture: fixtures[1])
            async let closed: Void = self.checkColdUsageRetry("closed", fixture: fixtures[2])
            _ = try await (unchanged, replacement, closed)
        }
    }

    private func checkColdUsageRetry(
        _ transition: String,
        fixture: UsageGatewayFixture,
        sourceLocation: SourceLocation = #_sourceLocation) async throws
    {
        fixture.coldUsage.setValue(true)
        _ = try await fixture.control.request(method: "health")
        var usageUpdated = false
        let usageChanged = AsyncTestSignal()
        fixture.summaries.refresh {
            usageUpdated = true
            usageChanged.notify()
        }
        try await usageChanged.wait("\(transition) initial cold usage response", sourceLocation: sourceLocation) {
            usageUpdated && fixture.requests.value.contains { $0.method == "usage.status" }
        }
        fixture.releaseCostResponses(for: "A")
        if transition == "closed" {
            fixture.summaries.menuDidClose()
            try await Task.sleep(for: .milliseconds(5200))
            #expect(fixture.requests.value.filter { $0.method == "usage.status" }.count == 1, "closed Gateway")
            return
        }
        let owner = transition == "replacement" ? "B" : "A"
        if transition == "replacement" {
            usageUpdated = false
            fixture.revision.setValue(2)
            _ = try await fixture.control.request(method: "health")
            try await usageChanged.wait("Gateway B cold usage response", sourceLocation: sourceLocation) {
                usageUpdated && fixture.requests.value.contains { $0.method == "usage.status" && $0.owner == "B" }
            }
            fixture.releaseCostResponses(for: "B")
        }
        // The five-second retry starts after the cold usage response is published.
        try await TestWait.state("\(transition) usage retry from Gateway \(owner)", sourceLocation: sourceLocation) {
            fixture.summaries.usageSummary?.contains("Gateway \(owner)") == true
        }
        #expect(
            fixture.requests.value.filter { $0.method == "usage.status" && $0.owner == owner }.count == 2,
            "\(transition) Gateway")
        #expect(!fixture.summaries.isUsageStalled, "\(transition) Gateway")
    }

    private func withFixture(
        cronJobCount: Int = 0,
        _ operation: (UsageGatewayFixture) async throws -> Void) async throws
    {
        try await self.withFixtures(count: 1, cronJobCount: cronJobCount) { fixtures in
            try await operation(fixtures[0])
        }
    }

    private func withFixtures(
        count: Int,
        cronJobCount: Int = 0,
        _ operation: ([UsageGatewayFixture]) async throws -> Void) async throws
    {
        try await TestIsolation.withIsolatedState {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            let previousAccent = state.profileAccentHex
            state.connectionMode = .unconfigured
            defer {
                state.connectionMode = previousMode
                state.profileAccentHex = previousAccent
            }
            let fixtures = (0..<count).map { _ in UsageGatewayFixture(cronJobCount: cronJobCount) }
            do {
                try await operation(fixtures)
                for fixture in fixtures {
                    await fixture.close()
                }
            } catch {
                for fixture in fixtures {
                    await fixture.close()
                }
                throw error
            }
        }
    }
}

@MainActor
private final class UsageGatewayFixture {
    struct Request: Sendable {
        let owner: String
        let method: String
        let dateMode: String?
        let timeZone: String?
    }

    let revision = LockIsolated<UInt64>(1)
    let requests = LockIsolated<[Request]>([])
    let coldUsage = LockIsolated(false)
    let previewFails = LockIsolated(false)
    private let pendingCostResponses = LockIsolated<[String: [@Sendable () -> Void]]>(["A": [], "B": []])
    let session: GatewayTestWebSocketSession
    let gateway: GatewayConnection
    let control: ControlChannel
    let cron: CronJobsStore
    let summaries: StatusMenuSummaries
    let sessions: StatusMenuSessions

    init(cronJobCount: Int) {
        let revision = self.revision
        let requests = self.requests
        let coldUsage = self.coldUsage
        let previewFails = self.previewFails
        let pendingCostResponses = self.pendingCostResponses
        self.session = GatewayTestWebSocketSession(taskFactory: {
            let owner = revision.value == 1 ? "A" : "B"
            return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: return
                }
                guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let method = frame["method"] as? String else { return }
                let requestParams = frame["params"] as? [String: Any]
                let request = Request(
                    owner: owner,
                    method: method,
                    dateMode: requestParams?["mode"] as? String,
                    timeZone: requestParams?["timeZone"] as? String)
                requests.withValue { $0.append(request) }
                let payload: String
                switch method {
                case "usage.status":
                    if coldUsage.value,
                       requests.value.filter({ $0.owner == owner && $0.method == method }).count == 1
                    {
                        payload = #"{"updatedAt":1800000000000,"providers":[],"refreshing":true}"#
                    } else {
                        payload = #"""
                        {"updatedAt":1800000000000,
                        "providers":[{"provider":"synthetic","displayName":"Gateway \#(owner)",
                        "windows":[{"label":"daily","usedPercent":25}]}],"refreshing":false}
                        """#
                    }
                case "usage.cost":
                    let totals = #"""
                    "input":1,"output":2,"cacheRead":0,"cacheWrite":0,
                    "totalTokens":3,"totalCost":0.25,"missingCostEntries":0
                    """#
                    let daily = owner == "A" ? #"[{"date":"2026-09-03",\#(totals)}]"# : "[]"
                    payload = #"{"updatedAt":1800000000000,"days":30,"daily":\#(daily),"totals":{\#(totals)}}"#
                case "sessions.list":
                    payload = #"""
                    {"path":"/synthetic/\#(owner)/sessions.json","sessions":[
                    {"key":"main","displayName":"Gateway \#(owner)","kind":"direct"}]}
                    """#
                case "sessions.preview":
                    if previewFails.value {
                        let response = #"""
                        {"type":"res","id":"\#(id)","ok":false,
                        "error":{"code":"UNAVAILABLE","message":"Synthetic preview failure"}}
                        """#
                        socket.emitReceiveSuccess(.data(Data(response.utf8)))
                        return
                    }
                    payload = #"""
                    {"ts":1800000000000,"previews":[{"key":"main","status":"ok",
                    "items":[{"role":"assistant","text":"Gateway \#(owner)"}]}]}
                    """#
                case "node.list":
                    payload = #"{"nodes":[]}"#
                case "cron.list":
                    let params = frame["params"] as? [String: Any]
                    let limit = min(params?["limit"] as? Int ?? 200, 200)
                    let count = min(cronJobCount, limit)
                    // GRDB also overloads joined; these interpolations must remain JSON strings.
                    let jobs = (0..<count).map { index -> String in
                        let id = String(format: "job-%03d", index)
                        return #"""
                        {"id":"\#(id)","name":"Automation \#(index)","enabled":true,
                        "createdAtMs":0,"updatedAtMs":0,"schedule":{"kind":"every","everyMs":1000},
                        "sessionTarget":"main","wakeMode":"now",
                        "payload":{"kind":"systemEvent","text":"fixture"},"state":{}}
                        """#
                    }.joined(separator: ",")
                    let nextOffset = count < cronJobCount ? String(count) : "null"
                    payload = #"""
                    {"jobs":[\#(jobs)],"total":\#(cronJobCount),"offset":0,"limit":\#(limit),
                    "snapshotRevision":"fixture","hasMore":\#(count < cronJobCount),"nextOffset":\#(nextOffset)}
                    """#
                default:
                    payload = #"{"ok":true}"#
                }
                let response = #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#
                let sendResponse: @Sendable () -> Void = {
                    socket.emitReceiveSuccess(.data(Data(response.utf8)))
                }
                if method == "usage.cost", coldUsage.value {
                    // The usage callback releases cost replies before their independent deadline.
                    let deferred = pendingCostResponses.withValue { pending in
                        guard pending[owner] != nil else { return false }
                        pending[owner, default: []].append(sendResponse)
                        return true
                    }
                    if deferred { return }
                }
                sendResponse()
            })
        })
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                let current = revision.value
                return GatewayConnection.EndpointSnapshot(
                    config: (URL(string: "ws://127.0.0.1:\(49700 + current)")!, nil, nil),
                    routeAuthority: nil,
                    revision: current)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: self.session))
        self.control = ControlChannel(gateway: self.gateway, endpointRevision: { revision.value })
        self.sessions = StatusMenuSessions(control: self.control)
        self.cron = CronJobsStore(gateway: self.gateway, isPreview: true)
        self.summaries = StatusMenuSummaries(
            control: self.control,
            nodes: NodesStore(control: self.control, localNodeIDLoader: { _ in "synthetic-local-node" }),
            cron: self.cron)
    }

    var hasCostChart: Bool {
        let item = NSMenuItem()
        self.summaries.configureUsage(item)
        return item.submenu?.items.contains { ($0.representedObject as? String) == "usage.cost.chart" } == true
    }

    func populate(sourceLocation: SourceLocation = #_sourceLocation) async throws {
        _ = try await self.control.request(method: "health")
        #expect(self.control.state == .connected)
        self.summaries.refresh {}
        try await TestWait.state("usage and cost chart for Gateway A", sourceLocation: sourceLocation) {
            self.summaries.usageSummary?.contains("Gateway A") == true && self.hasCostChart
        }
        #expect(self.summaries.usageSummary?.contains("Gateway A") == true)
        #expect(self.hasCostChart)
    }

    func releaseCostResponses(for owner: String) {
        let responses = self.pendingCostResponses.withValue { $0.removeValue(forKey: owner) ?? [] }
        responses.forEach { $0() }
    }

    func reconnect() async throws {
        let lease = try #require(await self.gateway.captureServerLease())
        let deliveries = await self.gateway.subscribe()
        let socket = try #require(self.session.latestTask())
        socket.emitReceiveFailure()
        for await delivery in deliveries {
            guard case .disconnected = delivery.event, delivery.serverLease == lease else { continue }
            #expect(!self.gateway.serverLeaseMatchesCurrentState(lease))
            _ = try await self.gateway.acquireServerLease()
            return
        }
        Issue.record("Gateway stream ended before the captured lease disconnected")
    }

    func close() async {
        self.sessions.cancelPreviewTasks()
        self.summaries.menuDidClose()
        await self.control.disconnect()
        self.releaseCostResponses(for: "A")
        self.releaseCostResponses(for: "B")
    }
}
