import Foundation

public enum MullusiDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum MullusiBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum MullusiThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum MullusiNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum MullusiNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct MullusiBatteryStatusPayload: Codable, Sendable, Equatable {
    public var level: Double?
    public var state: MullusiBatteryState
    public var lowPowerModeEnabled: Bool

    public init(level: Double?, state: MullusiBatteryState, lowPowerModeEnabled: Bool) {
        self.level = level
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct MullusiThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: MullusiThermalState

    public init(state: MullusiThermalState) {
        self.state = state
    }
}

public struct MullusiStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct MullusiNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: MullusiNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [MullusiNetworkInterfaceType]

    public init(
        status: MullusiNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [MullusiNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct MullusiDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: MullusiBatteryStatusPayload
    public var thermal: MullusiThermalStatusPayload
    public var storage: MullusiStorageStatusPayload
    public var network: MullusiNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: MullusiBatteryStatusPayload,
        thermal: MullusiThermalStatusPayload,
        storage: MullusiStorageStatusPayload,
        network: MullusiNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct MullusiDeviceInfoPayload: Codable, Sendable, Equatable {
    public var deviceName: String
    public var modelIdentifier: String
    public var systemName: String
    public var systemVersion: String
    public var appVersion: String
    public var appBuild: String
    public var locale: String

    public init(
        deviceName: String,
        modelIdentifier: String,
        systemName: String,
        systemVersion: String,
        appVersion: String,
        appBuild: String,
        locale: String)
    {
        self.deviceName = deviceName
        self.modelIdentifier = modelIdentifier
        self.systemName = systemName
        self.systemVersion = systemVersion
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.locale = locale
    }
}
