import Foundation
import Observation

@MainActor
protocol ESPSetupLink: AnyObject {
    var disconnected: (() -> Void)? { get set }
    func connect(_ discovery: ESPSetupDiscovery) async throws
    func exchange(_ plaintext: Data) async throws -> Data
    func close()
}

/// Ephemeral owner for one authenticated setup session. Transfer IDs identify byte
/// exchanges; operation IDs survive status polls, but never survive reconnection.
@MainActor
@Observable
final class ESPSetupSession {
    enum Phase { case idle, connecting, comparing, ready, working, closed }
    private(set) var phase: Phase = .idle
    private(set) var deviceLabel = ""
    private(set) var model = ""
    private(set) var comparison = ""
    private(set) var message = ""
    private(set) var networks: [ESPSetupWire.Network] = []
    private(set) var truncated = false
    private(set) var receipt: ESPSetupWire.Receipt?
    private(set) var generation: UInt64 = 0
    private let link: any ESPSetupLink
    private var transferID: UInt32 = 0
    private var operationID: UInt32 = 0
    private var deadline = ContinuousClock.now
    private var expiry: Task<Void, Never>?

    init(link: any ESPSetupLink) {
        self.link = link
        link.disconnected = { [weak self] in
            self?.close(message: "The device disconnected. A submitted change may have an unknown result.")
        }
    }

