import Foundation

struct ExecHostDenylistEntry: Codable, Equatable, Sendable {
    var pattern: String
    var reason: String?
}

struct ExecHostDenylistAuthorizationSnapshot: Codable, Equatable, Sendable {
    var command: String
    var analysisOk: Bool
    var configDenylist: [ExecHostDenylistEntry]
    var approvedRuleKeys: [String]
    var denylisted: Bool?

    func requiresFreshApproval(command: [String]) -> Bool {
        let approvedRuleKeys = Set(self.approvedRuleKeys)
        let newlyCurrent = self.configDenylist.filter { entry in
            !approvedRuleKeys.contains(Self.ruleKey(entry))
        }
        guard !newlyCurrent.isEmpty else { return false }
        if !self.analysisOk {
            return true
        }

        let targets = Self.denylistTargets(command: command, canonicalCommand: self.command)
        return newlyCurrent.contains { entry in
            targets.contains { target in
                ExecHostDenylistMatcher.matches(pattern: entry.pattern, target: target)
            }
        }
    }

    private static func ruleKey(_ entry: ExecHostDenylistEntry) -> String {
        "\(entry.pattern)\u{0}\(entry.reason ?? "")"
    }

    private static func denylistTargets(command: [String], canonicalCommand: String) -> [String] {
        var targets: [String] = []
        var seen = Set<String>()
        func add(_ value: String) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { return }
            targets.append(trimmed)
        }

        add(canonicalCommand)
        guard let executable = command.first else { return targets }
        add(command.joined(separator: " "))
        var basenameCommand = command
        basenameCommand[0] = URL(fileURLWithPath: executable).lastPathComponent
        add(basenameCommand.joined(separator: " "))
        return targets
    }
}

private enum ExecHostDenylistMatcher {
    static func matches(pattern: String, target: String) -> Bool {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return target.range(
            of: Self.regexPattern(for: trimmed),
            options: .regularExpression) != nil
    }

    private static func regexPattern(for glob: String) -> String {
        var regex = "^"
        var index = glob.startIndex
        while index < glob.endIndex {
            let character = glob[index]
            if character == "*" {
                let nextIndex = glob.index(after: index)
                if nextIndex < glob.endIndex, glob[nextIndex] == "*" {
                    regex += ".*"
                    index = glob.index(after: nextIndex)
                    continue
                }
                regex += "[^/]*"
                index = nextIndex
                continue
            }
            if character == "?" {
                regex += "[^/]"
                index = glob.index(after: index)
                continue
            }
            regex += NSRegularExpression.escapedPattern(for: String(character))
            index = glob.index(after: index)
        }
        regex += "$"
        return regex
    }
}
