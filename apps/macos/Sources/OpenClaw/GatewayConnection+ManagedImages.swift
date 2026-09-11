import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    func loadMediaArtifact(
        sessionKey: String,
        agentID: String?,
        artifactId: String,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode?,
        ifCurrentServerLease lease: ServerLease,
        expectedProfileId: String? = nil,
        isCurrent: @escaping @Sendable () -> Bool = { true }) async throws -> OpenClawChatLoadedMedia?
    {
        let authorityIsCurrent: @Sendable () -> Bool = { [weak self] in
            isCurrent() && self?.serverLeaseMatchesCurrentState(lease) == true
        }
        guard expectedProfileId == nil || authorityIsCurrent() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard kind.acceptsManagedArtifactID(artifactId) else { return nil }
        let request = OpenClawChatGatewayRequests.artifactDownload(
            sessionKey: sessionKey,
            agentID: agentID,
            artifactId: artifactId)
        let responseData = try await self.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: lease,
            expectedProfileId: expectedProfileId)
        guard authorityIsCurrent() else { throw OpenClawChatTransportSendError.notDispatched }
        let response = try JSONDecoder().decode(ArtifactsDownloadResult.self, from: responseData)
        let maximumBytes = Self.maximumManagedMediaBytes(for: kind)
        let declaredMIME = response.artifact.mimetype?.lowercased()
        if playback != .transcode,
           let encoded = response.data?.trimmingCharacters(in: .whitespacesAndNewlines),
           !encoded.isEmpty
        {
            guard response.encoding == "base64",
                  let declaredMIME,
                  declaredMIME.hasPrefix(kind.mimeTypePrefix),
                  let data = Data(base64Encoded: encoded),
                  data.count <= maximumBytes
            else { return nil }
            guard await self.isCurrentServerLease(lease), authorityIsCurrent() else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            return .data(OpenClawChatMediaData(data: data, mimeType: declaredMIME))
        }
        let httpContext: GatewayAdmittedHTTPContext?
        if expectedProfileId != nil {
            guard let admitted = await self.admittedHTTPContext(ifCurrentServerLease: lease),
                  authorityIsCurrent()
            else { throw OpenClawChatTransportSendError.notDispatched }
            httpContext = admitted
        } else {
            httpContext = nil
        }
        guard let ticketedPath = response.url?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = OpenClawChatMediaURL.resolve(
                  gatewayURL: httpContext?.gatewayURL ?? lease.route.url,
                  ticketedPath: ticketedPath,
                  playback: playback)
        else { return nil }

        // Native playback must remain inside the bounded, authority-checked
        // transfer; handing AVPlayer a URL would escape its HTTP controls.
        let canStreamDirectly = expectedProfileId == nil && kind == .video &&
            url.scheme?.lowercased() == "https" &&
            lease.route.browserSession == nil &&
            lease.route.tls == nil &&
            declaredMIME?.hasPrefix(kind.mimeTypePrefix) == true
        if canStreamDirectly, playback != .transcode, let declaredMIME {
            guard await self.isCurrentServerLease(lease), authorityIsCurrent() else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            return .stream(OpenClawChatMediaStream(
                url: url,
                mimeType: declaredMIME,
                sizeBytes: response.artifact.sizebytes))
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = kind == .video ? 60 : 20
        urlRequest.setValue("\(kind.rawValue)/*", forHTTPHeaderField: "Accept")
        if canStreamDirectly {
            urlRequest.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        }
        // Artifact tickets do not bypass the ingress issuer. Reuse the socket's
        // exact session and reject redirects before any credential can leave its authority.
        let (headers, tls) = try Self.managedMediaHTTPPolicy(url: url, lease: lease, context: httpContext)
        for (name, value) in headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        let session = GatewayTLSPinningSession(
            params: tls,
            allowsRedirects: expectedProfileId == nil && lease.route.browserSession == nil,
            allowsStoredCredentials: expectedProfileId == nil && lease.route.browserSession == nil)
        defer { session.finishTasksAndInvalidate() }
        guard await self.isCurrentServerLease(lease), authorityIsCurrent() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let transferID = UUID()
        let transfer = Task { [urlRequest] in
            try await session.data(for: urlRequest, maximumBytes: maximumBytes, isCurrent: authorityIsCurrent)
        }
        self.managedMediaTransfers[transferID] = transfer
        defer { self.managedMediaTransfers[transferID] = nil }
        let (data, urlResponse) = try await withTaskCancellationHandler {
            try await transfer.value
        } onCancel: {
            transfer.cancel()
        }
        guard await self.isCurrentServerLease(lease), authorityIsCurrent() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard let http = urlResponse as? HTTPURLResponse else { return nil }
        if http.statusCode == 202 {
            return .preparing
        }
        guard (200..<300).contains(http.statusCode),
              let mimeType = http.mimeType?.lowercased(),
              mimeType.hasPrefix(kind.mimeTypePrefix)
        else { return nil }
        if canStreamDirectly {
            return .stream(OpenClawChatMediaStream(
                url: url,
                mimeType: mimeType,
                sizeBytes: response.artifact.sizebytes))
        }
        return .data(OpenClawChatMediaData(data: data, mimeType: mimeType))
    }

    private static func maximumManagedMediaBytes(for kind: OpenClawChatMediaKind) -> Int {
        switch kind {
        case .image: 12 * 1024 * 1024
        case .audio, .video: 16 * 1024 * 1024
        }
    }

    private static func managedMediaHTTPPolicy(
        url: URL,
        lease: ServerLease,
        context: GatewayAdmittedHTTPContext?) throws -> (headers: [String: String], tls: GatewayTLSParams)
    {
        if let context {
            try lease.route.browserSession?.validate(for: url)
            guard let target = GatewayTLSAuthority(url: url),
                  let owner = GatewayTLSAuthority(url: context.gatewayURL),
                  target.host == owner.host, target.port == owner.port,
                  context.customHeaders.isEmpty || target.scheme == "https"
            else { throw GatewayBrowserSessionError.wrongOrigin }
            return (context.customHeaders, GatewayTLSParams(
                required: target.scheme == "https",
                expectedFingerprint: context.tlsFingerprintSHA256,
                allowTOFU: false,
                storeKey: nil))
        }
        return try (
            lease.route.browserSession?.headers(for: url) ?? [:],
            lease.route.tls?.params ?? GatewayTLSParams(
                required: lease.route.browserSession != nil,
                expectedFingerprint: nil,
                allowTOFU: false,
                storeKey: nil))
    }
}
