import Foundation

enum AppLaunchArguments {
    static func value(for flag: String, in arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}
