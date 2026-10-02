import Darwin
import Foundation
import OpenClawKit
import OpenClawRustSidecar

@main struct BackpressureProbe {
    static func send(_ task: WebSocketTaskBox, _ value: [String: Any]) async throws {
        try await task.send(.data(JSONSerialization.data(withJSONObject: value)))
    }

    static func read(_ task: WebSocketTaskBox) async throws -> [String: Any] {
        let data: Data
        switch try await task.receive() {
        case let .data(bytes): data = bytes
        case let .string(text): data = Data(text.utf8)
        @unknown default: throw URLError(.cannotParseResponse)
        }
        guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw URLError(.cannotParseResponse) }
        return frame
    }

    static func connect(_ session: RustGatewayWebSocketSession, _ url: URL) async throws -> WebSocketTaskBox {
        let task = session.makeWebSocketTask(url: url)
        task.resume()
        guard try await self.read(task)["event"] as? String == "connect.challenge"
        else { throw URLError(.badServerResponse) }
        try await self.send(task, ["type": "req", "id": "connect-native-probe", "method": "connect", "params": [
            "minProtocol": 4, "maxProtocol": 4, "role": "node", "commands": [],
            "client": ["id": "openclaw-macos", "mode": "node", "platform": "macos", "version": "probe"],
        ]])
        guard try await self.read(task)["ok"] as? Bool == true else { throw URLError(.badServerResponse) }
        return task
    }

    static func writerOverflow(_ session: RustGatewayWebSocketSession, _ url: URL) async throws -> [String: Any] {
        let stalled = session.makeWebSocketTask(url: url.appendingPathComponent("writer-stalled"))
        defer { stalled.cancel(with: .goingAway, reason: nil) }
        stalled.resume()
        let ready = try await self.read(stalled)
        guard ready["writerReady"] as? Bool == true, let firstPID = ready["helperPID"] as? Int
        else { throw URLError(.badServerResponse) }
        try print(String(
            decoding: JSONSerialization.data(withJSONObject: ["prepared": true, "helperPID": firstPID]),
            as: UTF8.self))
        fflush(stdout)
        // The existing controller records the child before releasing this diagnostic.
        guard try FileHandle.standardInput.read(upToCount: 1) == Data([1]) else {
            throw URLError(.badServerResponse)
        }
        let started = ContinuousClock.now
        var writes: [Task<Int, Never>] = []
        do {
            for index in 0..<6 {
                let data = try JSONSerialization.data(withJSONObject: [
                    "type": "req", "id": "writer-\(index)", "method": "benchmark.echo",
                    "params": ["text": String(repeating: String(index), count: 24 * 1024 * 1024)],
                ])
                guard data.count < 25 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
                writes.append(Task {
                    do { try await stalled.send(.data(data))
                        return 0
                    } catch { return (error as NSError).code }
                })
            }
            while stalled.state != .completed, started.duration(to: .now) < .seconds(8) {
                try await Task.sleep(for: .milliseconds(10))
            }
            let retiredBeforeDeadline = stalled.state == .completed && started.duration(to: .now) < .seconds(8)
            if !retiredBeforeDeadline { stalled.cancel(with: .goingAway, reason: nil) }
            var codes: [Int] = []
            for write in writes {
                await codes.append(write.value)
            }
            guard retiredBeforeDeadline,
                  codes.count == 6, codes.allSatisfy({ $0 == URLError.dataLengthExceedsMaximum.rawValue })
            else {
                throw NSError(domain: "WriterOverflowProbe", code: 1, userInfo: [NSLocalizedDescriptionKey:
                        "retiredBeforeEightSeconds=\(retiredBeforeDeadline), sendErrors=\(codes)"])
            }
            let recovered = session.makeWebSocketTask(url: url.appendingPathComponent("writer-recovered"))
            defer { recovered.cancel(with: .goingAway, reason: nil) }
            recovered.resume()
            let recoveryReady = try await self.read(recovered)
            let response = try await self.read(recovered)
            guard recoveryReady["writerReady"] as? Bool == true,
                  let recoveredPID = recoveryReady["helperPID"] as? Int, recoveredPID != firstPID,
                  response["helperPID"] as? Int == recoveredPID,
                  response["fixtureAck"] as? Int == 1, response["receiptCount"] as? Int == 1,
                  response["ok"] as? Bool == true
            else { throw URLError(.badServerResponse) }
            recovered.cancel(with: .goingAway, reason: nil)
            try await Task.sleep(for: .milliseconds(1200))
            return [
                "passed": true, "writerRetiredBeforeEightSeconds": true,
                "sendErrors": codes, "helperPIDs": [firstPID, recoveredPID],
                "authenticatedFreshChildRecovered": true,
            ]
        } catch {
            stalled.cancel(with: .goingAway, reason: nil)
            for write in writes {
                _ = await write.value
            }
            throw error
        }
    }

    static func main() async {
        do {
            let url = URL(string: CommandLine.arguments[1])!
            let session = RustGatewayWebSocketSession(executableURL: URL(fileURLWithPath: CommandLine.arguments[2]))
            if CommandLine.arguments.dropFirst(3).first == "writer-overflow" {
                let result = try await self.writerOverflow(session, url)
                try print(String(
                    decoding: JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
                    as: UTF8.self))
                return
            }
            let stalled = try await connect(session, url)
            try await send(stalled, ["type": "req", "id": "flood", "method": "benchmark.flood", "params": [:]])
            // Deliberately never call receive while the Gateway sends 512 ordinary events.
            let started = ContinuousClock.now
            while stalled.state != .completed, started.duration(to: .now) < .seconds(8) {
                try await Task.sleep(for: .milliseconds(10))
            }
            guard stalled.state == .completed else { throw URLError(.timedOut) }
            var overflowCode = 0
            do {
                _ = try await self.read(stalled)
                throw URLError(.badServerResponse)
            } catch {
                overflowCode = (error as NSError).code
                guard (error as? URLError)?.code == .dataLengthExceedsMaximum else { throw error }
            }
            let recovered = try await connect(session, url)
            try await send(
                recovered,
                ["type": "req", "id": "after-overload", "method": "benchmark.echo", "params": ["recovered": true]])
            let response = try await read(recovered)
            guard (response["payload"] as? [String: Any])?["recovered"] as? Bool == true
            else { throw URLError(.badServerResponse) }
            recovered.cancel(with: .goingAway, reason: nil)
            let result: [String: Any] = [
                "passed": true,
                "blockedConsumer": true,
                "documentedBufferFrames": 256,
                "overflowCode": overflowCode,
                "freshSessionRecovered": true,
            ]
            try print(String(
                decoding: JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
                as: UTF8.self))
        } catch {
            let failure: [String: Any] = ["passed": false, "error": String(describing: error)]
            if let data = try? JSONSerialization.data(withJSONObject: failure, options: [.sortedKeys]) {
                print(String(decoding: data, as: UTF8.self))
            }
        }
    }
}
