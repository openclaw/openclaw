import CoreBluetooth
@preconcurrency import ESPProvision
import Foundation

/// One SDK connection and one plaintext exchange at a time. Never reconnect this
/// object: after an uncertain exchange the SDK's AES counters may have diverged.
@MainActor
final class ESPSetupBLELink: NSObject, ESPSetupLink {
    var disconnected: (() -> Void)?
    private var device: ESPDevice?
    private var used = false
    private var pending: CheckedContinuation<Data, Error>?
    private var pendingID: UUID?
    private var timeout: Task<Void, Never>?

    func connect(_ discovery: ESPSetupDiscovery) async throws {
        guard !self.used else { throw ESPSetupError.unavailable("Reopen setup to connect again.") }
        self.used = true
        ESPProvisionManager.shared.enableLogs(false)
        let expectedName = discovery.name
        _ = try await self.perform(seconds: 30) { id in
            ESPProvisionManager.shared.createESPDevice(
                deviceName: discovery.name,
                transport: .ble,
                security: .secure2,
                proofOfPossession: discovery.pop,
                username: discovery.username)
            { [weak self] device, _ in
                // Device discovery uses the SDK's main-queue CoreBluetooth manager/timer.
                MainActor.assumeIsolated {
                    guard let self, self.pendingID == id else {
                        device?.proofOfPossession = nil
                        return
                    }
                    guard let device, device.name == expectedName else {
                        self.finish(id, .failure(ESPSetupError.unavailable(
                            "Device not found. Check Bluetooth permission and reopen setup on the device.")))
                        return
                    }
                    self.device = device
                    device.bleDelegate = self
                    device.connect { [weak self] status in
                        let connected = if case .connected = status {
                            true
                        } else {
                            false
                        }
                        Task { @MainActor [weak self] in
                            guard let self, self.pendingID == id else { return }
                            if connected {
                                self.device?.proofOfPossession = nil
                                self.finish(id, .success(Data()))
                            } else {
                                self.finish(id, .failure(ESPSetupError.unavailable(
                                    "Secure setup failed. Check the proof and open a new setup session.")))
                            }
                        }
                    }
                }
            }
        }
    }

    func exchange(_ plaintext: Data) async throws -> Data {
        guard plaintext.count <= 464, let device = self.device, device.isSessionEstablished() else {
            throw ESPSetupError.unavailable("The secure device connection is closed.")
        }
        return try await self.perform(seconds: 20) { id in
            device.sendData(path: "oc-setup", data: plaintext) { [weak self] data, error in
                let validData = error == nil ? data : nil
                Task { @MainActor [weak self] in
                    guard let self, self.pendingID == id else { return }
                    if let validData {
                        self.finish(id, .success(validData))
                    } else {
                        self.finish(id, .failure(ESPSetupError.unavailable(
                            "The secure exchange failed. An in-flight change may have an unknown result.")))
                    }
                }
            }
        }
    }

    func close() {
        if let id = self.pendingID { self.finish(id, .failure(CancellationError())) }
        ESPProvisionManager.shared.stopESPDevicesSearch()
        let device = self.device
        self.device = nil
        device?.proofOfPossession = nil
        device?.username = nil
        device?.bleDelegate = nil
        device?.delegate = nil
        device?.disconnect()
    }

    private func perform(seconds: UInt64, start: (UUID) -> Void) async throws -> Data {
        guard self.pending == nil else { throw ESPSetupError.unavailable("Wait for the current exchange.") }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.pending = continuation
                self.pendingID = id
                self.timeout = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) } catch { return }
                    guard let self, self.pendingID == id else { return }
                    self.finish(id, .failure(ESPSetupError.unavailable(
                        "Device setup timed out. A submitted change may have an unknown result.")))
                    self.close()
                }
                start(id)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, self.pendingID == id else { return }
                self.close()
            }
        }
    }

    private func finish(_ id: UUID, _ result: Result<Data, Error>) {
        guard self.pendingID == id else { return }
        let continuation = self.pending
        self.pending = nil
        self.pendingID = nil
        self.timeout?.cancel()
        self.timeout = nil
        continuation?.resume(with: result)
    }
}

extension ESPSetupBLELink: ESPBLEDelegate {
    nonisolated func peripheralConnected() {}

    nonisolated func peripheralDisconnected(peripheral _: CBPeripheral, error _: Error?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.close()
            self.disconnected?()
        }
    }

    nonisolated func peripheralFailedToConnect(peripheral _: CBPeripheral?, error _: Error?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.close()
            self.disconnected?()
        }
    }
}
