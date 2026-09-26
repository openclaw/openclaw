import Foundation

public enum NetworkInterfaces {
    public static func primaryIPv4Address() -> String? {
        var fallback: String?
        for entry in NetworkInterfaceIPv4.addresses() {
            if entry.name == "en0" {
                return entry.ip
            }
            if fallback == nil { fallback = entry.ip }
        }

        return fallback
    }
}
