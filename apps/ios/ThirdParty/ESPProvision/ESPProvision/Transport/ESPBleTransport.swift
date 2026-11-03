// Copyright 2020 Espressif Systems
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
//  ESPBLETransport.swift
//  ESPProvision
//

import CoreBluetooth
import Foundation

/// This lists the keys for the values that we need to retrieve from the BLE advertisement data
struct ESPBLEAdvertisementKeys {
    
    static let localDeviceName = "kCBAdvDataLocalName"
    static let serviceUUIDs = "kCBAdvDataServiceUUIDs"
}

/// The `ESPBLEStatusDelegate` protocol define methods that provide information
/// of current BLE device connection status
protocol ESPBLEStatusDelegate {
    
    /// Peripheral is connected successfully.
    func peripheralConnected()
    
    /// Failed to connect with peripheral.
    ///
    /// - Parameter peripheral: CBPeripheral for which callback is recieved.
    func peripheralFailedToConnect(peripheral: CBPeripheral?, error: Error?)

    /// Peripheral device disconnected
    ///
    /// - Parameters:
    ///   - peripheral: CBPeripheral for which callback is recieved.
    ///   - error: Error description
    func peripheralDisconnected(peripheral: CBPeripheral, error: Error?)
    
}

/// Delegate which will receive events relating to BLE device scanning
protocol ESPBLETransportDelegate {
    /// Peripheral devices found with matching Service UUID
    /// Callers should call the BLETransport.connect method with
    /// one of the peripherals found here
    ///
    /// - Parameter peripherals: peripheral devices array
    func peripheralsFound(peripherals: [String:ESPDevice])

    /// No peripherals found with matching Service UUID
    ///
    /// - Parameter serviceUUID: the service UUID provided at the time of creating the BLETransport object
    func peripheralsNotFound(serviceUUID: UUID?)

}

/// The `ESPBleTransport` class conforms and implememnt methods of `ESPCommunicable` protocol.
/// This class provides methods for sending configuration and session related data to  `ESPDevice`.
class ESPBleTransport: NSObject, ESPCommunicable {
    
    /// Instance of 'ESPUtility' class.
    var utility: ESPUtility

    private var isBLEEnabled = false
    private var scanTimeout = 5.0
    private var readCounter = 0
    private var deviceNamePrefix:String!
    
    /// Stores Proof of Possesion for a device.
    var proofOfPossession:String?
    /// Store username for device
    var username:String?
    /// Store network for device
    var network: ESPNetworkType?

    
    var centralManager: CBCentralManager!
    var espressifPeripherals: [String:ESPDevice] = [:]
    var currentPeripheral: CBPeripheral?
    var currentAdvertisementData: [String: Any]?
    var currentService: CBService?
    var bleConnectTimer = Timer()
    var bleScanTimer: Timer?
    var bleDeviceConnected = false

    var peripheralCanRead: Bool = true
    var peripheralCanWrite: Bool = false

    var currentRequestCompletionHandler: ((Data?, Error?) -> Void)?

    /// Serializes BLE read/write operations without blocking the calling thread.
    /// All access is confined to the main queue (the CBCentralManager delegate queue),
    /// so no lock is required. A blocking primitive here would deadlock, since the
    /// callbacks that complete a request are also delivered on the main queue.
    private var isRequestInFlight = false
    private var pendingRequests: [() -> Void] = []

    public var delegate: ESPBLETransportDelegate?
    var bleStatusDelegate: ESPBLEStatusDelegate?
    

    /// Create BLETransport object.
    ///
    /// - Parameters:
    ///   - deviceNamePrefix: Device name prefix.
    ///   - scanTimeout: Timeout in seconds for which BLE scan should happen.
    init(scanTimeout: TimeInterval, deviceNamePrefix: String, proofOfPossession:String? = nil, username: String? = nil, network: ESPNetworkType? = nil) {
        ESPLog.log("Initalising BLE transport class with scan timeout \(scanTimeout)")
        self.scanTimeout = scanTimeout
        self.deviceNamePrefix = deviceNamePrefix
        self.proofOfPossession = proofOfPossession
        self.username = username
        self.network = network
        utility = ESPUtility()
        super.init()
        centralManager = CBCentralManager(delegate: self, queue: nil)
    }

