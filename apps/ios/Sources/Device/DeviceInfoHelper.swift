import Foundation
import UIKit

import Darwin

/// Shared device and platform info for Settings, gateway node payloads, and device status.
enum DeviceInfoHelper {
    /// e.g. "iOS 18.0.0" or "iPadOS 18.0.0" by interface idiom. Use for gateway/device payloads.
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
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "iOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    /// Device family for display: "iPad", "iPhone", or "iOS".
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

    /// App marketing version only, e.g. "2026.2.0" or "dev".
    static func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    /// App build string, e.g. "123" or "".
    static func appBuild() -> String {
        let raw = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Display string for Settings: "1.2.3" or "1.2.3 (456)" when build differs.
    static func openClawVersionString() -> String {
        let version = appVersion()
        let build = appBuild()
        if build.isEmpty || build == version {
            return version
        }
        return "\(version) (\(build))"
    }
}
