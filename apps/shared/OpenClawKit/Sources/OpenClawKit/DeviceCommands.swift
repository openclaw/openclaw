import Foundation

public enum EasyHubDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum EasyHubBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum EasyHubThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum EasyHubNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum EasyHubNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct EasyHubBatteryStatusPayload: Codable, Sendable, Equatable {
    public var level: Double?
    public var state: EasyHubBatteryState
    public var lowPowerModeEnabled: Bool

    public init(level: Double?, state: EasyHubBatteryState, lowPowerModeEnabled: Bool) {
        self.level = level
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct EasyHubThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: EasyHubThermalState

    public init(state: EasyHubThermalState) {
        self.state = state
    }
}

public struct EasyHubStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct EasyHubNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: EasyHubNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [EasyHubNetworkInterfaceType]

    public init(
        status: EasyHubNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [EasyHubNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct EasyHubDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: EasyHubBatteryStatusPayload
    public var thermal: EasyHubThermalStatusPayload
    public var storage: EasyHubStorageStatusPayload
    public var network: EasyHubNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: EasyHubBatteryStatusPayload,
        thermal: EasyHubThermalStatusPayload,
        storage: EasyHubStorageStatusPayload,
        network: EasyHubNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct EasyHubDeviceInfoPayload: Codable, Sendable, Equatable {
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
