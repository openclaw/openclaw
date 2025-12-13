import ClawdisKit
import Foundation
import Network

actor BridgeClient {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    func pairAndHello(
        endpoint: NWEndpoint,
        nodeId: String,
        displayName: String?,
        platform: String,
        version: String,
        existingToken: String?) async throws -> String
    {
        let connection = NWConnection(to: endpoint, using: .tcp)
        let queue = DispatchQueue(label: "com.steipete.clawdis.ios.bridge-client")
        connection.start(queue: queue)

        let token = existingToken
        try await self.send(
            BridgeHello(
                nodeId: nodeId,
                displayName: displayName,
                token: token,
                platform: platform,
                version: version),
            over: connection)

        if let line = try await self.receiveLine(over: connection),
           let data = line.data(using: .utf8),
           let base = try? self.decoder.decode(BridgeBaseFrame.self, from: data)
        {
            if base.type == "hello-ok" {
                connection.cancel()
                return existingToken ?? ""
            }
            if base.type == "error" {
                let err = try self.decoder.decode(BridgeErrorFrame.self, from: data)
                if err.code == "NOT_PAIRED" || err.code == "UNAUTHORIZED" {
                    try await self.send(
                        BridgePairRequest(
                            nodeId: nodeId,
                            displayName: displayName,
                            platform: platform,
                            version: version),
                        over: connection)

                    while let next = try await self.receiveLine(over: connection) {
                        guard let nextData = next.data(using: .utf8) else { continue }
                        let nextBase = try self.decoder.decode(BridgeBaseFrame.self, from: nextData)
                        if nextBase.type == "pair-ok" {
                            let ok = try self.decoder.decode(BridgePairOk.self, from: nextData)
                            connection.cancel()
                            return ok.token
                        }
                        if nextBase.type == "error" {
                            let e = try self.decoder.decode(BridgeErrorFrame.self, from: nextData)
                            connection.cancel()
                            throw NSError(domain: "Bridge", code: 2, userInfo: [
                                NSLocalizedDescriptionKey: "\(e.code): \(e.message)",
                            ])
                        }
                    }
                }
                connection.cancel()
                throw NSError(domain: "Bridge", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "\(err.code): \(err.message)",
                ])
            }
        }

        connection.cancel()
        throw NSError(domain: "Bridge", code: 0, userInfo: [
            NSLocalizedDescriptionKey: "Unexpected bridge response",
        ])
    }

    private func send(_ obj: some Encodable, over connection: NWConnection) async throws {
        let data = try self.encoder.encode(obj)
        var line = Data()
        line.append(data)
        line.append(0x0A)
        try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: line, completion: .contentProcessed { err in
                if let err { cont.resume(throwing: err) } else { cont.resume(returning: ()) }
            })
        }
    }

    private func receiveLine(over connection: NWConnection) async throws -> String? {
        var buffer = Data()
        while true {
            if let idx = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer.prefix(upTo: idx)
                return String(data: lineData, encoding: .utf8)
            }

            let chunk = try await self.receiveChunk(over: connection)
            if chunk.isEmpty { return nil }
            buffer.append(chunk)
        }
    }

    private func receiveChunk(over connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                if isComplete {
                    cont.resume(returning: Data())
                    return
                }
                cont.resume(returning: data ?? Data())
            }
        }
    }
}
