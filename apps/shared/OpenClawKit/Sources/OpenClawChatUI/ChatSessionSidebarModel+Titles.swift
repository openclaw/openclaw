import Foundation

extension ChatSessionSidebarModel {
    #if os(macOS)
    static func sidebarDisplayName(for session: OpenClawChatSessionEntry) -> String {
        let key = session.key
        let main = key == "main" || key.range(of: #"^agent:[^:]+:main$"#, options: .regularExpression) != nil
        let subagent = !main && key.contains(":subagent:")
        let automation = !main &&
            (key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("cron:") ||
                key.contains(":cron:"))
        let prefix = subagent ? String(localized: "Subagent:") : String(localized: "Automation:")
        let parsed = self.sidebarKeyTitle(key)
        let fallback = subagent || automation ? prefix : parsed.name
        // ui/src/lib/session-display.ts:287: sidebar titles omit subagent prefixes,
        // keep automation prefixes, and never promote a key copied into a name field.
        let explicit = [session.label, session.displayName]
            .compactMap(ChatPayloadDecoding.trimmedNonEmptyString).first { $0 != key }
        let derived = ChatPayloadDecoding.trimmedNonEmptyString(session.derivedTitle)
        let named = explicit ?? (session.worktree == nil ? nil : self.sidebarWorkSubtitle(for: session)) ??
            (derived == key ? nil : derived)
        var name = named ?? fallback
        if named != nil, subagent || automation {
            if automation, !subagent {
                let stripped = name.replacingOccurrences(
                    of: #"^cron(\s+job)?:\s*"#,
                    with: "",
                    options: [.regularExpression, .caseInsensitive])
                name = ChatPayloadDecoding.trimmedNonEmptyString(stripped) ?? name
            }
            let pattern = "^" + NSRegularExpression.escapedPattern(for: prefix) + #"\s*"#
            if subagent {
                name = ChatPayloadDecoding.trimmedNonEmptyString(name.replacingOccurrences(
                    of: pattern, with: "", options: [.regularExpression, .caseInsensitive])) ?? fallback
            } else if name.range(of: pattern, options: [.regularExpression, .caseInsensitive]) == nil {
                name = "\(prefix) \(name)"
            }
        }
        let account = ChatPayloadDecoding.trimmedNonEmptyString(session.accountId) ??
            (subagent || automation ? nil : parsed.account)
        guard let account, account != "default", !name.hasSuffix(" · \(account)") else { return name }
        return "\(name) · \(account)"
    }

    static func sidebarChannelLabel(for session: OpenClawChatSessionEntry) -> String? {
        // ui/src/lib/session-display.ts:60 and session-channel.ts:109: only peer
        // routes identify a channel; main/dashboard delivery metadata does not.
        guard session.key.range(of: #":(?:direct|dm|group|channel|thread):"#, options: .regularExpression) != nil
        else { return nil }
        let pattern = #"^agent:[^:]+:([^:]+)(?:(?::[^:]+)?:(?:direct|dm)|:(?:group|channel|thread)):"#
        let keyChannel = session.key.range(of: pattern, options: .regularExpression).map {
            String(session.key[$0]).split(separator: ":")[2].description
        }
        guard let channel = ChatPayloadDecoding.trimmedNonEmptyString(keyChannel) ??
            ChatPayloadDecoding.trimmedNonEmptyString(session.channel)
        else { return nil }
        return self.sidebarChannelName(channel.lowercased())
    }

    static func sidebarWorkSubtitle(for session: OpenClawChatSessionEntry) -> String? {
        let repository = session.repository
        let url = (repository?["url"]?.value as? String)?.replacingOccurrences(
            of: #"\.git$"#, with: "", options: .regularExpression)
        let root = ChatPayloadDecoding.trimmedNonEmptyString(url) ??
            ChatPayloadDecoding.trimmedNonEmptyString(session.worktree?.repoRoot)
        var branch = ChatPayloadDecoding.trimmedNonEmptyString(repository?["branch"]?.value as? String) ??
            ChatPayloadDecoding.trimmedNonEmptyString(session.worktree?.branch)
        if repository == nil, let value = branch, value.hasPrefix("openclaw/") {
            branch = String(value.dropFirst("openclaw/".count))
        }
        let checkout = root.map { root in
            let name = root.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? root
            return branch.flatMap { $0.isEmpty ? nil : "\(name) ⎇ \($0)" } ?? name
        }
        let node = ChatPayloadDecoding.trimmedNonEmptyString(session.execNode).map(self.shortenSidebarOpaqueIDs)
        let parts = [checkout, node].compactMap(\.self)
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func shortenSidebarOpaqueIDs(_ value: String) -> String {
        // ui/src/lib/session-display.ts:40: UUID and >=10-digit hex runs retain only their last four digits.
        value.replacingOccurrences(
            of: #"(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{8}|[0-9a-f]{6,})([0-9a-f]{4})"#,
            with: "…$1",
            options: [.regularExpression, .caseInsensitive])
    }

    private static let sidebarChannelNames = [
        "imessage": "iMessage", "telegram": "Telegram", "discord": "Discord", "signal": "Signal",
        "slack": "Slack", "whatsapp": "WhatsApp", "matrix": "Matrix", "msteams": "Microsoft Teams",
        "bluebubbles": "BlueBubbles", "googlechat": "Google Chat", "mattermost": "Mattermost",
        "irc": "IRC", "email": "Email", "sms": "SMS",
    ]

    private static func sidebarChannelName(_ channel: String) -> String {
        self.sidebarChannelNames[channel] ?? channel.prefix(1).uppercased() + String(channel.dropFirst())
    }

    private static let sidebarDirectKey = try? NSRegularExpression(
        pattern: #"^agent:[^:]+:([^:]+)(?::([^:]+))?:(?:direct|dm):(.+)$"#)

    private static func sidebarKeyTitle(_ key: String) -> (name: String, account: String?) {
        // ui/src/lib/session-display.ts:218: only direct/dm routes accept an account segment.
        if key == "main" || key.range(of: #"^agent:[^:]+:main$"#, options: .regularExpression) != nil {
            return (String(localized: "Main Session"), nil)
        }
        if let match = self.sidebarDirectKey?.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)),
           let channelRange = Range(match.range(at: 1), in: key),
           let peerRange = Range(match.range(at: 3), in: key)
        {
            let account = Range(match.range(at: 2), in: key).map { String(key[$0]) }
            let peer = key[peerRange].trimmingCharacters(in: .whitespacesAndNewlines)
            // Web slices UTF-16 but drops a split surrogate at the start of the suffix.
            var tail = Array(peer.utf16.suffix(6))
            if let first = tail.first, (0xDC00...0xDFFF).contains(first) { tail.removeFirst() }
            let shortened = peer.utf16.count <= 10 ? peer : "…" + String(decoding: tail, as: UTF16.self)
            return ("\(self.sidebarChannelName(String(key[channelRange]))) · \(shortened)", account)
        }
        if key.range(of: #"^agent:[^:]+:([^:]+):group:(.+)$"#, options: .regularExpression) != nil {
            let channel = String(key.split(separator: ":")[2])
            return (String(format: String(localized: "%@ Group"), self.sidebarChannelName(channel)), nil)
        }
        for channel in self.sidebarChannelNames.keys where key == channel || key.hasPrefix("\(channel):") {
            return (String(format: String(localized: "%@ Session"), self.sidebarChannelName(channel)), nil)
        }
        if key.range(of: #"^agent:[^:]+:dashboard:"#, options: .regularExpression) != nil {
            return (String(localized: "New session"), nil)
        }
        if let prefix = key.range(of: #"^agent:[^:]+:(?:explicit:)?(?=.+)"#, options: .regularExpression) {
            return (self.shortenSidebarOpaqueIDs(String(key[prefix.upperBound...])), nil)
        }
        return (key, nil)
    }
    #endif

    public static func displayName(for session: OpenClawChatSessionEntry) -> String {
        ChatPayloadDecoding.trimmedNonEmptyString(session.label) ??
            ChatPayloadDecoding.trimmedNonEmptyString(session.displayName) ??
            ChatPayloadDecoding.trimmedNonEmptyString(session.autoLabel) ??
            self.displayName(forKey: session.key)
    }

    /// Compact "repo \u{2387} branch" line for worktree/work sessions; mirrors the
    /// web sidebar row subtitle (ui/src/lib/session-display.ts).
    public static func workSubtitle(for session: OpenClawChatSessionEntry) -> String? {
        let repoRoot = session.worktree?.repoRoot?.trimmingCharacters(in: .whitespacesAndNewlines)
        let branch = session.worktree?.branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let repoName = repoRoot?.split(separator: "/").last.map(String.init)
        let shortBranch = branch.map { $0.hasPrefix("openclaw/") ? String($0.dropFirst("openclaw/".count)) : $0 }
        guard let repoName, !repoName.isEmpty else { return nil }
        guard let shortBranch, !shortBranch.isEmpty else { return repoName }
        return "\(repoName) \u{2387} \(shortBranch)"
    }

    /// Session keys read as routing ids ("agent:main:main"); show the human
    /// part and keep the owning agent as a suffix only when it disambiguates.
    public static func displayName(forKey key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "agent" else {
            return trimmed.isEmpty ? key : trimmed
        }
        let agent = String(parts[1])
        let session = String(parts[2])
        if session.isEmpty { return trimmed }
        return agent == "main" || agent.isEmpty ? session : "\(session) (\(agent))"
    }
}
