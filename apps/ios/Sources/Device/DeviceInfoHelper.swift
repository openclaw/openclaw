import Darwin
import Foundation
import UIKit

/// Shared device and platform info for Settings, gateway node payloads, and device status.
enum DeviceInfoHelper {
    /// e.g. "iOS 18.0.0" or "iPadOS 18.0.0" by interface idiom. Use for gateway/device payloads.
    @MainActor
    static func platformString() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let name = switch UIDevice.current.userInterfaceIdiom {
        case .pad:
            "iPadOS"
        case .phone:
            "iOS"
        default:
            "iOS"
        }
        return "\(name) \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    /// Always "iOS X.Y.Z" for UI display (e.g. Settings), matching legacy behavior on iPad.
    static func platformStringForDisplay() -> String {
        "iOS \(self.iOSVersionStringForDisplay())"
    }

    /// Version-only display string for About, e.g. "18.0.0".
    static func iOSVersionStringForDisplay() -> String {
        self.iOSVersionStringForDisplay(ProcessInfo.processInfo.operatingSystemVersion)
    }

    static func iOSVersionStringForDisplay(_ version: OperatingSystemVersion) -> String {
        "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    /// Device family for display: "iPad", "iPhone", or "iOS".
    @MainActor
    static func deviceFamily() -> String {
        switch UIDevice.current.userInterfaceIdiom {
        case .pad:
            "iPad"
        case .phone:
            "iPhone"
        default:
            "iOS"
        }
    }

    /// User-facing device name for About; diagnostics still use the raw model identifier.
    @MainActor
    static func deviceDisplayName() -> String {
        self.deviceDisplayName(
            identifier: self.modelIdentifier(),
            userInterfaceIdiom: UIDevice.current.userInterfaceIdiom,
            environment: ProcessInfo.processInfo.environment)
    }

    static func deviceDisplayName(
        identifier: String,
        userInterfaceIdiom: UIUserInterfaceIdiom?,
        environment: [String: String] = [:])
        -> String
    {
        let normalizedIdentifier = self.normalizedIdentifier(identifier)

        if let simulatorName = self.nonEmpty(environment["SIMULATOR_DEVICE_NAME"]) {
            return simulatorName
        }

        if self.hostArchitectureIdentifiers.contains(normalizedIdentifier) {
            if let simulatedIdentifier = self.nonEmpty(environment["SIMULATOR_MODEL_IDENTIFIER"]) {
                return self.deviceDisplayName(
                    identifier: simulatedIdentifier,
                    userInterfaceIdiom: userInterfaceIdiom,
                    environment: [:])
            }
            return "iOS Device (\(normalizedIdentifier))"
        }

        if let displayName = self.deviceNameByIdentifier[normalizedIdentifier] {
            return displayName
        }

        return self.fallbackDeviceDisplayName(
            identifier: normalizedIdentifier,
            userInterfaceIdiom: userInterfaceIdiom)
    }

    /// Machine model identifier from uname (e.g. "iPhone17,1").
    static func modelIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafeBytes(of: &systemInfo.machine) { ptr in
            String(bytes: ptr.prefix { $0 != 0 }, encoding: .utf8)
        }
        let trimmed = machine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "unknown" : trimmed
    }

    private static let hostArchitectureIdentifiers: Set<String> = ["arm64", "i386", "x86_64"]

