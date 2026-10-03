import Foundation
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TailscaleIntegrationSectionTests {
    @Test func `dashboard link uses the configured Control UI path`() async throws {
        let host = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            #expect(TailscaleIntegrationSection.dashboardURL(host: host)?.absoluteString ==
                "https://gateway-host.tailnet-example.ts.net/")

            try Data(#"{"gateway":{"controlUi":{"basePath":" control "}}}"#.utf8)
                .write(to: URL(fileURLWithPath: configPath))
            #expect(TailscaleIntegrationSection.dashboardURL(host: host)?.absoluteString ==
                "https://gateway-host.tailnet-example.ts.net/control/")
        }
    }

    @Test func `cli installation requires an executable candidate`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let executable = tempDir.appendingPathComponent("tailscale")
        let nonExecutable = tempDir.appendingPathComponent("tailscaled")
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        try Data().write(to: executable)
        try Data().write(to: nonExecutable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        #expect(TailscaleService.hasExecutableCLI(at: [executable.path]))
        #expect(!TailscaleService.hasExecutableCLI(at: [nonExecutable.path]))
    }

    @Test func `cli-only tailscale status is detected as installed and running`() {
        let service = TailscaleService(isInstalled: false, isRunning: false)
        service.applyStatusEvidence(
            appInstalled: false,
            cliInstalled: true,
            apiResponse: TailscaleService.TailscaleAPIResponse(
                status: "Running",
                deviceName: "april",
                tailnetName: "tail7a0b9.ts.net",
                iPv4: "100.66.5.88"),
            fallbackIP: "100.66.5.88")

        #expect(service.isInstalled)
        #expect(service.isRunning)
        #expect(service.tailscaleHostname == "april.tail7a0b9.ts.net")
        #expect(service.tailscaleIP == "100.66.5.88")
        #expect(service.statusError == nil)
    }

    @Test func `installed cli-only tailscale without a running daemon is detected`() {
        let service = TailscaleService(isInstalled: false, isRunning: false)
        service.applyStatusEvidence(
            appInstalled: false,
            cliInstalled: true,
            apiResponse: nil,
            fallbackIP: nil)

        #expect(service.isInstalled)
        #expect(!service.isAppInstalled)
        #expect(!service.isRunning)
        #expect(service.tailscaleHostname == nil)
        #expect(service.tailscaleIP == nil)
        #expect(service.statusError == "Please start the Tailscale daemon")
    }

    @Test func `shared cgnat address alone is not treated as a tailscale installation`() {
        let service = TailscaleService(isInstalled: false, isRunning: false)
        service.applyStatusEvidence(
            appInstalled: false,
            cliInstalled: false,
            apiResponse: nil,
            fallbackIP: "100.66.5.88")

        #expect(!service.isInstalled)
        #expect(!service.isAppInstalled)
        #expect(!service.isRunning)
        #expect(service.tailscaleHostname == nil)
        #expect(service.tailscaleIP == nil)
        #expect(service.statusError == "Tailscale is not installed")
    }

    @Test func `known cli installation can use interface fallback`() {
        let service = TailscaleService(isInstalled: false, isRunning: false)
        service.applyStatusEvidence(
            appInstalled: false,
            cliInstalled: true,
            apiResponse: nil,
            fallbackIP: "100.66.5.88")

        #expect(service.isInstalled)
        #expect(!service.isAppInstalled)
        #expect(service.isRunning)
        #expect(service.tailscaleHostname == nil)
        #expect(service.tailscaleIP == "100.66.5.88")
        #expect(service.statusError == nil)
    }

    @Test(arguments: ["neither", "initial", "joined"])
    func `concurrent status checks share one request despite waiter cancellation`(cancelledWaiter: String) async {
        let loader = TailscaleStatusLoader()
        let completion = TailscaleStatusCompletion()
        let joinBarrier = TailscaleStatusJoinBarrier()
        let service = TailscaleService(
            isInstalled: true,
            isRunning: true,
            tailscaleHostname: "april.tail7a0b9.ts.net",
            tailscaleIP: "100.66.5.88",
            appInstallationProbe: { true },
            cliInstallationProbe: { false },
            statusDataLoader: loader.load,
            statusCheckJoinHandler: { await joinBarrier.signal() })

        let first = Task { await service.checkTailscaleStatus() }
        await loader.waitForRequestStart()
        let second = Task {
            await service.checkTailscaleStatus()
            await completion.markFinished()
        }
        await joinBarrier.wait()
        if cancelledWaiter == "initial" {
            first.cancel()
        } else if cancelledWaiter == "joined" {
            second.cancel()
        }

        #expect(await loader.requestCount == 1)
        #expect(await completion.finishedCount == 0)

        await loader.releaseRequest()
        await first.value
        await second.value

        #expect(await completion.finishedCount == 1)
        #expect(await loader.requestWasCancelled == false)
        #expect(service.tailscaleIP == "100.66.5.88")

        await service.checkTailscaleStatus()
        #expect(await loader.requestCount == 2)
    }

    @Test func `general tailscale hydration does not rewrite existing config`() async {
        let loaded = TailscaleIntegrationSection.loadedSettings(from: [
            "gateway": [
                "mode": "local",
                "bind": "auto",
                "tailscale": ["mode": "serve"],
                "auth": ["mode": "token", "token": "existing-token"], // pragma: allowlist secret
            ],
        ])
        var saveCount = 0
        let outcome = await TailscaleIntegrationSection.applySettingsIfChanged(
            currentSettings: loaded.snapshot,
            lastAppliedSettings: loaded.snapshot)
        { _ in
            saveCount += 1
            return .saved
        }
        #expect(outcome == .unchanged)
        #expect(saveCount == 0)
    }

    @Test func `tailscale apply validates changed passwords before saving`() async {
        let settings = GatewayTailscaleSettingsSnapshot(
            mode: .funnel, requireCredentialsForServe: true, password: "  ")
        var saveCount = 0
        let outcome = await TailscaleIntegrationSection.applySettingsIfChanged(
            currentSettings: settings,
            lastAppliedSettings: nil)
        { _ in
            saveCount += 1
            return .saved
        }
        #expect(outcome == .invalid("Password required for this mode."))
        #expect(saveCount == 0)
    }
}

