import Foundation

enum ESPSetupError: LocalizedError {
    case invalidData, rejected(UInt16), unavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalidData: "The device returned an invalid setup response. Reopen setup on the device."
        case let .rejected(code):
            switch code {
            case 0x104: "Compare the code and confirm on the device first."
            case 0x105: "The device is busy. Wait, or enter the network manually."
            case 0x106: "Close and reopen setup on the device to start a new session."
            case 0x107: "The device no longer has this operation's receipt. Its result is unknown."
            case 0x108: "This setup operation is unsupported. Use USB setup instead."
            case 0x109: "The device's setup owner is unavailable. Use USB setup instead."
            case 0x10B: "Setup expired. Reopen setup and compare the new code."
            default: "The device rejected this setup request (\(code))."
            }
        case let .unavailable(message): message
        }
    }
}

struct ESPSetupDiscovery: Codable, Equatable {
    let ver: String
    let name: String
    let username: String
    let pop: String
    let transport: String

    init(name: String, pop: String) throws {
        guard name.hasPrefix("PROV_OC_"), name.utf8.count == 16,
              name.dropFirst(8).utf8.allSatisfy(Self.isHex),
              pop.utf8.count == 32, pop.utf8.allSatisfy(Self.isHex)
        else { throw ESPSetupError.unavailable("Enter the service name and proof shown on the device.") }
        self.ver = "v1"
        self.name = name
        self.username = "openclaw"
        self.pop = pop
        self.transport = "ble"
    }

    private static func isHex(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...70).contains(byte) || (97...102).contains(byte)
    }

    static func parse(_ input: String) -> Self? {
        guard input.utf8.count <= 512, let data = input.data(using: .utf8),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              value.ver == "v1", value.username == "openclaw", value.transport == "ble",
              let checked = try? Self(name: value.name, pop: value.pop)
        else { return nil }
        return checked
    }
}

enum ESPSetupWire {
    enum Operation: UInt8 { case hello = 1, status, scan, wifi, gateway, cancel }

    struct Frame: Equatable {
        let kind: UInt8
        let id: UInt32
        let total: Int
        let offset: Int
        let payload: Data

        func encoded() throws -> Data {
            guard self.id > 0, self.payload.count <= 448, (0...8192).contains(self.total),
                  (0...8192).contains(self.offset)
            else {
                throw ESPSetupError.invalidData
            }
            var bytes = Data([0x4F, 0x43, 1, kind])
            bytes.appendInteger(self.id)
            bytes.appendInteger(UInt16(self.total))
            bytes.appendInteger(UInt16(self.offset))
            bytes.appendInteger(UInt16(self.payload.count))
            bytes.append(contentsOf: [0, 0])
            bytes.append(self.payload)
            return bytes
        }

        static func decode(_ data: Data) throws -> Self {
            var reader = Reader(data)
            guard try reader.byte() == 0x4F, try reader.byte() == 0x43, try reader.byte() == 1 else {
                throw ESPSetupError.invalidData
            }
            let kind = try reader.byte(), id = try reader.integer(4)
            let total = try reader.integer(2), offset = try reader.integer(2), size = try reader.integer(2)
            guard try reader.integer(2) == 0, id > 0, size <= 448, total <= 8192,
                  reader.remaining == Int(size)
            else { throw ESPSetupError.invalidData }
            let payload = try reader.data(Int(size))
            switch kind {
            case 0x81: guard total > 0, offset <= total, size == 0 else { throw ESPSetupError.invalidData }
            case 0x82: guard total > 0, size > 0, offset + size <= total else { throw ESPSetupError.invalidData }
            case 0xFF: guard total == 0, offset == 0, size == 2 else { throw ESPSetupError.invalidData }
            default: throw ESPSetupError.invalidData
            }
            return Self(kind: kind, id: UInt32(id), total: Int(total), offset: Int(offset), payload: payload)
        }
    }

    struct Network: Identifiable, Equatable {
        let ssid: Data
        let rssi: Int8
        let channel: UInt8
        let security: UInt8
        var id: Data {
            self.ssid
        }

        var label: String {
            String(data: self.ssid, encoding: .utf8) ?? self.ssid.map { String(format: "\\x%02X", $0) }.joined()
        }
    }

    struct Receipt: Equatable {
        let phase: UInt8
        let count: UInt8
        let operation: UInt8
        let outcome: UInt8
        let id: UInt32
        let detail: UInt16
        let saveKnown: Bool
        let saved: Bool
        let progress: UInt8
    }

    struct Response {
        let operation: Operation
        let code: UInt16
        let generation: UInt64
        let id: UInt32
        let body: Data

        func hello() throws -> (phase: UInt8, label: String, model: String, comparison: String) {
            var r = Reader(body)
            let phase = try r.byte()
            guard self.operation == .hello, (1...3).contains(phase) else { throw ESPSetupError.invalidData }
            let label = try r.label(), model = try r.label(), challenge = try r.data(32)
            guard r.remaining == 0 else { throw ESPSetupError.invalidData }
            let hex = challenge.prefix(4).map { String(format: "%02X", $0) }
            return (phase, label, model, hex.prefix(2).joined() + " " + hex.suffix(2).joined())
        }

