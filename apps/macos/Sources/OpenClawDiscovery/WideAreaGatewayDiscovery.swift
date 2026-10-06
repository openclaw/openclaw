import Foundation
import OpenClawKit

struct WideAreaGatewayBeacon: Equatable {
    var instanceName: String
    var displayName: String
    var host: String
    var port: Int
    var lanHost: String?
    var tailnetDns: String?
    var gatewayPort: Int?
    var gatewayTls: Bool
    var gatewayDirectReachable: Bool
    var sshPort: Int?
    var cliPath: String?
}

enum WideAreaGatewayDiscovery {
    private static let digPath = "/usr/bin/dig"
    private static let defaultTimeoutSeconds: TimeInterval = 0.2
    // Security: wide-area discovery must trust only the Tailscale MagicDNS resolver.
    // Probing arbitrary tailnet peers lets the fastest responder become DNS-SD authority.
    private static let tailscaleDNSResolver = "100.100.100.100"

    struct DiscoveryContext {
        var tailscaleStatus: @Sendable () async -> String?
        var dig: @Sendable (_ args: [String], _ timeout: TimeInterval) async -> String?

        static let live = DiscoveryContext(
            tailscaleStatus: { await readTailscaleStatus() },
            dig: { args, timeout in
                await BoundedCommand.run(path: digPath, arguments: args, timeout: timeout)
            })
    }

    static func discover(
        timeoutSeconds: TimeInterval = 2.0,
        context: DiscoveryContext = .live) async -> [WideAreaGatewayBeacon]
    {
        let startedAt = Date()
        let remaining = {
            timeoutSeconds - Date().timeIntervalSince(startedAt)
        }

        guard let statusJson = await context.tailscaleStatus(),
              hasTailnetIPv4(statusJson: statusJson),
              let domain = OpenClawBonjour.wideAreaGatewayServiceDomain
        else { return [] }

        let domainTrimmed = domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let nameserver = self.tailscaleDNSResolver
        let budget = max(0, remaining())
        guard budget > 0,
              let ptrRecords = await context.dig(
                  ["+short", "+time=1", "+tries=1", "@\(nameserver)", "_openclaw-gw._tcp.\(domainTrimmed)", "PTR"],
                  min(defaultTimeoutSeconds, budget))
        else { return [] }

        var beacons: [WideAreaGatewayBeacon] = []
        for raw in ptrRecords.split(whereSeparator: \.isNewline) {
            let ptr = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if ptr.isEmpty { continue }
            let ptrName = ptr.hasSuffix(".") ? String(ptr.dropLast()) : ptr
            let suffix = "._openclaw-gw._tcp.\(domainTrimmed)"
            let rawInstanceName = ptrName.hasSuffix(suffix)
                ? String(ptrName.dropLast(suffix.count))
                : ptrName
            let instanceName = self.decodeDnsSdEscapes(rawInstanceName)

            guard let srv = await context.dig(
                ["+short", "+time=1", "+tries=1", "@\(nameserver)", ptrName, "SRV"],
                min(defaultTimeoutSeconds, remaining()))
            else { continue }
            guard let (host, port) = parseSrv(srv) else { continue }

            let txtRaw = await context.dig(
                ["+short", "+time=1", "+tries=1", "@\(nameserver)", ptrName, "TXT"],
                min(self.defaultTimeoutSeconds, remaining()))
            let txtTokens = txtRaw.map(self.parseTxtTokens) ?? []
            let txt = self.mapTxt(tokens: txtTokens)

            let displayName = txt["displayName"] ?? instanceName
            let beacon = WideAreaGatewayBeacon(
                instanceName: instanceName,
                displayName: displayName,
                host: host,
                port: port,
                lanHost: txt["lanHost"],
                tailnetDns: txt["tailnetDns"],
                gatewayPort: parseInt(txt["gatewayPort"]),
                gatewayTls: GatewayDiscoveryText.txtBoolValue(txt, key: "gatewayTls"),
                gatewayDirectReachable: GatewayDiscoveryText.txtBoolValue(txt, key: "gatewayDirectReachable"),
                sshPort: self.parseInt(txt["sshPort"]),
                cliPath: txt["cliPath"])
            beacons.append(beacon)
        }

        return beacons
    }

    private static func hasTailnetIPv4(statusJson: String) -> Bool {
        guard let data = statusJson.data(using: .utf8),
              let status = try? JSONDecoder().decode(TailscaleStatus.self, from: data)
        else { return false }
        return status.selfNode?.tailscaleIPs?.contains(where: TailscaleNetwork.isTailnetIPv4) == true ||
            status.peer?.values
            .contains { $0.tailscaleIPs?.contains(where: TailscaleNetwork.isTailnetIPv4) == true } == true
    }

    private static func readTailscaleStatus() async -> String? {
        let candidates = [
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "tailscale",
        ]

        for candidate in candidates {
            if let result = await BoundedCommand.run(
                path: candidate,
                arguments: ["status", "--json"],
                timeout: 0.7)
            {
                return result
            }
        }

        return nil
    }

    private static func parseSrv(_ stdout: String) -> (String, Int)? {
        let line = stdout
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
        guard let line else { return nil }
        let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        guard parts.count >= 4 else { return nil }
        guard let port = Int(parts[2]), port > 0 else { return nil }
        let host = parts[3].hasSuffix(".") ? String(parts[3].dropLast()) : parts[3]
        return (host, port)
    }

    private static func parseTxtTokens(_ stdout: String) -> [String] {
        stdout.split(whereSeparator: \.isNewline).flatMap { line in
            line.matches(of: /"([^"]*)"/).map { self.unescapeTxt(String($0.1)) }
        }
    }

    private static func unescapeTxt(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\\\", with: "\\")
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\n", with: "\n")
    }

    private static func mapTxt(tokens: [String]) -> [String: String] {
        var out: [String: String] = [:]
        for token in tokens {
            guard let idx = token.firstIndex(of: "=") else { continue }
            let key = String(token[..<idx]).trimmingCharacters(in: .whitespacesAndNewlines)
            let rawValue = String(token[token.index(after: idx)...])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let value = self.decodeDnsSdEscapes(rawValue)
            if !key.isEmpty { out[key] = value }
        }
        return out
    }

    private static func parseInt(_ value: String?) -> Int? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return Int(trimmed)
    }

    private static func decodeDnsSdEscapes(_ value: String) -> String {
        var bytes: [UInt8] = []
        let chars = Array(value)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if ch == "\\", i + 3 < chars.count {
                let digits = String(chars[(i + 1)...(i + 3)])
                if digits.allSatisfy(\.isNumber),
                   let byte = UInt8(digits)
                {
                    bytes.append(byte)
                    i += 4
                    continue
                }
            }
            bytes.append(contentsOf: String(ch).utf8)
            i += 1
        }
        return String(bytes: bytes, encoding: .utf8) ?? value
    }
}

private struct TailscaleStatus: Decodable {
    struct Node: Decodable {
        let tailscaleIPs: [String]?

        private enum CodingKeys: String, CodingKey {
            case tailscaleIPs = "TailscaleIPs"
        }
    }

    let selfNode: Node?
    let peer: [String: Node]?

    private enum CodingKeys: String, CodingKey {
        case selfNode = "Self"
        case peer = "Peer"
    }
}
