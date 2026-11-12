import Foundation

/// Why an owner or member device cannot re-verify its claw before a dial.
public enum OpenClawIDDeviceRouteError: Error, Sendable, Equatable {
    /// No node key is listed and the Discovery session has ended: sign in again.
    case signInRequired
}

/// Re-verifies an owner or member device's claw before each dial, pinned to the root it enrolled
/// with. The descriptor and snapshot come from the device's node key (accountless node auth)
/// while a node is listed, else from the person's Discovery session.
public enum OpenClawIDDeviceRoute {
    public static func refresh(
        hostname: String,
        discoveryOrigin: URL,
        peer: OpenClawIDNodeIdentity,
        admission: OpenClawIDAdmission,
        node: OpenClawIDNodeIdentity?,
        session: OpenClawIDDiscoverySession?,
        store: any OpenClawIDNodeTrustStore,
        http: any OpenClawIDNodeEnrollmentHTTP = OpenClawIDNodeEnrollmentURLSession(),
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) }) async throws
        -> OpenClawIDNodeTrustTarget
    {
        guard let previous = try await store.load(hostname: hostname) else {
            throw OpenClawIDNodeEnrollmentError.notAdmitted
        }
        var response: Data?
        if let node {
            let path = "/v1/claws/\(previous.clawID)/node/descriptor"
            if let url = URL(string: path, relativeTo: discoveryOrigin)?.absoluteURL {
                var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
                request.httpMethod = "GET"
                try request.setValue(
                    OpenClawIDNodeEnrollmentClient.discoverySignature(
                        identity: node, method: "GET", path: path, body: Data(), now: now()),
                    forHTTPHeaderField: "openclaw-signature")
                let result = try await http.send(request)
                if (200...299).contains(result.status) { response = result.body }
            }
        }
        if response == nil {
            guard let session, session.expiresAt > now() + 60 else { throw OpenClawIDDeviceRouteError.signInRequired }
            response = try await OpenClawIDDiscoveryAccount(origin: discoveryOrigin, http: http, now: now)
                .descriptorAndSnapshot(session, clawID: previous.clawID)
        }
        try Task.checkCancellation()
        let assessment = try OpenClawIDNodeTrust.assessDevice(
            response: response!, hostname: hostname, pin: (previous.clawID, previous.rootFingerprint),
            discoveryOrigin: discoveryOrigin, listed: (peer.peerKey, admission), previous: previous, now: now())
        if let observation = assessment.observation {
            try await store.observe(hostname: hostname, state: observation)
        }
        let target = try assessment.verdict.get()
        try await store.commit(target)
        return target
    }
}