        func receipt() throws -> Receipt {
            var r = Reader(body)
            let phase = try r.byte(), count = try r.byte(), op = try r.byte(), outcome = try r.byte()
            let id = try UInt32(r.integer(4)), detail = try UInt16(r.integer(2))
            let known = try r.byte(), value = try r.byte(), progress = try r.byte()
            guard self.operation == .status || self.operation == .wifi || self.operation == .gateway,
                  (2...3).contains(phase), count <= 32, [0, 4, 5].contains(op), outcome <= 4,
                  detail <= 7, known <= 1, value <= known, progress <= 5,
                  try r.integer(3) == 0, r.remaining == 0,
                  outcome == 3 ? detail > 0 : detail == 0
            else { throw ESPSetupError.invalidData }
            if op == 0 {
                guard phase == 2, count == 0, outcome == 0, id == 0, detail == 0,
                      known == 0, value == 0, progress == 0, self.id == 0
                else { throw ESPSetupError.invalidData }
            } else {
                guard count > 0, outcome > 0, id > 0, self.id == 0 || self.id == id,
                      self.operation == .status || self.operation.rawValue == op
                else { throw ESPSetupError.invalidData }
            }
            return Receipt(
                phase: phase,
                count: count,
                operation: op,
                outcome: outcome,
                id: id,
                detail: detail,
                saveKnown: known == 1,
                saved: value == 1,
                progress: progress)
        }

        func networks() throws -> (items: [Network], truncated: Bool) {
            var r = Reader(body)
            let count = try Int(r.byte()), truncated = try r.byte(), total = try r.integer(2)
            guard self.operation == .scan, count <= 16, truncated <= 1, total >= count,
                  (truncated == 1) == (total > count)
            else { throw ESPSetupError.invalidData }
            var items: [Network] = []
            for _ in 0..<count {
                let size = try Int(r.byte())
                guard size <= 32 else { throw ESPSetupError.invalidData }
                let ssid = try r.data(size), rssi = try Int8(bitPattern: r.byte())
                let channel = try r.byte(), security = try r.byte()
                guard security <= 2 else { throw ESPSetupError.invalidData }
                items.append(Network(ssid: ssid, rssi: rssi, channel: channel, security: security))
            }
            guard r.remaining == 0 else { throw ESPSetupError.invalidData }
            return (items, truncated == 1)
        }
    }

    static func request(
        _ operation: Operation,
        generation: UInt64,
        id: UInt32 = 0,
        fields: [Data] = []) throws -> Data
    {
        switch operation {
        case .hello:
            guard generation == 0, id == 0, fields.isEmpty else { throw ESPSetupError.invalidData }
        case .status, .scan, .cancel:
            guard generation > 0, fields.isEmpty, operation == .status || id == 0 else {
                throw ESPSetupError.invalidData
            }
        case .wifi:
            guard generation > 0, id > 0, fields.count == 2,
                  (1...32).contains(fields[0].count), fields[1].count <= 64
            else { throw ESPSetupError.invalidData }
        case .gateway:
            guard generation > 0, id > 0, fields.count == 1, (1...4096).contains(fields[0].count) else {
                throw ESPSetupError.invalidData
            }
        }
        var data = Data([1, operation.rawValue, 0, 0])
        data.appendInteger(generation)
        data.appendInteger(id)
        for field in fields {
            guard field.count <= 4096, !field.contains(0) else { throw ESPSetupError.invalidData }
            data.appendInteger(UInt16(field.count))
            data.append(field)
        }
        guard data.count <= 8192 else { throw ESPSetupError.invalidData }
        return data
    }

    static func response(_ data: Data, operation: Operation, generation: UInt64, id: UInt32) throws -> Response {
        var r = Reader(data)
        guard data.count <= 596, try r.byte() == 1, try r.byte() == operation.rawValue else {
            throw ESPSetupError.invalidData
        }
        let code = try UInt16(r.integer(2)), receivedGeneration = try r.integer(8),
            receivedID = try UInt32(r.integer(4))
        guard receivedID == id, receivedGeneration > 0,
              operation == .hello || receivedGeneration == generation
        else { throw ESPSetupError.invalidData }
        if (0x100...0x10B).contains(code) {
            guard r.remaining == 0 else { throw ESPSetupError.invalidData }
            throw ESPSetupError.rejected(code)
        }
        let mutation = operation == .wifi || operation == .gateway
        guard mutation ? (code == 1 || code == 2) : code == 0 else {
            throw ESPSetupError.invalidData
        }
        return try Response(
            operation: operation,
            code: code,
            generation: receivedGeneration,
            id: id,
            body: r.data(r.remaining))
    }

    private struct Reader {
        let bytes: [UInt8]
        var offset = 0
        init(_ data: Data) {
            self.bytes = Array(data)
        }

        var remaining: Int {
            self.bytes.count - self.offset
        }

        mutating func byte() throws -> UInt8 {
            try UInt8(self.integer(1))
        }

        mutating func integer(_ count: Int) throws -> UInt64 {
            guard count <= self.remaining else { throw ESPSetupError.invalidData }
            defer { offset += count }
            return self.bytes[self.offset..<(self.offset + count)].reduce(0) { ($0 << 8) | UInt64($1) }
        }

        mutating func data(_ count: Int) throws -> Data {
            guard count <= self.remaining else { throw ESPSetupError.invalidData }
            defer { offset += count }
            return Data(self.bytes[self.offset..<(self.offset + count)])
        }

        mutating func label() throws -> String {
            let count = try Int(byte())
            guard (1...64).contains(count) else { throw ESPSetupError.invalidData }
            let value = try data(count)
            guard !value.contains(0), let label = String(bytes: value, encoding: .utf8) else {
                throw ESPSetupError.invalidData
            }
            return label
        }
    }
}

extension Data {
    fileprivate mutating func appendInteger(_ value: some FixedWidthInteger) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }
}
