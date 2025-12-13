import ClawdisKit
import SwiftUI
import UIKit

@MainActor
private final class ConnectStatusStore: ObservableObject {
    @Published var text: String?
}

extension ConnectStatusStore: @unchecked Sendable {}

struct SettingsTab: View {
    @EnvironmentObject private var appModel: NodeAppModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage("node.displayName") private var displayName: String = "iOS Node"
    @AppStorage("node.instanceId") private var instanceId: String = UUID().uuidString
    @AppStorage("voiceWake.enabled") private var voiceWakeEnabled: Bool = false
    @AppStorage("bridge.preferredStableID") private var preferredBridgeStableID: String = ""
    @StateObject private var discovery = BridgeDiscoveryModel()
    @StateObject private var connectStatus = ConnectStatusStore()
    @State private var connectingBridgeID: String?
    @State private var didAutoConnect = false
    @State private var localIPAddress: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Node") {
                    TextField("Name", text: self.$displayName)
                    Text(self.instanceId)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    LabeledContent("IP", value: self.localIPAddress ?? "—")
                        .contextMenu {
                            if let ip = self.localIPAddress {
                                Button {
                                    UIPasteboard.general.string = ip
                                } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                            }
                        }
                }

                Section("Voice") {
                    Toggle("Voice Wake", isOn: self.$voiceWakeEnabled)
                        .onChange(of: self.voiceWakeEnabled) { _, newValue in
                            self.appModel.setVoiceWakeEnabled(newValue)
                        }
                }

                Section("Bridge") {
                    LabeledContent("Discovery", value: self.discovery.statusText)
                    LabeledContent("Status", value: self.appModel.bridgeStatusText)
                    if let serverName = self.appModel.bridgeServerName {
                        LabeledContent("Server", value: serverName)
                        if let addr = self.appModel.bridgeRemoteAddress {
                            let parts = Self.parseHostPort(from: addr)
                            let urlString = Self.httpURLString(host: parts?.host, port: parts?.port, fallback: addr)
                            LabeledContent("Address") {
                                Text(urlString)
                            }
                            .contextMenu {
                                Button {
                                    UIPasteboard.general.string = urlString
                                } label: {
                                    Label("Copy URL", systemImage: "doc.on.doc")
                                }

                                if let parts {
                                    Button {
                                        UIPasteboard.general.string = parts.host
                                    } label: {
                                        Label("Copy Host", systemImage: "doc.on.doc")
                                    }

                                    Button {
                                        UIPasteboard.general.string = "\(parts.port)"
                                    } label: {
                                        Label("Copy Port", systemImage: "doc.on.doc")
                                    }
                                }
                            }
                        }

                        Button("Disconnect", role: .destructive) {
                            self.appModel.disconnectBridge()
                        }

                        self.bridgeList(showing: .availableOnly)
                    } else {
                        self.bridgeList(showing: .all)
                    }

                    if let text = self.connectStatus.text {
                        Text(text)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
            .onAppear {
                self.discovery.start()
                self.localIPAddress = Self.primaryIPv4Address()
            }
            .onDisappear { self.discovery.stop() }
            .onChange(of: self.discovery.bridges) { _, newValue in
                if self.didAutoConnect { return }
                if self.appModel.bridgeServerName != nil { return }

                let existing = KeychainStore.loadString(
                    service: "com.steipete.clawdis.bridge",
                    account: self.keychainAccount())
                guard let existing, !existing.isEmpty else { return }
                guard let target = self.pickAutoConnectBridge(from: newValue) else { return }

                self.didAutoConnect = true
                self.preferredBridgeStableID = target.stableID
                self.appModel.connectToBridge(
                    endpoint: target.endpoint,
                    hello: BridgeHello(
                        nodeId: self.instanceId,
                        displayName: self.displayName,
                        token: existing,
                        platform: self.platformString(),
                        version: self.appVersion()))
                self.connectStatus.text = nil
            }
            .onChange(of: self.appModel.bridgeServerName) { _, _ in
                self.connectStatus.text = nil
            }
        }
    }

    @ViewBuilder
    private func bridgeList(showing: BridgeListMode) -> some View {
        if self.discovery.bridges.isEmpty {
            Text("No bridges found yet.")
                .foregroundStyle(.secondary)
        } else {
            let connectedID = self.appModel.connectedBridgeID
            let rows = self.discovery.bridges.filter { bridge in
                let isConnected = bridge.stableID == connectedID
                switch showing {
                case .all:
                    return true
                case .availableOnly:
                    return !isConnected
                }
            }

            if rows.isEmpty, showing == .availableOnly {
                Text("No other bridges found.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(rows) { bridge in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bridge.name)
                        }
                        Spacer()

                        Button {
                            Task { await self.connect(bridge) }
                        } label: {
                            if self.connectingBridgeID == bridge.id {
                                ProgressView()
                                    .progressViewStyle(.circular)
                            } else {
                                Text("Connect")
                            }
                        }
                        .disabled(self.connectingBridgeID != nil)
                    }
                }
            }
        }
    }

    private enum BridgeListMode: Equatable {
        case all
        case availableOnly
    }

    private func keychainAccount() -> String {
        "bridge-token.\(self.instanceId)"
    }

    private func platformString() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "iOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    private func connect(_ bridge: BridgeDiscoveryModel.DiscoveredBridge) async {
        self.connectingBridgeID = bridge.id
        self.preferredBridgeStableID = bridge.stableID
        defer { self.connectingBridgeID = nil }

        do {
            let existing = KeychainStore.loadString(
                service: "com.steipete.clawdis.bridge",
                account: self.keychainAccount())
            let existingToken = (existing?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false) ?
                existing :
                nil

            let hello = BridgeHello(
                nodeId: self.instanceId,
                displayName: self.displayName,
                token: existingToken,
                platform: self.platformString(),
                version: self.appVersion())
            let token = try await BridgeClient().pairAndHello(
                endpoint: bridge.endpoint,
                hello: hello,
                onStatus: { status in
                    let store = self.connectStatus
                    Task { @MainActor in
                        store.text = status
                    }
                })

            if !token.isEmpty, token != existingToken {
                _ = KeychainStore.saveString(
                    token,
                    service: "com.steipete.clawdis.bridge",
                    account: self.keychainAccount())
            }

            self.appModel.connectToBridge(
                endpoint: bridge.endpoint,
                hello: BridgeHello(
                    nodeId: self.instanceId,
                    displayName: self.displayName,
                    token: token,
                    platform: self.platformString(),
                    version: self.appVersion()))

        } catch {
            self.connectStatus.text = "Failed: \(error.localizedDescription)"
        }
    }

    private func pickAutoConnectBridge(from bridges: [BridgeDiscoveryModel.DiscoveredBridge]) -> BridgeDiscoveryModel
    .DiscoveredBridge? {
        if !self.preferredBridgeStableID.isEmpty,
           let match = bridges.first(where: { $0.stableID == self.preferredBridgeStableID })
        {
            return match
        }
        return bridges.first
    }

    private static func primaryIPv4Address() -> String? {
        var addrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrList) == 0, let first = addrList else { return nil }
        defer { freeifaddrs(addrList) }

        var fallback: String?
        var en0: String?

        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let isUp = (flags & IFF_UP) != 0
            let isLoopback = (flags & IFF_LOOPBACK) != 0
            let name = String(cString: ptr.pointee.ifa_name)
            let family = ptr.pointee.ifa_addr.pointee.sa_family
            if !isUp || isLoopback || family != UInt8(AF_INET) { continue }

            var addr = ptr.pointee.ifa_addr.pointee
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &addr,
                socklen_t(ptr.pointee.ifa_addr.pointee.sa_len),
                &buffer,
                socklen_t(buffer.count),
                nil,
                0,
                NI_NUMERICHOST)
            guard result == 0 else { continue }
            let len = buffer.prefix { $0 != 0 }
            let bytes = len.map { UInt8(bitPattern: $0) }
            guard let ip = String(bytes: bytes, encoding: .utf8) else { continue }

            if name == "en0" { en0 = ip; break }
            if fallback == nil { fallback = ip }
        }

        return en0 ?? fallback
    }

    private struct HostPort: Equatable {
        var host: String
        var port: Int
    }

    private static func parseHostPort(from address: String) -> HostPort? {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if trimmed.hasPrefix("["),
           let close = trimmed.firstIndex(of: "]"),
           close < trimmed.endIndex
        {
            let host = String(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
            let portStart = trimmed.index(after: close)
            guard portStart < trimmed.endIndex, trimmed[portStart] == ":" else { return nil }
            let portString = String(trimmed[trimmed.index(after: portStart)...])
            guard let port = Int(portString) else { return nil }
            return HostPort(host: host, port: port)
        }

        guard let colon = trimmed.lastIndex(of: ":") else { return nil }
        let host = String(trimmed[..<colon])
        let portString = String(trimmed[trimmed.index(after: colon)...])
        guard !host.isEmpty, let port = Int(portString) else { return nil }
        return HostPort(host: host, port: port)
    }

    private static func httpURLString(host: String?, port: Int?, fallback: String) -> String {
        if let host, let port {
            let needsBrackets = host.contains(":") && !host.hasPrefix("[") && !host.hasSuffix("]")
            let hostPart = needsBrackets ? "[\(host)]" : host
            return "http://\(hostPart):\(port)"
        }
        return "http://\(fallback)"
    }
}
