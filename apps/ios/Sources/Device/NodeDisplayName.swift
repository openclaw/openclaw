import Foundation
import UIKit

enum NodeDisplayName {
    private static let genericNames: Set<String> = [
        "iOS Node",
        "iPhone",
        "iPhone Node",
        "iPad",
        "iPad Node",
        "OpenClaw Mac App",
    ]

    static func isGeneric(_ name: String) -> Bool {
        self.genericNames.contains(name)
    }

    static func defaultValue(
        for interfaceIdiom: UIUserInterfaceIdiom,
        isIOSAppOnMac: Bool = ProcessInfo.processInfo.isiOSAppOnMac) -> String
    {
        if isIOSAppOnMac {
            return "OpenClaw Mac App"
        }
        return switch interfaceIdiom {
        case .phone:
            "iPhone Node"
        case .pad:
            "iPad Node"
        default:
            "iOS Node"
        }
    }

    static func resolve(
        existing: String?,
        deviceName: String,
        interfaceIdiom: UIUserInterfaceIdiom,
        isIOSAppOnMac: Bool = ProcessInfo.processInfo.isiOSAppOnMac) -> String
    {
        let trimmedExisting = existing?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedExisting.isEmpty, !Self.isGeneric(trimmedExisting) {
            return trimmedExisting
        }

        if isIOSAppOnMac {
            return Self.defaultValue(for: interfaceIdiom, isIOSAppOnMac: true)
        }

        let trimmedDevice = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmedDevice.lowercased()
        if lower.contains("iphone") || lower.contains("ipad") || lower.contains("ios") {
            return trimmedDevice
        }

        return Self.defaultValue(for: interfaceIdiom, isIOSAppOnMac: false)
    }
}
