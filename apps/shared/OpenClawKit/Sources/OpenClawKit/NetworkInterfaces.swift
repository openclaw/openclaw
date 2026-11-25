import Foundation

public enum NetworkInterfaces {
    public static func primaryIPv4Address() -> String? {
        let addresses = NetworkInterfaceIPv4.addresses()
        return addresses.first(where: { $0.name == "en0" })?.ip ?? addresses.first?.ip
    }
}
