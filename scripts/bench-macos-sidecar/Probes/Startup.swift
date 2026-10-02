import Darwin
import Foundation
import OpenClawKit
import OpenClawRustSidecar

/// Real inherited-pipe preparation; the controller owns the independent WebSocket receipt.
@main struct StartupProbe {
    static func record(_ value: [String: Any]) throws {
        guard let line = try String(data: JSONSerialization.data(withJSONObject: value), encoding: .utf8) else {
            throw URLError(.cannotParseResponse)
        }
        print(line)
        fflush(stdout)
    }

    static func awaitController() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global().async {
                do {
                    guard try FileHandle.standardInput.read(upToCount: 1) == Data([1]) else {
                        throw URLError(.badServerResponse)
                    }
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    static func receiveHelperPID(_ connection: WebSocketTaskBox) async throws -> Int {
        let payload: Data
        switch try await connection.receive() {
        case let .data(data): payload = data
        case let .string(text): payload = Data(text.utf8)
        @unknown default: throw URLError(.cannotParseResponse)
        }
        guard let response = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
              response["fixtureAck"] as? Int == 1, response["receiptCount"] as? Int == 1,
              response["ok"] as? Bool == true, let helperPID = response["helperPID"] as? Int
        else { throw URLError(.badServerResponse) }
        return helperPID
    }

    static func main() async throws {
        let executable = URL(fileURLWithPath: CommandLine.arguments[2])
        let scenario = executable.lastPathComponent.replacingOccurrences(of: "framing-helper-", with: "")
        let startup = RustGatewayWebSocketSession.Startup(executableURL: executable)
        defer { startup.cancel() }
        let preparation = Task { try await startup.prepare() }
        if scenario == "startup-stalled" {
            try self.record(["preparing": true])
            try await self.awaitController()
            preparation.cancel()
            do {
                try await preparation.value
                throw URLError(.badServerResponse)
            } catch {
                guard (error as? URLError)?.code == .cancelled else { throw error }
            }
            try await Task.sleep(for: .milliseconds(1200))
            try self.record(["passed": true, "cancelledPreparation": true])
            return
        }
        try await preparation.value
        // The channel prepares again when claiming this already-authenticated first child.
        try await startup.prepare()
        try self.record(["prepared": true])
        // The controller captures the exact parked child before allowing any activation.
        try await self.awaitController()
        let started = ContinuousClock.now
        if scenario == "startup-delayed" { try await Task.sleep(for: .seconds(12)) }
        if scenario == "startup-exit" { try await Task.sleep(for: .milliseconds(1500)) }
        if scenario == "startup-cancelled" { guard startup.cancel() else { throw URLError(.badServerResponse) } }
        let session = RustGatewayWebSocketSession(
            executableURL: executable, privateCommands: ["fixture.private"], startup: startup)
        let url = URL(string: CommandLine.arguments[1])!.appendingPathComponent("startup-final")
        if scenario == "startup-discarded" {
            _ = session.makeWebSocketTask(url: url)
            guard !startup.cancel() else { throw URLError(.badServerResponse) }
            try await Task.sleep(for: .milliseconds(1200))
            try self.record(["passed": true, "discardedBeforeResume": true])
            return
        }
        let task = session.makeWebSocketTask(url: url)
        defer { task.cancel(with: .normalClosure, reason: nil) }
        if scenario == "startup-claimed" {
            guard !startup.cancel() else { throw URLError(.badServerResponse) }
        }
        if scenario == "startup-cancelled" || scenario == "startup-exit" {
            let expected: URLError.Code = scenario == "startup-cancelled" ? .cancelled : .networkConnectionLost
            for rejected in [task, session.makeWebSocketTask(url: url)] {
                guard rejected.state == .completed else { throw URLError(.badServerResponse) }
                do {
                    _ = try await rejected.receive()
                    throw URLError(.badServerResponse)
                } catch {
                    guard (error as? URLError)?.code == expected else { throw error }
                }
            }
            try await Task.sleep(for: .milliseconds(1200))
            try self.record(["passed": true, "retiredFactoryRejectedTwice": true])
            return
        }
        var helperPIDs: [Int] = []
        for round in 0..<(scenario == "startup-reconnect" ? 2 : 1) {
            let connection = round == 0 ? task : session.makeWebSocketTask(url: url)
            defer { connection.cancel(with: .normalClosure, reason: nil) }
            connection.resume()
            try await helperPIDs.append(self.receiveHelperPID(connection))
            connection.cancel(with: .normalClosure, reason: nil)
            try await Task.sleep(for: .milliseconds(1200))
        }
        try self.record([
            "passed": true, "helperPIDs": helperPIDs,
            "waitedOverBootstrapBudget": started.duration(to: .now) >= .seconds(12),
        ])
    }
}
