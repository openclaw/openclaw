import Foundation

public enum SmartAgentNeoDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum SmartAgentNeoBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum SmartAgentNeoThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum OpenNeoNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum OpenNeoNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct SmartAgentNeoBatteryStatusPayload: Codable, Sendable, Equatable {
    public var level: Double?
    public var state: SmartAgentNeoBatteryState
    public var lowPowerModeEnabled: Bool

    public init(level: Double?, state: SmartAgentNeoBatteryState, lowPowerModeEnabled: Bool) {
        self.level = level
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct SmartAgentNeoThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: SmartAgentNeoThermalState

    public init(state: SmartAgentNeoThermalState) {
        self.state = state
    }
}

public struct SmartAgentNeoStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct OpenNeoNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: OpenNeoNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [OpenNeoNetworkInterfaceType]

    public init(
        status: OpenNeoNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [OpenNeoNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct SmartAgentNeoDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: SmartAgentNeoBatteryStatusPayload
    public var thermal: SmartAgentNeoThermalStatusPayload
    public var storage: SmartAgentNeoStorageStatusPayload
    public var network: OpenNeoNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: SmartAgentNeoBatteryStatusPayload,
        thermal: SmartAgentNeoThermalStatusPayload,
        storage: SmartAgentNeoStorageStatusPayload,
        network: OpenNeoNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct SmartAgentNeoDeviceInfoPayload: Codable, Sendable, Equatable {
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
