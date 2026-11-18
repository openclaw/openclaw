import Foundation

enum ExecEnvOptions {
    static let withValue = Set([
        "-u",
        "--unset",
        "-c",
        "--chdir",
        "-s",
        "--split-string",
        "--default-signal",
        "--ignore-signal",
        "--block-signal",
    ])

    static let flagOnly = Set(["-i", "--ignore-environment", "-0", "--null"])

    static let inlineValuePrefixes = withValue.sorted().map { $0.hasPrefix("--") ? $0 + "=" : $0 }
}