    /// Enqueue a BLE request. Runs immediately when idle, otherwise queued (FIFO) until the
    /// in-flight request completes. Never blocks the caller, so it is safe on the main thread.
    private func submitRequest(_ execute: @escaping () -> Void) {
        if Thread.isMainThread {
            startOrQueueRequest(execute)
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.startOrQueueRequest(execute)
            }
        }
    }

    /// Main-queue only.
    private func startOrQueueRequest(_ execute: @escaping () -> Void) {
        if isRequestInFlight {
            pendingRequests.append(execute)
        } else {
            isRequestInFlight = true
            execute()
        }
    }

    /// Advance to the next queued request, or mark the transport idle. Main-queue only.
    private func startNextRequestIfNeeded() {
        if pendingRequests.isEmpty {
            isRequestInFlight = false
        } else {
            let next = pendingRequests.removeFirst()
            DispatchQueue.main.async { next() }
        }
    }

    /// Wrap a request completion so the transport advances its queue after delivering the result.
    private func makeSerializedCompletion(_ completionHandler: @escaping (Data?, Error?) -> Void) -> (Data?, Error?) -> Void {
        return { [weak self] data, error in
            completionHandler(data, error)
            if Thread.isMainThread {
                self?.startNextRequestIfNeeded()
            } else {
                DispatchQueue.main.async { self?.startNextRequestIfNeeded() }
            }
        }
    }

    /// Deliver an immediate failure (a guard failed before the write) and advance the queue.
    /// Runs on the main queue as part of an in-flight request closure.
    private func failCurrentRequest(_ completionHandler: @escaping (Data?, Error?) -> Void, error: Error) {
        completionHandler(nil, error)
        startNextRequestIfNeeded()
    }

    private func deliverTransportResponse(_ data: Data?, error: Error?) {
        let handler = currentRequestCompletionHandler
        currentRequestCompletionHandler = nil
        handler?(data, error)
    }

    /// BLE implementation of `ESPCommunicable` protocol.
    ///
    /// - Parameters:
    ///   - data: Data to be sent.
    ///   - sessionPath: Not required.
    ///   - completionHandler: Handler called when data is sent.
    func SendSessionData(data: Data, sessionPath: String?, completionHandler: @escaping (Data?, Error?) -> Void) {
        ESPLog.log("Sending session data.")
        submitRequest { [weak self] in
            guard let self = self else { return }
            guard self.peripheralCanWrite, self.peripheralCanRead,
                let espressifPeripheral = self.currentPeripheral,
                let sessionCharacteristic = self.utility.sessionCharacteristic else {
                self.failCurrentRequest(completionHandler, error: ESPTransportError.deviceUnreachableError("BLE device unreachable"))
                return
            }
            self.currentRequestCompletionHandler = self.makeSerializedCompletion(completionHandler)
            espressifPeripheral.writeValue(data, for: sessionCharacteristic, type: .withResponse)
        }
    }

    /// BLE implemenation of the `ESPCommunicable` protocol
    ///
    /// - Parameters:
    ///   - path: Path of the configuration endpoint.
    ///   - data: Data to be sent.
    ///   - completionHandler: Handler called when data is sent.
    func SendConfigData(path: String,
                        data: Data,
                        completionHandler: @escaping (Data?, Error?) -> Void) {
        ESPLog.log("Sending configration data to path \(path)")
        submitRequest { [weak self] in
            guard let self = self else { return }
            guard self.peripheralCanWrite, self.peripheralCanRead,
                let espressifPeripheral = self.currentPeripheral else {
                self.failCurrentRequest(completionHandler, error: ESPTransportError.deviceUnreachableError("BLE device unreachable"))
                return
            }
            if let characteristic = self.utility.configUUIDMap[path] {
                self.currentRequestCompletionHandler = self.makeSerializedCompletion(completionHandler)
                espressifPeripheral.writeValue(data, for: characteristic, type: .withResponse)
            } else {
                self.failCurrentRequest(completionHandler, error: NSError(domain: "com.espressif.ble", code: 1, userInfo: [NSLocalizedDescriptionKey: "BLE characteristic does not exist."]))
            }
        }
    }

    /// Connect to a BLE peripheral device.
    ///
    /// - Parameters:
    ///   - peripheral: The peripheral device
    ///   - advertisementData: The peripheral advertisement data
    ///   - options: An optional dictionary specifying connection behavior options.
    ///              Sent as is to the CBCentralManager.connect function.
    func connect(peripheral: CBPeripheral, withAdvertisementData advertisementData: [String: Any]?, withOptions options: [String: Any]?, delegate: ESPBLEStatusDelegate) {
        ESPLog.log("Connecting peripheral device...")
        self.bleStatusDelegate = delegate
        if let currentPeripheral = currentPeripheral {
            centralManager.cancelPeripheralConnection(currentPeripheral)
        }
        readCounter = 0
        currentPeripheral = peripheral
        currentAdvertisementData = advertisementData
        centralManager.connect(currentPeripheral!, options: options)
        currentPeripheral?.delegate = self
        bleDeviceConnected = false
        bleConnectTimer.invalidate()
        ESPLog.log("Initiating timeout for connection completion.")
        bleConnectTimer = Timer.scheduledTimer(timeInterval: 20, target: self, selector: #selector(bleConnectionTimeout), userInfo: nil, repeats: false)
    }

    /// Drop the current ATT connection and connect again so CoreBluetooth
    /// rediscovers characteristics. Needed when a long-lived local-control
    /// session has stale handles (CBATTError 1 on `prov-config`).
    func reconnect(delegate: ESPBLEStatusDelegate) {
        bleStatusDelegate = delegate
        resetGATTMapForReconnect()
        bleDeviceConnected = false
        pendingRequests.removeAll()
        isRequestInFlight = false
        currentRequestCompletionHandler = nil
        guard let peripheral = currentPeripheral else {
            delegate.peripheralFailedToConnect(peripheral: nil, error: NSError(domain: "com.espressif.ble", code: 3, userInfo: [NSLocalizedDescriptionKey: "No BLE peripheral to reconnect."]))
            return
        }
        currentPeripheral?.delegate = self
        bleConnectTimer.invalidate()
        ESPLog.log("Initiating timeout for BLE reconnect.")
        bleConnectTimer = Timer.scheduledTimer(timeInterval: 20, target: self, selector: #selector(bleConnectionTimeout), userInfo: nil, repeats: false)
        if peripheral.state == .connected || peripheral.state == .connecting {
            reconnectPending = true
            centralManager.cancelPeripheralConnection(peripheral)
        } else {
            reconnectPending = false
            centralManager.connect(peripheral, options: nil)
        }
    }

    private var reconnectPending = false

    private func resetGATTMapForReconnect() {
        utility.configUUIDMap.removeAll()
        utility.sessionCharacteristic = nil
        utility.peripheralConfigured = false
        readCounter = 0
    }
    
    /// This method is invoked on timeout of connection with BLE device.
    @objc func bleConnectionTimeout() {
        if !bleDeviceConnected {
            ESPLog.log("Peripheral connection timeout occured.")
            reconnectPending = false
            self.disconnect()
            bleConnectTimer.invalidate()
            bleStatusDelegate?.peripheralFailedToConnect(peripheral: nil, error: NSError(domain: "com.espressif.ble", code: 2, userInfo: [NSLocalizedDescriptionKey:"Connection timeout. Unable to read BLE characteristic on time."]))
        }
    }

    /// Disconnect from the current connected peripheral.
    func disconnect() {
        if let currentPeripheral = currentPeripheral {
            ESPLog.log("Cancelling peripheral connection.")
            centralManager.cancelPeripheralConnection(currentPeripheral)
        }
    }

    /// Scan for BLE devices.
    ///
    /// - Parameter delegate: Delegate which will receive resulting events.
    func scan(delegate: ESPBLETransportDelegate) {
        
        ESPLog.log("Ble scan started...")
        
        self.delegate = delegate

        if isBLEEnabled {
            bleScanTimer?.invalidate()
            bleScanTimer = Timer.scheduledTimer(timeInterval: scanTimeout,
                                     target: self,
                                     selector: #selector(stopScan(timer:)),
                                     userInfo: nil,
                                     repeats: true)
            centralManager.scanForPeripherals(withServices: nil)
        }
    }

    /// Stop scan when timer runs off.
    @objc func stopScan(timer: Timer) {
        
        ESPLog.log("Ble scan stopped.")
        
        centralManager.stopScan()
        timer.invalidate()
        if espressifPeripherals.count > 0 {
            delegate?.peripheralsFound(peripherals: espressifPeripherals)
            espressifPeripherals.removeAll()
        } else {
            delegate?.peripheralsNotFound(serviceUUID: UUID(uuidString: ""))
        }
    }
    
    // Stop scan and invalidate timer
    func stopSearch() {
        ESPLog.log("Ble search stopped.")
        centralManager.stopScan()
        bleScanTimer?.invalidate()
        espressifPeripherals.removeAll()
        delegate?.peripheralsNotFound(serviceUUID: UUID(uuidString: ""))
    }

    /// BLE implementation of `ESPCommunicable` protocol.
    func isDeviceConfigured() -> Bool {
        ESPLog.log("Device configured status: \(utility.peripheralConfigured)")
        return utility.peripheralConfigured
    }
}

// MARK: CBCentralManagerDelegate

extension ESPBleTransport: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .unknown:
            ESPLog.log("Bluetooth state unknown")
        case .resetting:
            ESPLog.log("Bluetooth state resetting")
        case .unsupported:
            ESPLog.log("Bluetooth state unsupported")
        case .unauthorized:
            ESPLog.log("Bluetooth state unauthorized")
        case .poweredOff:
            ESPLog.log("Bluetooth state off")
        case .poweredOn:
            ESPLog.log("Bluetooth state on")
            isBLEEnabled = true
            bleScanTimer = Timer.scheduledTimer(timeInterval: scanTimeout,
                                     target: self,
                                     selector: #selector(stopScan(timer:)),
                                     userInfo: nil,
                                     repeats: true)
            centralManager.scanForPeripherals(withServices: nil)
        @unknown default: break
        }
    }

    func centralManager(_: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData data: [String: Any],
                        rssi _: NSNumber) {
        ESPLog.log("Peripheral devices discovered.\(data.debugDescription)")
        if let peripheralName = data["kCBAdvDataLocalName"] as? String ?? peripheral.name  {
            if peripheralName.lowercased().hasPrefix(deviceNamePrefix.lowercased()) {
                let newEspDevice  = ESPDevice(name: peripheralName, security: .secure, transport: .ble, advertisementData: data)
                espressifPeripherals[peripheralName] = newEspDevice
                newEspDevice.peripheral = peripheral
            }
        }
    }

    func centralManager(_: CBCentralManager, didConnect _: CBPeripheral) {
        ESPLog.log("Connected to peripheral. Discover services.")
        if let advertisementData = currentAdvertisementData {
            if let serviceUUID = advertisementData[ESPBLEAdvertisementKeys.serviceUUIDs] as? CBUUID {
                currentPeripheral?.discoverServices([serviceUUID])
            } else if let serviceUUIDs = advertisementData[ESPBLEAdvertisementKeys.serviceUUIDs] as? [CBUUID], serviceUUIDs.count > 0 {
                let serviceUUID = serviceUUIDs[0]
                currentPeripheral?.discoverServices([serviceUUID])
            }
        } else {
            currentPeripheral?.discoverServices(nil)
        }
    }

    func centralManager(_: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        ESPLog.log("Fail to connect to peripheral.")
        bleStatusDelegate?.peripheralFailedToConnect(peripheral: peripheral, error: error)
    }

    func centralManager(_: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        ESPLog.log("Disconnected with peripheral")
        if reconnectPending {
            reconnectPending = false
            resetGATTMapForReconnect()
            currentPeripheral?.delegate = self
            centralManager.connect(peripheral, options: nil)
            return
        }
        bleStatusDelegate?.peripheralDisconnected(peripheral: peripheral, error: error)
    }
}

