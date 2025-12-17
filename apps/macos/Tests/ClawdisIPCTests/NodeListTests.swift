import Testing
@testable import Clawdis

@Suite struct NodeListTests {
    @Test func nodeListMergesPairedAndConnectedPreferringConnectedMetadata() async {
        let paired = PairedNode(
            nodeId: "n1",
            displayName: "Paired Name",
            platform: "iOS 1",
            version: "1.0",
            token: "token",
            createdAtMs: 1,
            lastSeenAtMs: nil)

        let connected = BridgeNodeInfo(
            nodeId: "n1",
            displayName: "Live Name",
            platform: "iOS 2",
            version: "2.0",
            remoteAddress: "10.0.0.1",
            caps: ["canvas", "camera"])

        let res = ControlRequestHandler.buildNodeListResult(paired: [paired], connected: [connected])

        #expect(res.pairedNodeIds == ["n1"])
        #expect(res.connectedNodeIds == ["n1"])
        #expect(res.nodes.count == 1)

        let node = res.nodes.first { $0.nodeId == "n1" }
        #expect(node != nil)
        #expect(node?.displayName == "Live Name")
        #expect(node?.platform == "iOS 2")
        #expect(node?.version == "2.0")
        #expect(node?.remoteAddress == "10.0.0.1")
        #expect(node?.connected == true)
        #expect(node?.capabilities?.sorted() == ["camera", "canvas"])
    }

    @Test func nodeListIncludesConnectedOnlyNodes() async {
        let connected = BridgeNodeInfo(
            nodeId: "n2",
            displayName: "Android Node",
            platform: "Android",
            version: "dev",
            remoteAddress: "192.168.0.10",
            caps: ["canvas"])

        let res = ControlRequestHandler.buildNodeListResult(paired: [], connected: [connected])

        #expect(res.pairedNodeIds == [])
        #expect(res.connectedNodeIds == ["n2"])
        #expect(res.nodes.count == 1)

        let node = res.nodes.first { $0.nodeId == "n2" }
        #expect(node != nil)
        #expect(node?.connected == true)
        #expect(node?.capabilities == ["canvas"])
    }

    @Test func nodeListIncludesPairedDisconnectedNodesWithoutCapabilities() async {
        let paired = PairedNode(
            nodeId: "n3",
            displayName: "Offline Node",
            platform: "iOS",
            version: "1.2.3",
            token: "token",
            createdAtMs: 1,
            lastSeenAtMs: nil)

        let res = ControlRequestHandler.buildNodeListResult(paired: [paired], connected: [])

        #expect(res.pairedNodeIds == ["n3"])
        #expect(res.connectedNodeIds == [])
        #expect(res.nodes.count == 1)

        let node = res.nodes.first { $0.nodeId == "n3" }
        #expect(node != nil)
        #expect(node?.connected == false)
        #expect(node?.capabilities == nil)
        #expect(node?.remoteAddress == nil)
    }
}