    func connect(_ discovery: ESPSetupDiscovery) async {
        guard self.phase == .idle else { return }
        self.phase = .connecting
        self.deadline = .now.advanced(by: .seconds(120))
        self.expiry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(120)) } catch { return }
            self?.close(message: "Setup expired. Reopen setup on the device and compare the new code.")
        }
        do {
            try await self.link.connect(discovery)
            try self.checkCurrent()
            while true {
                let response = try await self.request(.hello)
                let hello = try response.hello()
                if self.generation != 0 {
                    guard self.generation == response.generation, self.comparison == hello.comparison,
                          self.deviceLabel == hello.label, self.model == hello.model
                    else { throw ESPSetupError.invalidData }
                }
                self.generation = response.generation
                self.deviceLabel = hello.label
                self.model = hello.model
                self.comparison = hello.comparison
                if hello.phase == 2 {
                    self.phase = .ready
                    self.message = "Device confirmed. Choose a network or Gateway to apply."
                    return
                }
                self.phase = .comparing
                self.message = "Compare this code with the device. Confirm using the device's physical controls."
                try await Task.sleep(for: .milliseconds(300))
                try self.checkCurrent()
            }
        } catch { self.fail(error) }
    }

    func scan() async {
        await self.run {
            let result = try await self.request(.scan).networks()
            // Several APs may advertise the same byte-identical SSID. The native
            // Wi-Fi owner accepts an SSID, not a BSSID; retain the strongest row.
            let grouped = Dictionary(grouping: result.items, by: \.ssid)
            self.networks = grouped.values.compactMap { $0.max { $0.rssi < $1.rssi } }
                .sorted { $0.rssi > $1.rssi }
            self.truncated = result.truncated
            self.message = result.truncated
                ? "More networks are available. You can enter an SSID manually."
                : "Choose a network, or enter an SSID manually."
        }
    }

    func applyWiFi(ssid: Data, password: String) async {
        await self.apply(.wifi, fields: [ssid, Data(password.utf8)])
    }

    func applyGateway(code: String, authorize: @MainActor () async throws -> Void) async {
        await self.apply(.gateway, fields: [Data(code.utf8)], authorize: authorize)
    }

    func close(message: String = "Setup closed. Earlier saved changes are not rolled back.") {
        guard self.phase != .closed else { return }
        self.phase = .closed
        self.expiry?.cancel()
        self.expiry = nil
        self.networks = []
        self.deviceLabel = ""
        self.model = ""
        self.comparison = ""
        self.generation = 0
        self.message = message
        self.link.disconnected = nil
        self.link.close()
    }

    private func apply(
        _ operation: ESPSetupWire.Operation,
        fields: [Data],
        authorize: @MainActor () async throws -> Void = {}) async
    {
        await self.run {
            guard self.operationID < UInt32.max else { throw ESPSetupError.rejected(0x106) }
            self.operationID += 1
            let id = self.operationID
            self.receipt = try await self.request(operation, id: id, fields: fields, authorize: authorize).receipt()
            guard self.receipt?.operation == operation.rawValue else { throw ESPSetupError.invalidData }
            while self.receipt?.outcome == 1 {
                self.message = "The device accepted the change. Waiting for its result…"
                try await Task.sleep(for: .milliseconds(500))
                self.receipt = try await self.request(.status, id: id, authorize: authorize).receipt()
                guard self.receipt?.operation == operation.rawValue else { throw ESPSetupError.invalidData }
            }
            self.message = self.receiptMessage
        }
    }

    var receiptMessage: String {
        guard let receipt else { return "No change has been submitted." }
        let outcome = switch receipt.outcome {
        case 1: "Change accepted; its final result is pending."
        case 2: "The device reports success."
        case 3: "The device reports failure (category \(receipt.detail))."
        default: "The device could not establish the final result. Check it before retrying."
        }
        let save = receipt.saveKnown
            ? (receipt.saved ? "This attempt confirmed a save." : "This attempt has not confirmed a save.")
            : "Save status for this attempt is unknown."
        return outcome + " " + save +
            (receipt.progress == 4 ? " Device recovery is required; use its local controls." : "")
    }

    private func run(_ action: () async throws -> Void) async {
        guard self.phase == .ready else { return }
        self.phase = .working
        do {
            try self.checkCurrent()
            try await action()
            try self.checkCurrent()
            self.phase = .ready
        } catch { self.fail(error) }
    }

    private func fail(_ error: Error) {
        if case let ESPSetupError.rejected(code) = error, [0x105, 0x108, 0x109].contains(code), self.phase != .closed {
            self.phase = .ready
            self.message = error.localizedDescription
        } else if self.phase != .closed {
            self.close(message: error is CancellationError
                ? "Setup cancelled. Earlier changes are not rolled back."
                : error.localizedDescription)
        }
    }

    private func checkCurrent() throws {
        try Task.checkCancellation()
        guard self.phase != .closed, ContinuousClock.now < self.deadline else { throw CancellationError() }
    }

    private func request(
        _ operation: ESPSetupWire.Operation,
        id: UInt32 = 0,
        fields: [Data] = [],
        authorize: @MainActor () async throws -> Void = {}) async throws -> ESPSetupWire.Response
    {
        try self.checkCurrent()
        guard self.transferID < UInt32.max else { throw ESPSetupError.rejected(0x106) }
        self.transferID += 1
        let transfer = self.transferID
        let generation = operation == .hello ? 0 : self.generation
        let request = try ESPSetupWire.request(operation, generation: generation, id: id, fields: fields)
        var offset = 0
        while offset < request.count {
            let end = min(offset + 448, request.count)
            let frame = ESPSetupWire.Frame(
                kind: 1,
                id: transfer,
                total: request.count,
                offset: offset,
                payload: request.subdata(in: offset..<end))
            let ack = try await self.exchange(frame, authorize: authorize)
            guard ack.kind == 0x81, ack.total == request.count, ack.offset == end else {
                throw ESPSetupError.invalidData
            }
            offset = end
        }
        var response = Data(), total = 0
        repeat {
            let pull = ESPSetupWire.Frame(kind: 2, id: transfer, total: 0, offset: response.count, payload: Data())
            let fragment = try await self.exchange(pull, authorize: authorize)
            guard fragment.kind == 0x82, fragment.offset == response.count, fragment.total <= 596,
                  total == 0 || fragment.total == total else { throw ESPSetupError.invalidData }
            total = fragment.total
            response.append(fragment.payload)
        } while response.count < total
        return try ESPSetupWire.response(response, operation: operation, generation: generation, id: id)
    }

    private func exchange(
        _ frame: ESPSetupWire.Frame,
        authorize: @MainActor () async throws -> Void) async throws -> ESPSetupWire.Frame
    {
        let plaintext = try frame.encoded()
        while true {
            try await authorize()
            try self.checkCurrent()
            let response = try await ESPSetupWire.Frame.decode(self.link.exchange(plaintext))
            try await authorize()
            try self.checkCurrent()
            guard response.id == frame.id else { throw ESPSetupError.invalidData }
            guard response.kind == 0xFF else { return response }
            let code = response.payload.reduce(UInt16(0)) { ($0 << 8) | UInt16($1) }
            guard code == 5 else {
                throw ESPSetupError
                    .unavailable(
                        "Device transfer failed (\(code)). Reopen setup; check any submitted change before retrying.")
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}