    /// Covers iOS 18+ eligible iPhone/iPad identifiers; unknown future hardware falls back to family + id.
    private static let deviceNameByIdentifier: [String: String] = [
        "iPhone11,2": "iPhone XS",
        "iPhone11,4": "iPhone XS Max",
        "iPhone11,6": "iPhone XS Max",
        "iPhone11,8": "iPhone XR",
        "iPhone12,1": "iPhone 11",
        "iPhone12,3": "iPhone 11 Pro",
        "iPhone12,5": "iPhone 11 Pro Max",
        "iPhone12,8": "iPhone SE (2nd generation)",
        "iPhone13,1": "iPhone 12 mini",
        "iPhone13,2": "iPhone 12",
        "iPhone13,3": "iPhone 12 Pro",
        "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,2": "iPhone 13 Pro",
        "iPhone14,3": "iPhone 13 Pro Max",
        "iPhone14,4": "iPhone 13 mini",
        "iPhone14,5": "iPhone 13",
        "iPhone14,6": "iPhone SE (3rd generation)",
        "iPhone14,7": "iPhone 14",
        "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro",
        "iPhone15,3": "iPhone 14 Pro Max",
        "iPhone15,4": "iPhone 15",
        "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro",
        "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,1": "iPhone 16 Pro",
        "iPhone17,2": "iPhone 16 Pro Max",
        "iPhone17,3": "iPhone 16",
        "iPhone17,4": "iPhone 16 Plus",
        "iPhone17,5": "iPhone 16e",
        "iPhone18,1": "iPhone 17 Pro",
        "iPhone18,2": "iPhone 17 Pro Max",
        "iPhone18,3": "iPhone 17",
        "iPhone18,4": "iPhone Air",
        "iPhone18,5": "iPhone 17e",
        "iPad7,11": "iPad (7th generation)",
        "iPad7,12": "iPad (7th generation)",
        "iPad8,1": "iPad Pro 11-inch",
        "iPad8,2": "iPad Pro 11-inch",
        "iPad8,3": "iPad Pro 11-inch",
        "iPad8,4": "iPad Pro 11-inch",
        "iPad8,5": "iPad Pro 12.9-inch (3rd generation)",
        "iPad8,6": "iPad Pro 12.9-inch (3rd generation)",
        "iPad8,7": "iPad Pro 12.9-inch (3rd generation)",
        "iPad8,8": "iPad Pro 12.9-inch (3rd generation)",
        "iPad8,9": "iPad Pro 11-inch (2nd generation)",
        "iPad8,10": "iPad Pro 11-inch (2nd generation)",
        "iPad8,11": "iPad Pro 12.9-inch (4th generation)",
        "iPad8,12": "iPad Pro 12.9-inch (4th generation)",
        "iPad11,1": "iPad mini (5th generation)",
        "iPad11,2": "iPad mini (5th generation)",
        "iPad11,3": "iPad Air (3rd generation)",
        "iPad11,4": "iPad Air (3rd generation)",
        "iPad11,6": "iPad (8th generation)",
        "iPad11,7": "iPad (8th generation)",
        "iPad12,1": "iPad (9th generation)",
        "iPad12,2": "iPad (9th generation)",
        "iPad13,1": "iPad Air (4th generation)",
        "iPad13,2": "iPad Air (4th generation)",
        "iPad13,4": "iPad Pro 11-inch (3rd generation)",
        "iPad13,5": "iPad Pro 11-inch (3rd generation)",
        "iPad13,6": "iPad Pro 11-inch (3rd generation)",
        "iPad13,7": "iPad Pro 11-inch (3rd generation)",
        "iPad13,8": "iPad Pro 12.9-inch (5th generation)",
        "iPad13,9": "iPad Pro 12.9-inch (5th generation)",
        "iPad13,10": "iPad Pro 12.9-inch (5th generation)",
        "iPad13,11": "iPad Pro 12.9-inch (5th generation)",
        "iPad13,16": "iPad Air (5th generation)",
        "iPad13,17": "iPad Air (5th generation)",
        "iPad13,18": "iPad (10th generation)",
        "iPad13,19": "iPad (10th generation)",
        "iPad14,1": "iPad mini (6th generation)",
        "iPad14,2": "iPad mini (6th generation)",
        "iPad14,3": "iPad Pro 11-inch (4th generation)",
        "iPad14,4": "iPad Pro 11-inch (4th generation)",
        "iPad14,5": "iPad Pro 12.9-inch (6th generation)",
        "iPad14,6": "iPad Pro 12.9-inch (6th generation)",
        "iPad14,8": "iPad Air 11-inch (M2)",
        "iPad14,9": "iPad Air 11-inch (M2)",
        "iPad14,10": "iPad Air 13-inch (M2)",
        "iPad14,11": "iPad Air 13-inch (M2)",
        "iPad15,3": "iPad Air 11-inch (M3)",
        "iPad15,4": "iPad Air 11-inch (M3)",
        "iPad15,5": "iPad Air 13-inch (M3)",
        "iPad15,6": "iPad Air 13-inch (M3)",
        "iPad15,7": "iPad (A16)",
        "iPad15,8": "iPad (A16)",
        "iPad16,1": "iPad mini (A17 Pro)",
        "iPad16,2": "iPad mini (A17 Pro)",
        "iPad16,3": "iPad Pro 11-inch (M4)",
        "iPad16,4": "iPad Pro 11-inch (M4)",
        "iPad16,5": "iPad Pro 13-inch (M4)",
        "iPad16,6": "iPad Pro 13-inch (M4)",
        "iPad16,8": "iPad Air 11-inch (M4)",
        "iPad16,9": "iPad Air 11-inch (M4)",
        "iPad16,10": "iPad Air 13-inch (M4)",
        "iPad16,11": "iPad Air 13-inch (M4)",
        "iPad17,1": "iPad Pro 11-inch (M5)",
        "iPad17,2": "iPad Pro 11-inch (M5)",
        "iPad17,3": "iPad Pro 13-inch (M5)",
        "iPad17,4": "iPad Pro 13-inch (M5)",
    ]

    private static func fallbackDeviceDisplayName(
        identifier: String,
        userInterfaceIdiom: UIUserInterfaceIdiom?)
        -> String
    {
        if identifier.hasPrefix("iPhone") || userInterfaceIdiom == .phone {
            return "iPhone (\(identifier))"
        }
        if identifier.hasPrefix("iPad") || userInterfaceIdiom == .pad {
            return "iPad (\(identifier))"
        }
        return "iOS Device (\(identifier))"
    }

    private static func normalizedIdentifier(_ identifier: String) -> String {
        let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "unknown" : trimmed
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    /// Canonical app version when present, otherwise the Apple marketing version.
    static func appVersion() -> String {
        (Bundle.main.infoDictionary?["OpenClawCanonicalVersion"] as? String)
            ?? (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)
            ?? "dev"
    }

    /// App build string, e.g. "123" or "".
    static func appBuild() -> String {
        let raw = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Display string for Settings: "1.2.3" or "1.2.3 (456)" when build differs.
    static func openClawVersionString() -> String {
        let version = self.appVersion()
        let build = self.appBuild()
        if build.isEmpty || build == version {
            return version
        }
        return "\(version) (\(build))"
    }
}
