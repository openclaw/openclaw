import Foundation

public enum OpenClawProcessInfo {
    /// Test identity is process-stable. Recognize runners before inspecting transient bundles.
    public static let isRunningTests: Bool = {
        let process = ProcessInfo.processInfo
        let environment = process.environment
        let processName = process.processName
        let arguments = process.arguments
        if OpenClawProcessInfo.resolveIsRunningTests(
            environment: environment,
            processName: processName,
            arguments: arguments,
            bundleURLs: [])
        {
            return true
        }
        return OpenClawProcessInfo.resolveIsRunningTests(
            environment: environment,
            processName: processName,
            arguments: arguments,
            bundleURLs: Bundle.allBundles.map(\.bundleURL) + [Bundle.main.bundleURL])
    }()

    static func resolveIsRunningTests(
        environment: [String: String],
        processName: String,
        arguments: [String],
        bundleURLs: [URL]) -> Bool
    {
        if bundleURLs.contains(where: { $0.pathExtension == "xctest" }) { return true }
        if self.swiftPMTestHelperNames.contains(processName) { return true }
        if let executable = arguments.first.map({ URL(fileURLWithPath: $0).lastPathComponent }),
           self.swiftPMTestHelperNames.contains(executable)
        {
            return true
        }
        return environment["XCTestConfigurationFilePath"] != nil
            || environment["XCTestBundlePath"] != nil
            || environment["XCTestSessionIdentifier"] != nil
    }

    private static let swiftPMTestHelperNames: Set<String> = [
        "swiftpm-testing-helper",
        "swiftpm-xctest-helper",
    ]
}
