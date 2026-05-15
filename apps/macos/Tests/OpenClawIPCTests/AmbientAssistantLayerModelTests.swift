import Testing
@testable import OpenClaw

struct AmbientAssistantLayerModelTests {
    @Test func `default snapshot is safe and local`() {
        let snapshot = AmbientAssistantSurfaceSnapshot.default

        #expect(snapshot.context.frontApp == "Current app")
        #expect(snapshot.context.permissionSummaries.contains("Screen: optional"))
        #expect(snapshot.capabilities.contains(where: { $0.id == "gateway.health" && $0.availability == .available }))
        #expect(snapshot.proposals.first?.approvalState == .notRequired)
        #expect(snapshot.receipt.summary == "No recent ambient actions")
    }

    @Test func `tone maps to symbol and status names`() {
        #expect(AmbientAssistantTone.ready.symbolName == "sparkles")
        #expect(AmbientAssistantTone.blocked.symbolName == "exclamationmark.triangle")
        #expect(AmbientAssistantTone.working.statusLabel == "Working")
    }
}
