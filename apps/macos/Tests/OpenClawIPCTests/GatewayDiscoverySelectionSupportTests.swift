import Foundation
import OpenClawDiscovery
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayDiscoverySelectionSupportTests {
    private struct RecordedSave: Equatable, Sendable {
        let storeKey: String
        let fingerprint: String
    }

    private final class RecordedSaveBox: @unchecked Sendable {
        var saves: [RecordedSave] = []
    }

    private final class FlagBox: @unchecked Sendable {
        var value = false
    }

    private final class ProbeContinuationBox: @unchecked Sendable {
        var continuation: CheckedContinuation<String?, Never>?
    }

    private func makeGateway(
        serviceHost: String?,
        servicePort: Int?,
        tailnetDns: String? = nil,
        sshPort: Int = 22,
        stableID: String) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: serviceHost,
            servicePort: servicePort,
            lanHost: nil,
            tailnetDns: tailnetDns,
            sshPort: sshPort,
            gatewayPort: servicePort,
            cliPath: nil,
            stableID: stableID,
            debugID: UUID().uuidString,
            isLocal: false)
    }

    private func makeDeps(
        confirmSSHSelection: Bool = true,
        fingerprint: String? = nil,
        confirmDirectSelection: Bool = true,
        existingFingerprint: String? = nil,
        recordedSaves: RecordedSaveBox) -> GatewayDiscoveryTrustSupport.Deps
    {
        GatewayDiscoveryTrustSupport.Deps(
            confirmSSHSelection: { _ in confirmSSHSelection },
            probeTLSFingerprint: { _ in fingerprint },
            confirmDirectSelection: { _ in confirmDirectSelection },
            saveTLSFingerprint: { storeKey, savedFingerprint in
                recordedSaves.saves.append(RecordedSave(storeKey: storeKey, fingerprint: savedFingerprint))
            },
            loadPinnedTLSFingerprint: { _ in existingFingerprint },
            showSelectionFailure: { _, _ in })
    }

    @Test func `selecting tailscale serve gateway switches to direct transport after trust`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let recordedSaves = RecordedSaveBox()
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"

            let applied = await GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    stableID: "tailscale-serve|\(tailnetHost)"),
                state: state,
                deps: self.makeDeps(
                    fingerprint: "abc123",
                    recordedSaves: recordedSaves))

            #expect(applied)
            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == tailnetHost)
            #expect(recordedSaves.saves == [
                RecordedSave(storeKey: "\(tailnetHost):443", fingerprint: "abc123"),
            ])
        }
    }

    @Test func `selecting merged tailnet gateway still switches to direct transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let recordedSaves = RecordedSaveBox()
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            let applied = await GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                state: state,
                deps: self.makeDeps(
                    fingerprint: "def456",
                    recordedSaves: recordedSaves))

            #expect(applied)
            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
            #expect(recordedSaves.saves == [
                RecordedSave(storeKey: "\(tailnetHost):443", fingerprint: "def456"),
            ])
        }
    }

    @Test func `selecting nearby lan gateway keeps ssh transport`() async {
        let recordedSaves = RecordedSaveBox()
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"

            let applied = await GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 18789,
                    stableID: "bonjour|nearby-gateway"),
                state: state,
                deps: self.makeDeps(recordedSaves: recordedSaves))

            #expect(applied)
            #expect(state.remoteTransport == .ssh)
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == "nearby-gateway.local")
            #expect(recordedSaves.saves.isEmpty)
        }
    }

    @Test func `canceling discovered ssh gateway leaves state unchanged`() async {
        let recordedSaves = RecordedSaveBox()
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"
            state.remoteUrl = "wss://old-host:443"

            let applied = await GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 18789,
                    stableID: "bonjour|nearby-gateway"),
                state: state,
                deps: self.makeDeps(
                    confirmSSHSelection: false,
                    recordedSaves: recordedSaves))

            #expect(!applied)
            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteTarget == "user@old-host")
            #expect(state.remoteUrl == "wss://old-host:443")
            #expect(recordedSaves.saves.isEmpty)
        }
    }

    @Test func `canceling discovered direct gateway leaves state unchanged`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let recordedSaves = RecordedSaveBox()
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"
            state.remoteUrl = "wss://old-host:443"

            let applied = await GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    stableID: "tailscale-serve|\(tailnetHost)"),
                state: state,
                deps: self.makeDeps(
                    fingerprint: "abc123",
                    confirmDirectSelection: false,
                    recordedSaves: recordedSaves))

            #expect(!applied)
            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteTarget == "user@old-host")
            #expect(state.remoteUrl == "wss://old-host:443")
            #expect(recordedSaves.saves.isEmpty)
        }
    }

    @Test func `selecting discovered direct gateway skips probe when fingerprint already pinned`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let recordedSaves = RecordedSaveBox()
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            let applied = await GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    stableID: "tailscale-serve|\(tailnetHost)"),
                state: state,
                deps: self.makeDeps(
                    fingerprint: "stored-pin",
                    confirmDirectSelection: false,
                    existingFingerprint: "stored-pin",
                    recordedSaves: recordedSaves))

            #expect(applied)
            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
            #expect(recordedSaves.saves.isEmpty)
        }
    }

    @Test func `selecting discovered direct gateway skips prompt when migrated pin lookup already trusts url`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let recordedSaves = RecordedSaveBox()
        let didPrompt = FlagBox()

        let confirmed = await GatewayDiscoveryTrustSupport.confirmSelection(
            gateway: self.makeGateway(
                serviceHost: tailnetHost,
                servicePort: 443,
                tailnetDns: tailnetHost,
                stableID: "tailscale-serve|\(tailnetHost)"),
            transport: .direct,
            deps: GatewayDiscoveryTrustSupport.Deps(
                confirmSSHSelection: { _ in true },
                probeTLSFingerprint: { url in
                    #expect(url.absoluteString == "wss://\(tailnetHost)")
                    return "migrated-pin"
                },
                confirmDirectSelection: { _ in
                    didPrompt.value = true
                    return false
                },
                saveTLSFingerprint: { storeKey, savedFingerprint in
                    recordedSaves.saves.append(RecordedSave(storeKey: storeKey, fingerprint: savedFingerprint))
                },
                loadPinnedTLSFingerprint: { url in
                    #expect(url.absoluteString == "wss://\(tailnetHost)")
                    return "migrated-pin"
                },
                showSelectionFailure: { _, _ in }))

        #expect(confirmed)
        #expect(!didPrompt.value)
        #expect(recordedSaves.saves.isEmpty)
    }

    @Test func `selecting discovered direct gateway replaces stale pinned fingerprint after confirmation`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let recordedSaves = RecordedSaveBox()
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            let applied = await GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    stableID: "tailscale-serve|\(tailnetHost)"),
                state: state,
                deps: self.makeDeps(
                    fingerprint: "new-pin",
                    existingFingerprint: "old-pin",
                    recordedSaves: recordedSaves))

            #expect(applied)
            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
            #expect(recordedSaves.saves == [
                RecordedSave(storeKey: "\(tailnetHost):443", fingerprint: "new-pin"),
            ])
        }
    }

    @Test func `canceling direct trust while fingerprint probe is in flight skips prompt and save`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let recordedSaves = RecordedSaveBox()
        let didPrompt = FlagBox()
        let continuationBox = ProbeContinuationBox()
        let gateway = self.makeGateway(
            serviceHost: tailnetHost,
            servicePort: 443,
            tailnetDns: tailnetHost,
            stableID: "tailscale-serve|\(tailnetHost)")

        let task = Task {
            await GatewayDiscoveryTrustSupport.confirmSelection(
                gateway: gateway,
                transport: .direct,
                deps: GatewayDiscoveryTrustSupport.Deps(
                    confirmSSHSelection: { _ in true },
                    probeTLSFingerprint: { _ in
                        await withCheckedContinuation { continuation in
                            continuationBox.continuation = continuation
                        }
                    },
                    confirmDirectSelection: { _ in
                        didPrompt.value = true
                        return true
                    },
                    saveTLSFingerprint: { storeKey, savedFingerprint in
                        recordedSaves.saves.append(RecordedSave(storeKey: storeKey, fingerprint: savedFingerprint))
                    },
                    loadPinnedTLSFingerprint: { _ in nil },
                    showSelectionFailure: { _, _ in }))
        }

        await Task.yield()
        task.cancel()
        continuationBox.continuation?.resume(returning: "abc123")
        let confirmed = await task.value

        #expect(!confirmed)
        #expect(!didPrompt.value)
        #expect(recordedSaves.saves.isEmpty)
    }

    @Test func `canceling ssh trust before prompt skips stale modal`() async {
        let didPrompt = FlagBox()
        let gateway = self.makeGateway(
            serviceHost: "nearby-gateway.local",
            servicePort: 18789,
            stableID: "bonjour|nearby-gateway")

        let task = Task {
            await Task.yield()
            return await GatewayDiscoveryTrustSupport.confirmSelection(
                gateway: gateway,
                transport: .ssh,
                deps: GatewayDiscoveryTrustSupport.Deps(
                    confirmSSHSelection: { _ in
                        didPrompt.value = true
                        return true
                    },
                    probeTLSFingerprint: { _ in nil },
                    confirmDirectSelection: { _ in true },
                    saveTLSFingerprint: { _, _ in },
                    loadPinnedTLSFingerprint: { _ in nil },
                    showSelectionFailure: { _, _ in }))
        }

        task.cancel()
        let confirmed = await task.value

        #expect(!confirmed)
        #expect(!didPrompt.value)
    }

    @Test func `canceling direct trust before failed probe skips stale failure alert`() async {
        let didShowFailure = FlagBox()
        let continuationBox = ProbeContinuationBox()
        let gateway = self.makeGateway(
            serviceHost: "gateway-host.tailnet-example.ts.net",
            servicePort: 443,
            tailnetDns: "gateway-host.tailnet-example.ts.net",
            stableID: "tailscale-serve|gateway-host.tailnet-example.ts.net")

        let task = Task {
            await GatewayDiscoveryTrustSupport.confirmSelection(
                gateway: gateway,
                transport: .direct,
                deps: GatewayDiscoveryTrustSupport.Deps(
                    confirmSSHSelection: { _ in true },
                    probeTLSFingerprint: { _ in
                        await withCheckedContinuation { continuation in
                            continuationBox.continuation = continuation
                        }
                    },
                    confirmDirectSelection: { _ in true },
                    saveTLSFingerprint: { _, _ in },
                    loadPinnedTLSFingerprint: { _ in nil },
                    showSelectionFailure: { _, _ in
                        didShowFailure.value = true
                    }))
        }

        await Task.yield()
        task.cancel()
        continuationBox.continuation?.resume(returning: nil)
        let confirmed = await task.value

        #expect(!confirmed)
        #expect(!didShowFailure.value)
    }
}
