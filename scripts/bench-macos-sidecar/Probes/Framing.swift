import Foundation
import OpenClawKit
import OpenClawRustSidecar

@main struct FramingProbe {
    static func main() async throws {
        let session = RustGatewayWebSocketSession(executableURL: URL(fileURLWithPath: CommandLine.arguments[2]))
        let task = session.makeWebSocketTask(url: URL(string: CommandLine.arguments[1])!)
        let start = ContinuousClock.now
        task.resume()
        do {
            switch try await task.receive() {
            case let .data(bytes): print(String(decoding: bytes, as: UTF8.self))
            case let .string(text): print(text)
            @unknown default: throw URLError(.cannotParseResponse)
            }
        } catch {
            let failure = error as NSError
            let elapsed = start.duration(to: .now).components
            let record: [String: Any] = [
                "failureDomain": failure.domain, "failureCode": failure.code,
                "elapsedSeconds": Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18,
            ]
            try print(String(decoding: JSONSerialization.data(withJSONObject: record), as: UTF8.self))
        }
        task.cancel(with: .normalClosure, reason: nil)
        try await Task.sleep(for: .milliseconds(1200))
    }
}
