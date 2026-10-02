import CryptoKit
import Foundation

/// An authenticated fixture peer over the real inherited pipes. Only this peer
/// dribbles bytes; the production reader keeps its unchanged ten-second budget.
@main struct FramingHelper {
    private enum Feature {
        static let nativeRelay = 1, pongReceipt = 2, binaryMessage = 4, nativeResult = 16, opaqueTransport = 64
        static let required = nativeRelay | pongReceipt | binaryMessage | nativeResult | opaqueTransport
    }

    private static let frameLimit = ((25 * 1024 * 1024 + 2) / 3) * 4 + 4096
    private let key: SymmetricKey
    private let session: Data
    private let generation: UInt64
    private var sent: UInt64 = 0
    private var received: UInt64 = 0

    static func main() throws {
        let bootstrap = try Self.read(56)
        var peer = Self(
            key: SymmetricKey(data: bootstrap.prefix(32)),
            session: Data(bootstrap.dropFirst(32).prefix(16).map { String(format: "%02x", $0) }.joined().utf8),
            generation: Self.integer(bootstrap, at: 48, count: 8))
        try peer.run(scenario: URL(fileURLWithPath: CommandLine.arguments[0]).lastPathComponent
            .replacingOccurrences(of: "framing-helper-", with: ""))
    }

    private mutating func run(scenario: String) throws {
        let offerRecord = try self.incoming()
        guard offerRecord.0 == "OCSC",
              let envelope = try JSONSerialization.jsonObject(with: offerRecord.1) as? [String: Any],
              var offer = envelope["offer"] as? [String: Any], envelope["type"] as? String == "offer",
              offer["featureBits"] as? Int == Feature.required, let limits = offer["limits"]
        else { throw URLError(.cannotParseResponse) }
        offer["peer"] = [
            "role": "runtime", "name": "openclaw-mac-node-sidecar", "version": "fixture",
            "artifactIdentity": "framing-fixture",
        ]
        if scenario == "startup-stalled" { Thread.sleep(forTimeInterval: 30) }
        try self.emit([
            "type": "accept", "offer": offer,
            "selection": ["protocolMajor": 1, "protocolMinor": 0, "featureBits": Feature.required, "limits": limits],
        ])
        if scenario == "startup-exit" {
            Thread.sleep(forTimeInterval: 1)
            return
        }
        let open = try self.incoming()
        guard open.0 == "OCSC",
              let openValue = try JSONSerialization.jsonObject(with: open.1) as? [String: Any],
              openValue["type"] as? String == "open"
        else { throw URLError(.cannotParseResponse) }
        if scenario == "writer-overflow" {
            guard let url = openValue["url"] as? String,
                  let path = URL(string: url)?.path, ["/writer-stalled", "/writer-recovered"].contains(path)
            else { throw URLError(.cannotParseResponse) }
            try self.emit(["type": "frame", "frame": [
                "writerReady": true, "helperPID": ProcessInfo.processInfo.processIdentifier,
            ]])
            if path == "/writer-stalled" {
                // As in startup-stalled, only the fixture withholds pipe reads; product limits stay unchanged.
                Thread.sleep(forTimeInterval: 30)
                return
            }
        }
        if scenario.hasPrefix("startup-") {
            guard let url = openValue["url"] as? String, URL(string: url)?.path == "/startup-final",
                  openValue["privateCommands"] as? [String] == ["fixture.private"]
            else { throw URLError(.cannotParseResponse) }
        }
        if scenario == "idle-after-control" {
            try self.emit(["type": "pong", "id": "fixture-absent", "ok": true])
            Thread.sleep(forTimeInterval: 11.5)
        }
        let packet = self.frame("OCMT", payload: Data([2, 0, 0, 0, 0, 0, 0, 0, 1]) + Data("trigger".utf8))
        if scenario == "partial-prefix" {
            try FileHandle.standardOutput.write(contentsOf: packet.prefix(1))
        } else if scenario == "combined-budget" || scenario == "within-budget" {
            let interval = scenario == "combined-budget" ? 6.0 : 4.0
            try FileHandle.standardOutput.write(contentsOf: packet.prefix(1))
            Thread.sleep(forTimeInterval: interval)
            try FileHandle.standardOutput.write(contentsOf: packet.dropFirst().prefix(39))
            Thread.sleep(forTimeInterval: interval)
            try FileHandle.standardOutput.write(contentsOf: packet.dropFirst(40))
        } else if scenario == "idle-after-control" || scenario == "startup-delayed" || scenario == "startup-claimed" ||
            scenario == "startup-reconnect" || scenario == "writer-overflow"
        {
            try FileHandle.standardOutput.write(contentsOf: packet)
        } else { throw URLError(.unsupportedURL) }
        var writeReceipt = false
        var serverReceipt = false
        while true {
            let (magic, body) = try self.incoming()
            if magic == "OCMT" {
                guard body.count >= 9, body.count - 9 <= 25 * 1024 * 1024,
                      body.first == 1 || body.first == 2, Self.integer(body, at: 1, count: 8) == 0,
                      let text = body.dropFirst(9).withUnsafeBytes({ String(validating: $0, as: UTF8.self) }),
                      try (JSONSerialization
                          .jsonObject(with: Data(text.utf8)) as? [String: Any])?["fixtureServerReceipt"] as? Bool ==
                      true
                else { throw URLError(.cannotParseResponse) }
                serverReceipt = true
                try self.emit(["type": "transport-received"])
            } else {
                guard let receipt = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      receipt["type"] as? String == "transport-sent", receipt["id"] as? Int == 1,
                      receipt["ok"] as? Bool == true, !writeReceipt
                else { throw URLError(.cannotParseResponse) }
                writeReceipt = true
            }
            if writeReceipt, serverReceipt {
                try self.emit(["type": "frame", "frame": [
                    "fixtureAck": 1, "receiptCount": 1, "ok": true,
                    "helperPID": ProcessInfo.processInfo.processIdentifier,
                ]])
            }
        }
    }

