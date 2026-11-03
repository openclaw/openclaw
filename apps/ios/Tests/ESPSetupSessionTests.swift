import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct ESPSetupSessionTests {
    private final class Link: ESPSetupLink {
        var disconnected: (() -> Void)?
        var exchanges: [Data] = []
        var requests: [Data] = []
        var pendingOnce = false
        var failMutationReply = false
        var afterFragment: (() -> Void)?
        var holdNext = false
        var holdTerminalReply = false
        var onHeld: (() -> Void)?
        var held: CheckedContinuation<Data, Never>?
        var heldReply = Data()
        var closed = false
        private var assembled = Data()
        private var reply = Data()
        private var mutationOperation: UInt8 = 4

        func connect(_: ESPSetupDiscovery) async throws {}
        func close() {
            self.closed = true
        }

        func exchange(_ bytes: Data) async throws -> Data {
            let response = try self.response(bytes)
            if self.holdNext || (self.holdTerminalReply && bytes[3] == 2 && self.assembled[1] == 2) {
                self.holdNext = false
                self.holdTerminalReply = false
                self.heldReply = response
                return await withCheckedContinuation { continuation in
                    self.held = continuation
                    self.onHeld?()
                }
            }
            return response
        }

        private func response(_ bytes: Data) throws -> Data {
            self.exchanges.append(bytes)
            let id = Array(bytes[4..<8])
            if self.pendingOnce {
                self.pendingOnce = false
                return Data([0x4F, 0x43, 1, 0xFF] + id + [0, 0, 0, 0, 0, 2, 0, 0, 0, 5])
            }
            let offset = Int(bytes[10]) * 256 + Int(bytes[11])
            if bytes[3] == 1 {
                if offset == 0 { self.assembled = Data() }
                self.assembled.append(bytes.dropFirst(16))
                let total = Int(bytes[8]) * 256 + Int(bytes[9])
                if self.assembled.count == total {
                    self.requests.append(self.assembled)
                    let operation = self.assembled[1]
                    if operation == 4 || operation == 5 { self.mutationOperation = operation }
                    let opID = Array(self.assembled[12..<16])
                    let header: [UInt8] = [
                        1,
                        operation,
                        0,
                        operation == 4 || operation == 5 ? 1 : 0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        7,
                    ] + opID
                    if operation == 1 {
                        self.reply = Data(header + [2, 1, 87, 1, 68, 0xAB, 0xCD, 0x12, 0x34]
                            + Array(repeating: 0, count: 28))
                    } else {
                        self.reply = Data(header + [
                            2,
                            1,
                            operation == 2 ? self.mutationOperation : operation,
                            operation == 2 ? 2 : 1,
                        ] + opID
                            + [0, 0, 1, 1, operation == 2 ? 5 : 2, 0, 0, 0])
                    }
                }
                self.afterFragment?()
                let end = self.assembled.count
                return Data([0x4F, 0x43, 1, 0x81] + id + [
                    bytes[8],
                    bytes[9],
                    UInt8(end >> 8),
                    UInt8(end & 255),
                    0,
                    0,
                    0,
                    0,
                ])
            }
            if self.failMutationReply, self.assembled[1] == 4 {
                throw ESPSetupError.unavailable("Fixture transport failure; result unknown.")
            }
            let fragment = self.reply.subdata(in: offset..<min(offset + 448, self.reply.count))
            return Data([0x4F, 0x43, 1, 0x82] + id + [
                UInt8(self.reply.count >> 8),
                UInt8(self.reply.count & 255),
                bytes[10],
                bytes[11],
                UInt8(fragment.count >> 8),
                UInt8(fragment.count & 255),
                0,
                0,
            ]) + fragment
        }
    }

    private func connected(_ link: Link) async throws -> ESPSetupSession {
        let session = ESPSetupSession(link: link)
        try await session.connect(ESPSetupDiscovery(name: "PROV_OC_1234abcd", pop: String(repeating: "a", count: 32)))
        #expect(session.phase == .ready)
        #expect(session.comparison == "ABCD 1234")
        return session
    }

    @Test func `pending retries identical plaintext without advancing transfer`() async throws {
        let link = Link()
        link.pendingOnce = true
        let session = try await self.connected(link)
        #expect(link.exchanges[0] == link.exchanges[1])
        #expect(link.requests.count == 1)
        session.close()
    }

    @Test func `accepted mutation polls receipt with original ID instead of replaying`() async throws {
        let link = Link()
        let session = try await self.connected(link)
        await session.applyWiFi(ssid: Data([0xFF, 65]), password: "")
        #expect(session.receipt?.outcome == 2)
        #expect(session.receipt?.saved == true)
        let mutations = link.requests.filter { $0[1] == 4 }
        let status = try #require(link.requests.first { $0[1] == 2 })
        #expect(mutations.count == 1)
        #expect(status[12..<16] == mutations[0][12..<16])
        session.close()
    }

    @Test func `uncertain transport failure closes without automatic mutation replay`() async throws {
        let link = Link()
        let session = try await self.connected(link)
        link.failMutationReply = true
        await session.applyWiFi(ssid: Data("fixture".utf8), password: "")
        #expect(session.phase == .closed)
        #expect(link.closed)
        #expect(link.requests.filter { $0[1] == 4 }.count == 1)
        #expect(!link.requests.contains { $0[1] == 2 })
        #expect(session.generation == 0)
        #expect(session.comparison.isEmpty)
    }

    @Test(arguments: [false, true])
    func `authority loss during Gateway exchange cannot restore ready state`(terminalReply: Bool) async throws {
        let link = Link()
        let session = try await self.connected(link)
        var authorized = true
        let before = link.exchanges.count
        if terminalReply {
            link.holdTerminalReply = true
        } else {
            link.afterFragment = { authorized = false }
        }
        let action = Task {
            await session.applyGateway(code: String(repeating: "a", count: 1200)) {
                if !authorized { throw CancellationError() }
            }
        }
        if terminalReply {
            await withCheckedContinuation { continuation in
                link.onHeld = { continuation.resume() }
            }
            authorized = false
            link.held?.resume(returning: link.heldReply)
            link.held = nil
        }
        await action.value
        #expect(session.phase == .closed)
        #expect(link.closed)
        #expect(session.receipt?.outcome != 2)
        if terminalReply {
            #expect(link.requests.filter { $0[1] == 5 }.count == 1)
            #expect(link.requests.filter { $0[1] == 2 }.count == 1)
            // Revocation cannot undo the save already observed in the pending receipt.
            #expect(session.receipt?.saved == true)
        } else {
            #expect(link.exchanges.count == before + 1)
            #expect(!link.requests.contains { $0[1] == 5 })
        }
    }

    @Test func `late exchange cannot resurrect locally closed setup`() async throws {
        let link = Link()
        let session = try await self.connected(link)
        link.holdNext = true
        let action = Task { await session.applyWiFi(ssid: Data("fixture".utf8), password: "") }
        await withCheckedContinuation { continuation in
            link.onHeld = { continuation.resume() }
        }
        session.close()
        link.held?.resume(returning: link.heldReply)
        link.held = nil
        await action.value
        #expect(session.phase == .closed)
        #expect(session.comparison.isEmpty)
        #expect(session.generation == 0)
        #expect(link.requests.filter { $0[1] == 4 }.count == 1)
    }
}
