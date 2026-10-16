import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

struct CommandSessionGroupingTests {
    @MainActor
    @Test func `group mutations wait for a resolved current connection`() async {
        let model = SessionGroupModel()
        let appModel = NodeAppModel()
        var invokedFallback = false
        await model.mutate(
            appModel: appModel,
            request: OpenClawChatGatewayRequests.sessionGroupsDelete(name: "Projects"),
            fallback: { _ in invokedFallback = true })
        #expect(!invokedFallback)
        #expect(model.failure != nil)
        #expect(!model.submitting)
    }

    @Test func `groups pinned categories and ungrouped in display order`() {
        let sections = CommandSessionGrouping.sections(from: [
            self.entry("ungrouped", activity: 2),
            self.entry("beta", category: "Beta", activity: 3),
            self.entry("alpha-old", category: "Alpha", activity: 1),
            self.entry("pinned", category: "Beta", pinned: true, activity: 4),
            self.entry("alpha-new", category: "Alpha", activity: 5),
        ])

        #expect(sections.map(\.id) == [
            .pinned,
            .category("Alpha"),
            .category("Beta"),
            .ungrouped,
        ])
        #expect(sections[0].entries.map(\.key) == ["pinned"])
        #expect(sections[1].entries.map(\.key) == ["alpha-new", "alpha-old"])
        #expect(sections[3].showsHeader)
    }

    @Test func `known groups render empty sections in alphabetical merge`() {
        let sections = CommandSessionGrouping.sections(
            from: [
                self.entry("beta", category: "Beta", activity: 2),
                self.entry("plain", activity: 1),
            ],
            knownGroups: ["Zulu", "Alpha"])

        #expect(sections.map(\.id) == [
            .category("Alpha"),
            .category("Beta"),
            .category("Zulu"),
            .ungrouped,
        ])
        #expect(sections[0].entries.isEmpty)
        #expect(sections[1].entries.map(\.key) == ["beta"])
        #expect(sections[2].entries.isEmpty)
        #expect(sections[3].showsHeader)
    }

    @Test func `known groups ignore blanks and duplicates`() {
        let sections = CommandSessionGrouping.sections(
            from: [self.entry("beta", category: "Beta", activity: 1)],
            knownGroups: ["  ", "Beta", "Beta", "Alpha"])

        #expect(sections.map(\.id) == [.category("Alpha"), .category("Beta")])

        let categories = CommandSessionGrouping.categories(
            from: [self.entry("beta", category: "Beta", activity: 1)],
            knownGroups: ["", "Beta", "Alpha", "Alpha"])
        #expect(categories == ["Alpha", "Beta"])
    }

    @Test func `group members merge active and archived lists deduped by key`() {
        let members = CommandSessionGrouping.members(
            of: "Ops",
            in: [
                [
                    self.entry("a", category: "Ops", activity: 1),
                    self.entry("other", category: "Dev", activity: 2),
                ],
                [
                    self.entry("a", category: "Ops", activity: 1),
                    self.entry("b", category: " Ops ", activity: 3),
                    self.entry("plain", activity: 4),
                ],
            ])

        #expect(members.map(\.key) == ["a", "b"])
        #expect(CommandSessionGrouping.members(of: "  ", in: [[self.entry("a", activity: 1)]]).isEmpty)
    }

    @Test func `hides ungrouped header without category sections`() {
        let sections = CommandSessionGrouping.sections(from: [self.entry("plain", activity: 1)])

        #expect(sections.count == 1)
        #expect(sections[0].id == .ungrouped)
        #expect(!sections[0].showsHeader)
    }

    @Test func `preview puts pinned sessions before recent activity`() {
        let entries = CommandSessionGrouping.previewOrder([
            self.entry("recent", activity: 20),
            self.entry("pinned-old", pinned: true, activity: 1),
            self.entry("older", activity: 10),
        ])

        #expect(entries.map(\.key) == ["pinned-old", "recent", "older"])
    }

    @Test func `preview selection keeps the open chat visible past the cap`() {
        let entries = [
            self.entry("a", activity: 40),
            self.entry("b", activity: 30),
            self.entry("c", activity: 20),
            self.entry("current", activity: 10),
        ]

        let selection = CommandSessionGrouping.previewSelection(entries, currentKey: "current")
        #expect(selection.map(\.key) == ["current", "a", "b"])

        // Natural order wins when the current session already fits the cap.
        let natural = CommandSessionGrouping.previewSelection(entries, currentKey: "a")
        #expect(natural.map(\.key) == ["a", "b", "c"])

        // Unknown or empty keys fall back to the plain capped ordering.
        let fallback = CommandSessionGrouping.previewSelection(entries, currentKey: "")
        #expect(fallback.map(\.key) == ["a", "b", "c"])
    }

    private func entry(
        _ key: String,
        category: String? = nil,
        pinned: Bool = false,
        activity: Double) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil,
            category: category,
            pinned: pinned,
            lastActivityAt: activity)
    }
}