    private mutating func emit(_ value: [String: Any]) throws {
        try FileHandle.standardOutput.write(contentsOf: self.frame(
            "OCSC",
            payload: JSONSerialization.data(withJSONObject: value)))
    }

    private mutating func frame(_ magic: String, payload: Data) -> Data {
        self.sent += 1
        var bytes = Data(magic.utf8)
        Self.append(UInt16(1), to: &bytes)
        Self.append(UInt16(0), to: &bytes)
        bytes.append(2)
        Self.append(self.generation, to: &bytes)
        Self.append(self.sent, to: &bytes)
        Self.append(UInt16(self.session.count), to: &bytes)
        Self.append(UInt32(payload.count), to: &bytes)
        bytes.append(self.session)
        bytes.append(payload)
        bytes.append(contentsOf: HMAC<SHA256>.authenticationCode(for: bytes, using: self.key))
        var framed = Data()
        Self.append(UInt32(bytes.count), to: &framed)
        return framed + bytes
    }

    private mutating func incoming() throws -> (String, Data) {
        let length = try Int(Self.integer(Self.read(4), at: 0, count: 4))
        guard (63...Self.frameLimit).contains(length) else { throw URLError(.dataLengthExceedsMaximum) }
        let frame = try Self.read(length), authenticated = frame.dropLast(32)
        guard HMAC<SHA256>.isValidAuthenticationCode(frame.suffix(32), authenticating: authenticated, using: self.key),
              let magic = String(data: authenticated.prefix(4), encoding: .ascii), ["OCSC", "OCMT"].contains(magic),
              Self.integer(authenticated, at: 4, count: 2) == 1, Self.integer(authenticated, at: 6, count: 2) == 0,
              authenticated[8] == 1, Self.integer(authenticated, at: 9, count: 8) == self.generation,
              Self.integer(authenticated, at: 17, count: 8) == self.received + 1,
              Self.integer(authenticated, at: 25, count: 2) == self.session.count,
              Self.integer(authenticated, at: 27, count: 4) == authenticated.count - 31 - self.session.count,
              authenticated.dropFirst(31).prefix(self.session.count) == self.session
        else { throw URLError(.cannotParseResponse) }
        self.received += 1
        return (magic, authenticated.dropFirst(31 + self.session.count))
    }

    private static func read(_ count: Int) throws -> Data {
        var bytes = Data()
        while bytes.count < count {
            guard let part = try FileHandle.standardInput.read(upToCount: count - bytes.count), !part.isEmpty else {
                throw URLError(.networkConnectionLost)
            }
            bytes.append(part)
        }
        return bytes
    }

    private static func append(_ value: some FixedWidthInteger, to data: inout Data) {
        var value = value.bigEndian
        withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
    }

    private static func integer(_ bytes: Data, at offset: Int, count: Int) -> UInt64 {
        bytes.dropFirst(offset).prefix(count).reduce(0) { ($0 << 8) | UInt64($1) }
    }
}
