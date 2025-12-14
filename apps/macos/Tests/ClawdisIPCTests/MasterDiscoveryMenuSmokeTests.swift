import SwiftUI
import Testing
@testable import Clawdis

@Suite(.serialized)
@MainActor
struct MasterDiscoveryMenuSmokeTests {
    @Test func inlineListBuildsBodyWhenEmpty() {
        let discovery = MasterDiscoveryModel()
        discovery.statusText = "Searching…"
        discovery.masters = []

        let view = MasterDiscoveryInlineList(discovery: discovery, currentTarget: nil, onSelect: { _ in })
        _ = view.body
    }

    @Test func inlineListBuildsBodyWithMasterAndSelection() {
        let discovery = MasterDiscoveryModel()
        discovery.statusText = "Found 1"
        discovery.masters = [
            .init(
                displayName: "Office Mac",
                lanHost: "office.local",
                tailnetDns: "office.tailnet-123.ts.net",
                sshPort: 2222,
                debugID: "office"),
        ]

        let currentTarget = "\(NSUserName())@office.tailnet-123.ts.net:2222"
        let view = MasterDiscoveryInlineList(discovery: discovery, currentTarget: currentTarget, onSelect: { _ in })
        _ = view.body
    }

    @Test func menuBuildsBodyWithMasters() {
        let discovery = MasterDiscoveryModel()
        discovery.statusText = "Found 2"
        discovery.masters = [
            .init(displayName: "A", lanHost: "a.local", tailnetDns: nil, sshPort: 22, debugID: "a"),
            .init(displayName: "B", lanHost: nil, tailnetDns: "b.ts.net", sshPort: 22, debugID: "b"),
        ]

        let view = MasterDiscoveryMenu(discovery: discovery, onSelect: { _ in })
        _ = view.body
    }
}