struct SessionGroupStoreTests {
    @Test func `normalizes trims dedupes and drops blanks`() {
        #expect(SessionGroupStore.normalized([" Ops ", "Ops", "", "  ", "Dev"]) == ["Ops", "Dev"])
    }

    @Test func `renaming replaces a stored name in place`() {
        #expect(SessionGroupStore.renaming(["Dev", "Ops"], from: "Dev", to: "Core") == ["Core", "Ops"])
        // Renaming onto an existing name collapses the duplicate.
        #expect(SessionGroupStore.renaming(["Dev", "Ops"], from: "Dev", to: "Ops") == ["Ops"])
    }

    @Test func `renaming a live-only group appends the new name`() {
        #expect(SessionGroupStore.renaming(["Ops"], from: "Dev", to: "Core") == ["Ops", "Core"])
    }

    @Test func `removing and adding keep the list unique`() {
        #expect(SessionGroupStore.removing(["Dev", "Ops"], "Dev") == ["Ops"])
        #expect(SessionGroupStore.adding(["Ops"], "Ops") == ["Ops"])
        #expect(SessionGroupStore.adding(["Ops"], " Dev ") == ["Ops", "Dev"])
    }

    @MainActor
    @Test func `load and save round-trip through user defaults`() async {
        await GatewayPersistenceTestGate.shared.acquire()
        defer { GatewayPersistenceTestGate.shared.release() }
        withUserDefaults([SessionGroupStore.defaultsKey: nil]) {
            #expect(SessionGroupStore.load() == [])
            SessionGroupStore.save([" Dev ", "Dev", "Ops"])
            #expect(SessionGroupStore.load() == ["Dev", "Ops"])
            SessionGroupStore.remember("Core")
            #expect(SessionGroupStore.load() == ["Dev", "Ops", "Core"])
        }
    }

    @MainActor
    @Test func `folded groups survive a new model and are kept while no catalog is loaded`() async {
        await GatewayPersistenceTestGate.shared.acquire()
        defer { GatewayPersistenceTestGate.shared.release() }
        withUserDefaults([SessionGroupStore.collapsedKey: nil]) {
            let model = SessionGroupModel()
            #expect(model.collapsed.isEmpty)
            model.collapsed.insert("Ops")
            #expect(SessionGroupModel().collapsed == ["Ops"])
            // No catalog loaded: nothing is known to be stale.
            model.pruneCollapsed(for: [])
            #expect(SessionGroupStore.loadCollapsed() == ["Ops"])
        }
    }
}