private actor TailscaleStatusLoader {
    private(set) var requestCount = 0
    private(set) var requestWasCancelled = false
    private var requestStartedContinuations: [CheckedContinuation<Void, Never>] = []
    private var requestContinuation: CheckedContinuation<Void, Never>?
    private var shouldSuspendRequest = true

    func load(url: URL) async throws -> (Data, URLResponse) {
        self.requestCount += 1
        for continuation in self.requestStartedContinuations {
            continuation.resume()
        }
        self.requestStartedContinuations.removeAll()
        if self.shouldSuspendRequest {
            self.shouldSuspendRequest = false
            await withCheckedContinuation { continuation in
                self.requestContinuation = continuation
            }
        }
        self.requestWasCancelled = Task.isCancelled
        let data = try JSONEncoder().encode(
            TailscaleService.TailscaleAPIResponse(
                status: "Running",
                deviceName: "april",
                tailnetName: "tail7a0b9.ts.net",
                iPv4: "100.66.5.88"))
        let response = try #require(
            HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil))
        return (data, response)
    }

    func waitForRequestStart() async {
        guard self.requestCount == 0 else { return }
        await withCheckedContinuation { continuation in
            self.requestStartedContinuations.append(continuation)
        }
    }

    func releaseRequest() {
        self.requestContinuation?.resume()
        self.requestContinuation = nil
    }
}

private actor TailscaleStatusCompletion {
    private(set) var finishedCount = 0

    func markFinished() {
        self.finishedCount += 1
    }
}

private actor TailscaleStatusJoinBarrier {
    private var joined = false
    private var continuation: CheckedContinuation<Void, Never>?

    func signal() {
        self.joined = true
        self.continuation?.resume()
        self.continuation = nil
    }

    func wait() async {
        guard !self.joined else { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }
}
