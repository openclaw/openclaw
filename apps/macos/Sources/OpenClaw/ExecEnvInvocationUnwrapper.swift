import Foundation

enum ExecCommandToken {
    static func basenameLower(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let normalized = trimmed.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/").last.map { String($0).lowercased() } ?? normalized.lowercased()
    }
}

enum ExecEnvInvocationUnwrapper {
    static let maxWrapperDepth = 4

    private static let optionsWithValue = Set([
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
    private static let flagOptions = Set(["-i", "--ignore-environment", "-0", "--null"])

    private static func isEnvAssignment(_ token: String) -> Bool {
        let pattern = #"^[A-Za-z_][A-Za-z0-9_]*=.*"#
        return token.range(of: pattern, options: .regularExpression) != nil
    }

    static func unwrap(_ command: [String]) -> [String]? {
        var idx = 1
        var expectsOptionValue = false
        while idx < command.count {
            let token = command[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if expectsOptionValue {
                expectsOptionValue = false
                idx += 1
                continue
            }
            if token == "--" || token == "-" {
                idx += 1
                break
            }
            if self.isEnvAssignment(token) {
                idx += 1
                continue
            }
            if token.hasPrefix("-"), token != "-" {
                let lower = token.lowercased()
                let flag = lower.split(separator: "=", maxSplits: 1).first.map(String.init) ?? lower
                if self.flagOptions.contains(flag) {
                    idx += 1
                    continue
                }
                if self.optionsWithValue.contains(flag) {
                    if !lower.contains("=") {
                        expectsOptionValue = true
                    }
                    idx += 1
                    continue
                }
                if lower.hasPrefix("-u") ||
                    lower.hasPrefix("-c") ||
                    lower.hasPrefix("-s") ||
                    lower.hasPrefix("--unset=") ||
                    lower.hasPrefix("--chdir=") ||
                    lower.hasPrefix("--split-string=") ||
                    lower.hasPrefix("--default-signal=") ||
                    lower.hasPrefix("--ignore-signal=") ||
                    lower.hasPrefix("--block-signal=")
                {
                    idx += 1
                    continue
                }
                return nil
            }
            break
        }
        guard idx < command.count else { return nil }
        return Array(command[idx...])
    }

    static func unwrapDispatchWrappersForResolution(_ command: [String]) -> [String] {
        var current = command
        var depth = 0
        while depth < self.maxWrapperDepth {
            guard let token = current.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
                break
            }
            guard ExecCommandToken.basenameLower(token) == "env" else {
                break
            }
            guard let unwrapped = self.unwrap(current), !unwrapped.isEmpty else {
                break
            }
            current = unwrapped
            depth += 1
        }
        return current
    }
}
