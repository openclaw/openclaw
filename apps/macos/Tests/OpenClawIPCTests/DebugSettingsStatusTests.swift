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
        let status = DebugSettings.gatewayStatus(
            mode: .remote, hostsLocalGateway: false, localStatus: .stopped, connectionState: connection)
        let expected = GatewayConnectionPresentation(state: connection)

        #expect(status.label == expected.statusLine)
        #expect(status.subtitle == expected.generalSubtitle)
        #expect(status.tint == (expected.tone == .healthy ? Color.green : Color.orange))
        #expect(status.label != "Stopped")
        #expect(status.hostedLocalProcess == nil)
    }

    @Test @MainActor func `connected remote gateway preserves a hosted local failure`() {
        let status = DebugSettings.gatewayStatus(
            mode: .remote, hostsLocalGateway: true, localStatus: .failed("Could not start"),
            connectionState: .connected)

        #expect(status.label == "Connected")
        #expect(status.tint == Color.green)
        #expect(status.hostedLocalProcess == .failed("Could not start"))
    }

    @Test @MainActor func `running hosted gateway does not mask a disconnected remote gateway`() {
        let status = DebugSettings.gatewayStatus(
            mode: .remote, hostsLocalGateway: true, localStatus: .running(details: nil),
            connectionState: .disconnected)

        #expect(status.label == "Disconnected")
        #expect(status.tint == Color.orange)
        #expect(status.hostedLocalProcess == .running(details: nil))
    }

    @Test(arguments: [
        GatewayProcessManager.Status.stopped,
        .starting,
        .running(details: "pid 123"),
        .attachedExisting(details: "external"),
        .failed("Could not start"),
    ])
    @MainActor func `local gateway preserves process status`(process: GatewayProcessManager.Status) {
        let status = DebugSettings.gatewayStatus(
            mode: .local, hostsLocalGateway: false, localStatus: process, connectionState: .connected)

        #expect(status.label == process.label)
        #expect(status.subtitle == "Local process")
        #expect(status.hostedLocalProcess == nil)
        if case .failed = process { #expect(status.tint == Color.red) }
    }

    @Test @MainActor func `unconfigured gateway does not report an old connection`() {
        let status = DebugSettings.gatewayStatus(
            mode: .unconfigured, hostsLocalGateway: false, localStatus: .running(details: nil),
            connectionState: .connected)

        #expect(status.label == "Not configured")
        #expect(status.tint == Color.secondary)
        #expect(status.hostedLocalProcess == nil)
    }

    @Test(arguments: [AppState.ConnectionMode.local, .remote, .unconfigured])
    @MainActor func `installed CLI is neutral in every mode`(mode: AppState.ConnectionMode) {
        let status = DebugSettings.cliStatus(mode: mode, hostsLocalGateway: false, location: "/fixture/bin/openclaw")
        #expect(status.label == "/fixture/bin/openclaw")
        #expect(status.tint == Color.secondary)
    }

    @Test @MainActor func `missing CLI is an error when this Mac hosts a gateway`() {
        let local = DebugSettings.cliStatus(mode: .local, hostsLocalGateway: false, location: nil)
        #expect(local.label == "missing")
        #expect(local.tint == Color.red)
        let hosted = DebugSettings.cliStatus(mode: .remote, hostsLocalGateway: true, location: nil)
        #expect(hosted.label == "missing")
        #expect(hosted.tint == Color.red)
        let remote = DebugSettings.cliStatus(mode: .remote, hostsLocalGateway: false, location: nil)
        #expect(remote.label == "Not installed (optional for remote Gateway)")
        #expect(remote.tint == Color.secondary)
        let unconfigured = DebugSettings.cliStatus(mode: .unconfigured, hostsLocalGateway: false, location: nil)
        #expect(unconfigured.label == "Not installed")
        #expect(unconfigured.tint == Color.secondary)
    }
}
