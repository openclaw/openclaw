import Foundation
import OpenClawChatUI

/// Builds the read-only offline chat transcript cache for the macOS app.
///
/// The database lives in the per-user Application Support container
/// (`~/Library/Application Support/OpenClaw/chat-cache.sqlite`), matching the
/// existing OpenClaw app-support layout. macOS has no per-file Data Protection
/// classes (the iOS store applies `completeUntilFirstUserAuthentication`);
/// at-rest protection here is the per-user container permissions plus FileVault.
enum MacChatTranscriptCache {
    /// Stable identity of the gateway this app talks to, derivable offline
    /// (the cache pre-paints before any connection is up). Keys must not
    /// collide across gateways:
    /// - local mode keys on the gateway state dir, the store that owns local
    ///   session data: distinct profiles (distinct `OPENCLAW_STATE_DIR`) never
    ///   share cached transcripts even when they reuse the same port;
    /// - remote/direct keys on the full canonical remote URL (scheme, host,
    ///   resolved port, path, query), since one origin can route to several
    ///   gateways by path;
    /// - remote/ssh keys on the SSH target plus the resolved remote gateway
    ///   port (one SSH target can front several gateways on different ports).
    ///   The tunneled 127.0.0.1 URL is per-launch and deliberately never used
    ///   as identity.
    static func gatewayID(
        mode: AppState.ConnectionMode,
        localStateDir: URL,
        remoteTransport: AppState.RemoteTransport,
        directURL: URL?,
        sshTarget: String,
        sshRemotePort: Int) -> String?
    {
        switch mode {
        case .unconfigured:
            return nil
        case .local:
            // Canonicalize so /var vs /private/var style aliases of the same
            // state dir never split one gateway's cache into two scopes.
            return "local:\(localStateDir.resolvingSymlinksInPath().standardizedFileURL.path)"
        case .remote:
            switch remoteTransport {
            case .direct:
                guard let directURL,
                      let scheme = directURL.scheme?.lowercased(),
                      let host = directURL.host?.lowercased(),
                      !host.isEmpty
                else {
                    return nil
                }
                guard let port = GatewayRemoteConfig.defaultPort(for: directURL) else { return nil }
                // Keep path/query: one origin can front several gateways via
                // reverse-proxy routing, and the app connects to the full URL.
                // Percent-encoded forms, not URL.path: decoding would collapse
                // distinct request paths like /team%2Fa and /team/a.
                // Auth is intentionally not part of the identity: gateway
                // transcripts are not partitioned per token/password principal,
                // and keying on credentials would drop the cache on rotation.
                guard let components = URLComponents(url: directURL, resolvingAgainstBaseURL: false) else {
                    return nil
                }
                let query = components.percentEncodedQuery.map { "?\($0)" } ?? ""
                return "remote:\(scheme)://\(host):\(port)\(components.percentEncodedPath)\(query)"
            case .ssh:
                let target = sshTarget.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !target.isEmpty else { return nil }
                return "ssh:\(target):\(sshRemotePort)"
            }
        }
    }

    /// Offline transcript cache scoped to the currently configured gateway.
    /// Nil when the app is unconfigured or the remote target cannot be
    /// resolved, so foreign rows can never leak into another gateway's scope.
    /// Concrete return type: the same SQLite store also backs the offline
    /// command outbox, and callers wire both protocol facets from one instance.
    static func make() -> OpenClawChatSQLiteTranscriptCache? {
        let root = OpenClawConfigFile.loadDict()
        let mode = ConnectionModeResolver.resolve(root: root).mode
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        let sshTarget = CommandResolver.connectionSettings(configRoot: root).target
        // Mirror the tunnel's remote-port resolution (RemotePortTunnel.create)
        // so the identity matches the gateway the forward actually reaches.
        let defaultRemotePort = GatewayEnvironment.gatewayPort()
        let sshHost = CommandResolver.parseSSHTarget(sshTarget)?.host ?? ""
        let sshRemotePort = RemotePortTunnel.resolveRemotePortOverride(
            defaultRemotePort: defaultRemotePort,
            for: sshHost) ?? defaultRemotePort
        let gatewayID = self.gatewayID(
            mode: mode,
            localStateDir: OpenClawConfigFile.stateDirURL(),
            remoteTransport: resolution.transport,
            directURL: resolution.directURL,
            sshTarget: sshTarget,
            sshRemotePort: sshRemotePort)
        guard let gatewayID else { return nil }
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else {
            return nil
        }
        let databaseURL = base.appendingPathComponent("OpenClaw/chat-cache.sqlite", isDirectory: false)
        return OpenClawChatSQLiteTranscriptCache(databaseURL: databaseURL, gatewayID: gatewayID)
    }
}
