import Foundation
import OpenClawIPC

struct MacCLIContext {
    let arguments: [String]
    let profile: MacControlProfile
    let configURL: URL

    init(
        arguments: [String],
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) throws
    {
        var remaining: [String] = []
        var profileValue: String?
        var index = 0
        while index < arguments.count {
            if arguments[index] == "--profile" {
                guard profileValue == nil, index + 1 < arguments.count,
                      !arguments[index + 1].hasPrefix("--")
                else {
                    throw MacControlOptions.usage("A value is required exactly once for --profile.")
                }
                index += 1
                profileValue = arguments[index]
            } else {
                remaining.append(arguments[index])
            }
            index += 1
        }
        self.arguments = remaining
        self.profile = try MacControlProfile(rawValue: profileValue ?? environment["OPENCLAW_PROFILE"])
        self.configURL = resolveOpenClawConfigURL(
            profile: self.profile, environment: environment, homeDirectory: homeDirectory)
    }

    var defaultsSuites: [String] {
        // Named profiles share one app domain across release and debug bundle identities.
        self.profile.name.map { ["ai.openclaw.mac.profile.\($0)"] }
            ?? ["ai.openclaw.mac", "ai.openclaw.mac.debug"]
    }
}