@Suite(.serialized)
@MainActor
struct SessionGroupMigrationTests {
    @Test(arguments: ["empty", "populated", "read-only", "legacy"])
    func `refresh follows the web one-time local catalog migration`(_ scenario: String) async throws {
        await GatewayPersistenceTestGate.shared.acquire()
        defer { GatewayPersistenceTestGate.shared.release() }
        try await withUserDefaults([SessionGroupStore.defaultsKey: ["Research"]]) {
            let model = SessionGroupModel()
            let appModel = NodeAppModel()
            var requests: [OpenClawChatGatewayRequest] = []
            let connection = OpenClawSessionMenuConnection(
                methods: scenario == "legacy" ? [] : ["sessions.groups.list", "sessions.groups.put"],
                scopes: scenario == "read-only" ? ["operator.read"] : ["operator.write"],
                isCurrent: { true },
                request: { request in
                    requests.append(request)
                    if request.method == "sessions.groups.list" {
                        return Data((scenario == "populated"
                                ? #"{"groups":[{"name":"Server","position":0}]}"#
                                : #"{"groups":[]}"#).utf8)
                    }
                    #expect(request.method == "sessions.groups.put")
                    return Data(#"{"ok":true,"groups":[{"name":"Research","position":0}]}"#.utf8)
                })

            await model.refresh(appModel: appModel, connectionProvider: { _ in connection })

            #expect(model.failure == nil)
            #expect(!model.loading)
            switch scenario {
            case "empty":
                #expect(requests.map(\.method) == ["sessions.groups.list", "sessions.groups.put"])
                let put = try #require(requests.last)
                let names = put.params["names"]?.value as? [String]
                #expect(names == ["Research"])
                #expect(model.names(for: []) == ["Research"])
                #expect(UserDefaults.standard.object(forKey: SessionGroupStore.defaultsKey) == nil)
                await model.refresh(appModel: appModel, connectionProvider: { _ in connection })
                #expect(requests.filter { $0.method == "sessions.groups.put" }.count == 1)
            case "populated":
                #expect(requests.map(\.method) == ["sessions.groups.list"])
                #expect(model.names(for: []) == ["Server"])
                #expect(UserDefaults.standard.object(forKey: SessionGroupStore.defaultsKey) == nil)
            case "read-only":
                #expect(requests.map(\.method) == ["sessions.groups.list"])
                #expect(SessionGroupStore.load() == ["Research"])
                #expect(model.names(for: []).isEmpty)
            default:
                #expect(requests.isEmpty)
                #expect(SessionGroupStore.load() == ["Research"])
                #expect(model.names(for: []) == ["Research"])
            }
        }
    }

    @Test(arguments: ["list", "put", "failure"])
    func `refresh retains local names when migration does not complete for the current connection`(
        _ boundary: String) async
    {
        await GatewayPersistenceTestGate.shared.acquire()
        defer { GatewayPersistenceTestGate.shared.release() }
        await withUserDefaults([SessionGroupStore.defaultsKey: ["Research"]]) {
            let model = SessionGroupModel()
            let appModel = NodeAppModel()
            var current = true
            var methods: [String] = []
            let connection = OpenClawSessionMenuConnection(
                methods: ["sessions.groups.list", "sessions.groups.put"],
                scopes: ["operator.write"],
                isCurrent: { current },
                request: { request in
                    methods.append(request.method)
                    if request.method == "sessions.groups.list" {
                        if boundary == "list" { current = false }
                        return Data(#"{"groups":[]}"#.utf8)
                    }
                    if boundary == "failure" { throw URLError(.cannotConnectToHost) }
                    current = false
                    return Data(#"{"ok":true,"groups":[{"name":"Research","position":0}]}"#.utf8)
                })

            await model.refresh(appModel: appModel, connectionProvider: { _ in connection })

            #expect(methods == (boundary == "list"
                    ? ["sessions.groups.list"] : ["sessions.groups.list", "sessions.groups.put"]))
            #expect(SessionGroupStore.load() == ["Research"])
            #expect(model.catalog == nil)
            #expect((model.failure != nil) == (boundary == "failure"))
            #expect(!model.loading)
        }
    }

    @Test func `refresh drops a kept catalog when the connection cannot list groups`() async {
        await GatewayPersistenceTestGate.shared.acquire()
        defer { GatewayPersistenceTestGate.shared.release() }
        await withUserDefaults([SessionGroupStore.defaultsKey: ["Device Local"]]) {
            let model = SessionGroupModel()
            let appModel = NodeAppModel()
            let owner = appModel.chatViewModelOwnerID
            let connection = OpenClawSessionMenuConnection(
                methods: ["sessions.groups.list"],
                scopes: ["operator.read"],
                isCurrent: { true },
                request: { _ in Data(#"{"groups":[{"name":"Catalog Only","position":0}]}"#.utf8) })
            appModel.setOperatorConnected(true)
            await model.refresh(appModel: appModel, connectionProvider: { _ in connection })
            #expect(model.names(for: []) == ["Catalog Only"])
            #expect(model.usesCatalog)

            appModel.setOperatorConnected(false)
            await model.refresh(appModel: appModel, connectionProvider: { _ in nil })
            #expect(appModel.chatViewModelOwnerID == owner)
            #expect(model.names(for: []) == ["Catalog Only"], "A dropped link must keep the catalog")
            #expect(model.usesCatalog)

            let legacy = OpenClawSessionMenuConnection(
                methods: [],
                scopes: ["operator.write"],
                isCurrent: { true },
                request: { _ in
                    Issue.record("A connection without group methods must not request the catalog")
                    return Data()
                })
            appModel.setOperatorConnected(true)
            await model.refresh(appModel: appModel, connectionProvider: { _ in legacy })
            #expect(appModel.chatViewModelOwnerID == owner)
            #expect(
                model.names(for: []) == ["Device Local"],
                "A current connection without group methods must show device-local groups")
            #expect(!model.usesCatalog, "A current connection without group methods must drop the kept catalog")
            #expect(!model.allows("sessions.groups.put"))
            #expect(!model.allows("sessions.groups.rename"))
        }
    }

    @Test func `a loaded catalog prunes folded names that no longer name a group`() async {
        await GatewayPersistenceTestGate.shared.acquire()
        defer { GatewayPersistenceTestGate.shared.release() }
        await withUserDefaults([
            SessionGroupStore.defaultsKey: nil,
            SessionGroupStore.collapsedKey: nil,
        ]) {
            let model = SessionGroupModel()
            let appModel = NodeAppModel()
            let connection = OpenClawSessionMenuConnection(
                methods: ["sessions.groups.list"],
                scopes: ["operator.read"],
                isCurrent: { true },
                request: { _ in Data(#"{"groups":[{"name":"Kept","position":0}]}"#.utf8) })
            await model.refresh(appModel: appModel, connectionProvider: { _ in connection })
            #expect(model.names(for: []) == ["Kept"])
            model.collapsed = ["Kept", "Gone"]
            model.pruneCollapsed(for: [])
            #expect(model.collapsed == ["Kept"], "A loaded catalog must prune folded names absent from its groups")
            #expect(SessionGroupStore.loadCollapsed() == ["Kept"])

            model.collapsed.insert("Gone")
            let failed = OpenClawSessionMenuConnection(
                methods: ["sessions.groups.list"],
                scopes: ["operator.read"],
                isCurrent: { true },
                request: { _ in throw URLError(.cannotConnectToHost) })
            await model.refresh(appModel: appModel, connectionProvider: { _ in failed })
            #expect(model.failure != nil)
            #expect(model.names(for: []) == ["Kept"])
            model.pruneCollapsed(for: [])
            #expect(model.collapsed == ["Kept", "Gone"], "A failed catalog refresh must not prune folded names")
            #expect(SessionGroupStore.loadCollapsed() == ["Kept", "Gone"])
        }
    }

    @Test func `refresh keeps the catalog across a dropped link to the same gateway`() async {
        await GatewayPersistenceTestGate.shared.acquire()
        defer { GatewayPersistenceTestGate.shared.release() }
        await withUserDefaults([SessionGroupStore.defaultsKey: nil]) {
            let model = SessionGroupModel()
            let appModel = NodeAppModel()
            let connection = OpenClawSessionMenuConnection(
                methods: ["sessions.groups.list", "sessions.groups.rename"],
                scopes: ["operator.write"],
                isCurrent: { true },
                request: { _ in Data(#"{"groups":[{"name":"Empty","position":0}]}"#.utf8) })
            appModel.setOperatorConnected(true)
            await model.refresh(appModel: appModel, connectionProvider: { _ in connection })
            #expect(model.names(for: []) == ["Empty"])
            #expect(model.allows("sessions.groups.rename"))

            appModel.setOperatorConnected(false)
            await model.refresh(appModel: appModel, connectionProvider: { _ in nil })

            // The empty group's header stays; its actions wait for the link.
            #expect(model.names(for: []) == ["Empty"])
            #expect(!model.allows("sessions.groups.rename"))
        }
    }
}
