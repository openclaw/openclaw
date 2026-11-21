import Darwin
import Foundation
import OpenClawIPC
import OpenClawKit
import OpenClawNativeState
import Testing
@testable import OpenClaw
@testable import OpenClawMacCLI

struct MacControlCredentialAccessTests {
    @Test func `abandoned app socket permits one offline credential operation without removing the socket`() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let descriptor = try fixture.bindSocket()
        close(descriptor)
        var before = stat()
        try #require(lstat(fixture.socketURL.path, &before) == 0)

        let result = try executeMacClientCredentials(
            root: fixture.root, operation: Fixture.replacement(), client: fixture.client)

        #expect(result.changed == true)
        #expect(try fixture.persistedToken() == "after")
        var after = stat()
        try #require(lstat(fixture.socketURL.path, &after) == 0)
        #expect(before.st_ino == after.st_ino)
        #expect(before.st_mode == after.st_mode)
        do {
            _ = try fixture.client.send(MacControlRequest(operation: "status"))
            Issue.record("An abandoned socket cannot serve ordinary app controls")
        } catch {
            let rendered = macControlError(error)
            #expect(rendered.code == "unreachable")
            #expect(rendered.message.contains("Start the app or retry with --launch"))
        }
    }

    @Test func `unsafe abandoned socket does not grant offline credential access`() throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let descriptor = try fixture.bindSocket()
        close(descriptor)
        try #require(chmod(fixture.socketURL.path, 0o644) == 0)

        #expect(throws: MacControlError.self) {
            try executeMacClientCredentials(
                root: fixture.root, operation: Fixture.replacement(), client: fixture.client)
        }
        #expect(try fixture.persistedToken() == "before")
    }

    @Test(arguments: [
        "success",
        "closed",
        "timeout",
        "authentication_failed",
        "connection_refused",
        "credential_root_unowned",
    ])
    func `connected app outcomes never become an uncertain offline replay`(_ outcome: String) async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let listener = try fixture.bindSocket()
        defer { close(listener) }
        try #require(listen(listener, 1) == 0)
        try configureSocketTimeouts(listener, timeoutMs: 3000)

        async let result = ExecApprovalsSocketTestSupport.withBlockingSocketIO {
            Result {
                try executeMacClientCredentials(
                    root: fixture.root, operation: Fixture.replacement(), client: fixture.client)
            }
        }
        let envelope = try await ExecApprovalsSocketTestSupport.withBlockingSocketIO {
            let connection = accept(listener, nil, nil)
            try #require(connection >= 0)
            defer { close(connection) }
            try configureSocketTimeouts(connection, timeoutMs: 3000)
            let line = try #require(try readLineFromSocket(
                connection,
                maxBytes: MacControlCredentials.maximumFrameBytes))
            let envelope = try JSONDecoder().decode(MacControlEnvelope.self, from: Data(line.utf8))
            if outcome == "timeout" {
                // Wait for the client's own deadline and close, rather than sleeping past it.
                var byte: UInt8 = 0
                #expect(recv(connection, &byte, 1, 0) == 0)
            } else if outcome != "closed" {
                let response: MacControlResponse<ClientCredentialResult>
                if outcome == "success" {
                    var unchanged = ClientCredentialResult(kind: .changed)
                    unchanged.changed = false
                    response = MacControlResponse(result: unchanged)
                } else {
                    response = MacControlResponse(error: MacControlError(code: outcome, message: "Synthetic refusal"))
                }
                var data = try JSONEncoder().encode(response)
                data.append(0x0A)
                try FileHandle(fileDescriptor: connection, closeOnDealloc: false).write(contentsOf: data)
            }
            return envelope
        }
        #expect(envelope.authenticated(token: fixture.controlToken))
        let request = try JSONDecoder().decode(MacControlRequest.self, from: Data(envelope.requestJson.utf8))
        #expect(request.operation == "client.credentials")
        #expect(request.credentialRoot == fixture.root.path)
        #expect(request.credentialOperation?.token?.token == "after")
        switch try await result {
        case let .success(value):
            #expect(outcome == "success" || outcome == "credential_root_unowned")
            #expect(value.changed == (outcome == "credential_root_unowned"))
        case let .failure(error):
            #expect(outcome != "success" && outcome != "credential_root_unowned")
            let expected = outcome == "closed" ? "unreachable" :
                (outcome == "timeout" ? "operation_timeout" : outcome)
            #expect((error as? MacControlError)?.code == expected)
        }
        #expect(try fixture.persistedToken() == (outcome == "credential_root_unowned" ? "after" : "before"))
    }

    private struct Fixture: Sendable {
        let root: URL
        let controlDirectory: URL
        let controlToken: String

        init() throws {
            let root = try ExecApprovalsSocketTestSupport.makeRoot()
            self.root = root
            self.controlDirectory = root.appendingPathComponent("control", isDirectory: true)
            do {
                try FileManager.default.createDirectory(
                    at: self.controlDirectory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700])
                self.controlToken = try MacControlCredentials.createIfMissing(
                    at: self.controlDirectory.appendingPathComponent(MacControlCredentials.tokenFilename))
                _ = try DeviceCredentialAccess.executeOffline(root: root, operation: Self.replacement(token: "before"))
            } catch {
                try? FileManager.default.removeItem(at: root)
                throw error
            }
        }

        var socketURL: URL {
            self.controlDirectory.appendingPathComponent(MacControlCredentials.socketFilename)
        }

        var client: MacControlClient {
            get throws {
                var options = try MacControlOptions(
                    request: MacControlRequest(operation: "client.credentials"),
                    profile: MacControlProfile(rawValue: nil))
                options.launch = false
                options.timeoutMs = 1000
                return MacControlClient(options: options, directory: self.controlDirectory)
            }
        }

        static func replacement(token: String = "after") -> ClientCredentialOperation {
            var operation = ClientCredentialOperation(kind: .tokenReplace)
            operation.key = .init(deviceID: "synthetic-device", role: "operator")
            operation.token = .init(
                deviceID: "synthetic-device",
                role: "operator",
                token: token,
                scopesJSON: "[]",
                updatedAtMs: 1)
            return operation
        }

        func persistedToken() throws -> String? {
            var operation = ClientCredentialOperation(kind: .tokenRead)
            operation.key = .init(deviceID: "synthetic-device", role: "operator")
            return try DeviceCredentialAccess.executeOffline(root: self.root, operation: operation).token?.token
        }

        func bindSocket() throws -> Int32 {
            let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
            try #require(descriptor >= 0)
            do {
                var address = sockaddr_un()
                address.sun_family = sa_family_t(AF_UNIX)
                address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
                let path = Array(self.socketURL.path.utf8CString)
                try #require(path.count <= MemoryLayout.size(ofValue: address.sun_path))
                withUnsafeMutableBytes(of: &address.sun_path) { destination in
                    path.withUnsafeBytes { destination.copyBytes(from: $0) }
                }
                let bound = withUnsafePointer(to: &address) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                    }
                }
                try #require(bound == 0)
                try #require(chmod(self.socketURL.path, 0o600) == 0)
                return descriptor
            } catch {
                close(descriptor)
                throw error
            }
        }

        func remove() {
            try? FileManager.default.removeItem(at: self.root)
        }
    }
}