// MARK: CBPeripheralDelegate

extension ESPBleTransport: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices _: Error?) {
        ESPLog.log("Peripheral did discover services.")
        guard let services = peripheral.services else { return }
        currentPeripheral = peripheral
        currentService = services[0]
        if let currentService = currentService {
            currentPeripheral?.discoverCharacteristics(nil, for: currentService)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error _: Error?) {
        
        ESPLog.log("Peripheral did discover chatacteristics.")
        guard let characteristics = service.characteristics else { return }

        peripheralCanWrite = true
        for characteristic in characteristics {
            if !characteristic.properties.contains(.read) {
                peripheralCanRead = false
            }
            if !characteristic.properties.contains(.write) {
                peripheralCanWrite = false
            }
            currentPeripheral?.discoverDescriptors(for: characteristic)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        
        ESPLog.log("Writing value for characterisitic \(characteristic)")
        guard error == nil else {
            deliverTransportResponse(nil, error: error)
            return
        }

        peripheral.readValue(for: characteristic)
    }

    func peripheral(_: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        ESPLog.log("Updating value for characterisitic \(characteristic)")
        guard error == nil else {
            deliverTransportResponse(nil, error: error)
            return
        }

        guard currentRequestCompletionHandler != nil else {
            return
        }
        let responseData = characteristic.value
        DispatchQueue.global().async { [weak self] in
            self?.deliverTransportResponse(responseData, error: nil)
        }
    }

    func peripheral(_: CBPeripheral, didDiscoverDescriptorsFor characteristic: CBCharacteristic, error _: Error?) {
        ESPLog.log("Did sicover descriptor for characterisitic: \(characteristic)")
        var finalDescriptors = [CBDescriptor]()
        for descriptor in characteristic.descriptors! {
            let uuidString = descriptor.uuid.uuidString
            if uuidString.contains(ESPConstants.user_descriptor_uuid) {
                finalDescriptors.append(descriptor)
            }
        }
        if finalDescriptors.count > 0 {
            readCounter += finalDescriptors.count
            for desc in finalDescriptors {
                currentPeripheral?.readValue(for: desc)
            }
        }
    }

    func peripheral(_: CBPeripheral, didUpdateValueFor descriptor: CBDescriptor, error _: Error?) {
        ESPLog.log("Did update value for descriptor: \(descriptor)")
        utility.processDescriptor(descriptor: descriptor)
        readCounter -= 1
        if readCounter < 1 {
            if utility.peripheralConfigured {
                bleConnectTimer.invalidate()
                bleStatusDelegate?.peripheralConnected()
            }
        }
    }
}
