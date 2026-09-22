import Foundation
import OpenClawChatUI
import OpenClawKit

extension GatewayConnection {
    func loadSourceContext() async -> OpenClawChatSourceContext? {
        await self.sourceResourceLoader()?.loadContext()
    }

    func loadSourceFavicon(host: String) async -> Data? {
        await self.sourceResourceLoader()?.loadFavicon(host: host)
    }

    private func sourceResourceLoader() async -> OpenClawChatSourceResources? {
        guard let lease = await captureServerLease() else { return nil }
        let revision = sourceResourceRevision
        if let cached = sourceResources, cached.lease == lease, cached.revision == revision {
            return cached.loader
        }
        let loader = OpenClawChatSourceResources(
            gatewayURL: lease.route.url,
            nativeControlPageURL: try? GatewayEndpointStore.dashboardURL(
                for: (url: lease.route.url, token: nil, password: nil), mode: .remote),
            request: { [weak self] url, maximumBytes in
                guard let self else { throw CancellationError() }
                return try await self.requestSourceResource(
                    url: url, maximumBytes: maximumBytes, lease: lease, revision: revision)
            },
            loadConfig: { [weak self] in
                try? await self?.request(
                    method: "config.get", params: nil, ifCurrentServerLease: lease)
            },
            isCurrent: { [weak self] in
                await self?.sourceResourceIsCurrent(lease: lease, revision: revision) == true
            })
        sourceResources = (lease, revision, loader)
        return loader
    }

    private func sourceResourceIsCurrent(lease: ServerLease, revision: UInt64) async -> Bool {
        guard await isCurrentServerLease(lease) else { return false }
        return sourceResourceRevision == revision
    }

    private func requestSourceResource(
        url: URL,
        maximumBytes: Int,
        lease: ServerLease,
        revision: UInt64) async throws -> (Data, URLResponse)
    {
        let bearer = try await sourceResourceBearer(ifCurrentServerLease: lease)
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/json, image/*", forHTTPHeaderField: "Accept")
        for (name, value) in try lease.route.browserSession?.headers(for: url) ?? [:] {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let tls = lease.route.tls?.params ?? GatewayTLSParams(
            required: url.scheme == "https", expectedFingerprint: nil, allowTOFU: false, storeKey: nil)
        let session = GatewayTLSPinningSession(
            params: tls, allowsRedirects: false, allowsStoredCredentials: false)
        defer { session.finishTasksAndInvalidate() }
        return try await OpenClawChatSourceResources.performAuthenticatedRequest(request, bearer: bearer) { request in
            try await self.transferSourceResource(
                request: request, session: session, maximumBytes: maximumBytes, lease: lease, revision: revision)
        }
    }

    private func transferSourceResource(
        request: URLRequest,
        session: GatewayTLSPinningSession,
        maximumBytes: Int,
        lease: ServerLease,
        revision: UInt64) async throws -> (Data, URLResponse)
    {
        guard await self.sourceResourceIsCurrent(lease: lease, revision: revision) else {
            throw CancellationError()
        }
        let transfer = Task { [request] in
            try await session.data(for: request, maximumBytes: maximumBytes) { [weak self] in
                self?.serverLeaseMatchesCurrentState(lease) == true
            }
        }
        let transferID = UUID()
        managedMediaTransfers[transferID] = transfer
        defer { self.managedMediaTransfers[transferID] = nil }
        let result = try await withTaskCancellationHandler {
            try await transfer.value
        } onCancel: {
            transfer.cancel()
        }
        guard await self.sourceResourceIsCurrent(lease: lease, revision: revision) else {
            throw CancellationError()
        }
        return result
    }
}
