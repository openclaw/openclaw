import Foundation
import OpenClawKit

/// Shared device and platform info for Settings, gateway node payloads, and device status.
enum DeviceInfoHelper {
    /// Always "iOS X.Y.Z" for UI display (e.g. Settings), matching legacy behavior on iPad.
    static func platformStringForDisplay() -> String {
        "iOS \(self.iOSVersionStringForDisplay())"
    }

    /// Version-only display string for About, e.g. "18.0.0".
    static func iOSVersionStringForDisplay(
        _ version: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion) -> String
    {
        "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    /// Machine model identifier, or a compatibility-host description when running on a Mac.
    static func modelIdentifier() -> String {
        InstanceIdentity.modelIdentifier ?? "unknown"
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

    static func buildMetadata(
        infoDictionary: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> ArtifactBuildInfo
    {
        ArtifactBuildInfo(
            infoDictionary: infoDictionary,
            versionKeys: ["OpenClawCanonicalVersion", "CFBundleShortVersionString"])
    }
}
