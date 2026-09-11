import SwiftUI
import Testing
@testable import OpenClaw

struct DebugSettingsStatusTests {
    @Test(arguments: [
        ControlChannel.ConnectionState.connected,
        .connecting,
        .disconnected,
        .degraded("Connection refused"),
        .degraded(" "),
    ])
    @MainActor func `remote gateway uses connection state`(connection: ControlChannel.ConnectionState) {
        let status = DebugSettings.gatewayStatus(mode: .remote, localStatus: .stopped, connectionState: connection)
        let expected = GatewayConnectionPresentation(state: connection)

        #expect(status.label == expected.statusLine)
        #expect(status.subtitle == expected.generalSubtitle)
        #expect(status.tint == (expected.tone == .healthy ? Color.green : Color.orange))
        #expect(status.label != "Stopped")
    }

    @Test(arguments: [
        GatewayProcessManager.Status.stopped,
        .starting,
        .running(details: "pid 123"),
        .attachedExisting(details: "external"),
        .failed("Could not start"),
    ])
    @MainActor func `local gateway preserves process status`(process: GatewayProcessManager.Status) {
        let status = DebugSettings.gatewayStatus(mode: .local, localStatus: process, connectionState: .connected)

        #expect(status.label == process.label)
        #expect(status.subtitle == "Local process")
        if case .failed = process { #expect(status.tint == Color.red) }
    }

    @Test @MainActor func `unconfigured gateway does not report an old connection`() {
        let status = DebugSettings.gatewayStatus(
            mode: .unconfigured, localStatus: .running(details: nil), connectionState: .connected)

        #expect(status.label == "Not configured")
        #expect(status.tint == Color.secondary)
    }
}
