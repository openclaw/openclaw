import AppKit
import Testing
@testable import OpenClaw

@MainActor
struct AppDockMenuTests {
    @Test func `Dock actions retain each gateway identity and current selection`() throws {
        let entries = [
            DashboardGatewayEntry(
                id: "primary",
                name: "Local",
                kind: "local",
                isPrimary: true,
                canPromote: false,
                health: .ok),
            DashboardGatewayEntry(
                id: "profile:work",
                name: "Work",
                kind: "remote",
                isPrimary: false,
                canPromote: true,
                health: .unknown),
            DashboardGatewayEntry(
                id: "profile:backup",
                name: "Backup",
                kind: "remote",
                isPrimary: false,
                canPromote: false,
                health: .unknown),
        ]
        var dashboardOpens = 0
        var settingsOpens = 0
        var targets: [DashboardGatewayTarget] = []
        let owner = AppDockMenu(
            openDashboard: { dashboardOpens += 1 },
            openGateway: { targets.append($0) },
            openSettings: { settingsOpens += 1 })
        let menu = owner.menu(entries: entries, selectedTarget: .profile("work"))
        let actions = menu.items.filter { !$0.isSeparatorItem }
        #expect(actions.map(\.title) == ["Open Dashboard", "Local", "Work", "Backup", "Settings…"])
        #expect(actions.filter { $0.state == .on }.map(\.title) == ["Work"])
        for item in actions {
            let target = try #require(item.target as? NSObject)
            _ = try target.perform(#require(item.action), with: item)
        }
        #expect(dashboardOpens == 1)
        #expect(settingsOpens == 1)
        #expect(targets == [.primary, .profile("work"), .profile("backup")])
        for limited in [[], Array(entries.prefix(1))] {
            let single = owner.menu(entries: limited, selectedTarget: .primary)
            #expect(single.items.filter { !$0.isSeparatorItem }.map(\.title) == ["Open Dashboard", "Settings…"])
        }
    }
}
