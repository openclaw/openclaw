#if os(macOS)
import Foundation
import OpenClawProtocol

extension ChatSessionHoverCardProjection {
    static func age(_ timestamp: Double, now: Date, suffix: Bool = false) -> String {
        guard timestamp.isFinite else { return "" }
        let seconds = abs(timestamp / 1000 - now.timeIntervalSince1970)
        let days = seconds / 86400
        let bucket: (Double, Calendar.Component, String)
            // session-hovercard.ts:97: calendar-sized buckets precede nested second/minute rounding.
            = if days >= 365
        {
            ((days / 365).rounded(), .year, "y")
        } else if days >= 28 {
            (max(1, (days / 30).rounded()), .month, "mo")
        } else if days >= 7 {
            ((days / 7).rounded(), .weekOfMonth, "w")
        } else if days >= 1 {
            (days.rounded(), .day, "d")
        } else if seconds.rounded() < 60 {
            (seconds.rounded(), .second, "s")
        } else if (seconds.rounded() / 60).rounded() < 60 {
            ((seconds.rounded() / 60).rounded(), .minute, "m")
        } else {
            (((seconds.rounded() / 60).rounded() / 60).rounded(), .hour, "h")
        }
        if suffix, bucket.1 == .second,
           timestamp / 1000 <= now.timeIntervalSince1970 { return String(localized: "Just now") }
        if Locale.current.language.languageCode?.identifier == "en" {
            let compact = "\(Int(bucket.0))\(bucket.2)"
            return suffix ? String(
                format: timestamp / 1000 > now
                    .timeIntervalSince1970 ? String(localized: "in %@") : String(localized: "%@ ago"),
                compact) : compact
        }
        var components = DateComponents()
        components.setValue(
            Int(bucket.0) * (suffix && timestamp / 1000 <= now.timeIntervalSince1970 ? -1 : 1),
            for: bucket.1)
        if suffix {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            return formatter.localizedString(from: components)
        }
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .short
        formatter.maximumUnitCount = 1
        return formatter.string(from: components) ?? ""
    }
}

/// Exact projection rules from session-hovercard.ts:146, session-hovercard-context.ts:60 and session-channel.ts:100.
enum ChatSessionHoverCardProjection {
    struct Person {
        let label: String
        let identity: AnyCodable?
        var avatarURL: String?
        var profileID: String? {
            self.identityID(type: "profile")
        }

        var agentID: String? {
            self.identityID(type: "agent")
        }

        private func identityID(type: String) -> String? {
            guard let identity = self.identity?.value as? [String: AnyCodable],
                  identity["type"]?.value as? String == type else { return nil }
            return identity["id"]?.value as? String
        }
    }

    struct Attribution { let primary: Person
        let others: [Person]
        let participantCount: Int
        let primaryIsCreator: Bool
        var visibleOthers: [Person] {
            Array(self.others.prefix(4))
        }

        var hiddenAvatarCount: Int {
            max(0, self.participantCount - self.visibleOthers.count)
        }
    }

    struct Context { let symbol: String
        let text: String
        var detail: String?
        var label: String?
    }

    struct Channel { let label: String
        let details: [String]
    }

    struct HeadsUp {
        let step: String
        let completed: Int
        let total: Int
        let paused: Bool
        let running: Bool
        var label: String {
            let status = self.paused ? String(localized: "Paused") : self
                .running ? String(localized: "In progress") : String(localized: "Pending")
            return "\(status): \(self.step), \(self.completed)/\(self.total)"
        }
    }

    struct Copy {
        let title: String
        let preview: String?
        let error: String?
        let notepad: String?
    }

    static func copy(_ row: OpenClawChatSessionEntry, card: ProgressCard?, error: String?) -> Copy {
        // ui/src/components/session-hovercard.ts:511: even a blank notepad suppresses the message preview.
        Copy(
            title: ChatSessionSidebarModel.sidebarDisplayName(for: row),
            preview: card == nil ? self.text(row.lastMessagePreview) : nil,
            error: error,
            notepad: self.text(card?.markdown) == nil ? nil : card?.markdown)
    }

    static func pullRequestNotice(_ status: String) -> String? {
        switch status {
        case "ready": nil
        case "rate-limited": String(localized:
                "GitHub API rate limit reached. Pull request status may be out of date until the limit resets.")
        default: String(localized:
                "GitHub status could not be refreshed. Showing the last known state; check GitHub for the latest.")
        }
    }

    static func text(_ value: String?) -> String? {
        ChatPayloadDecoding.trimmedNonEmptyString(value)
    }

    static func string(_ value: AnyCodable?) -> String? {
        if let number = value?.value as? NSNumber { return number.stringValue }
        return self.text(value?.value as? String)
    }

    static func match(_ pattern: String, _ value: String, group: Int = 1) -> String? {
        guard let match = try? NSRegularExpression(pattern: pattern).firstMatch(
            in: value,
            range: NSRange(value.startIndex..., in: value)),
            let range = Range(match.range(at: group), in: value) else { return nil }
        return String(value[range])
    }

    static func attribution(_ row: OpenClawChatSessionEntry, selfID: String?) -> Attribution? {
        var seen = Set<AnyCodable>()
        var excluded = 0
        let participants = (row.expandedParticipants ?? row.participants ?? []).filter { person in
            guard seen.insert(person.identity).inserted else { return false }
            let profile = Person(label: "", identity: person.identity).profileID
            if (profile != nil && profile == selfID) || person.identity == row.createdActor?.identity { excluded += 1
                return false
            }
            return true
        }.map { Person(
            label: self.text($0.label) ?? self.string(($0.identity.value as? [String: AnyCodable])?["id"]) ?? "",
            identity: $0.identity,
            avatarURL: $0.avatarUrl) }
        let count = max(participants.count, (row.participantCount ?? 0) - excluded)
        if let creator = row.createdActor, let label = self.text(creator.label) ?? self.text(creator.id) {
            return Attribution(
                primary: Person(label: label, identity: creator.identity, avatarURL: creator.avatarUrl),
                others: participants,
                participantCount: count,
                primaryIsCreator: true)
        }
        guard let primary = participants.first else { return nil }
        return Attribution(
            primary: primary,
            others: Array(participants.dropFirst()),
            participantCount: max(0, count - 1),
            primaryIsCreator: false)
    }

    static func context(_ row: OpenClawChatSessionEntry) -> [Context] {
        var result: [Context] = []
        let repository = self.string(row.repository?["url"]).map { $0.replacingOccurrences(
            of: #"\.git$"#,
            with: "",
            options: .regularExpression) }
        let root = repository ?? (row.execNode == nil ? self.text(row.worktree?.repoRoot) : nil)
        let directory = row.execNode != nil ? self.text(row.execCwd) : self.text(row.spawnedWorkspaceDir) ?? self
            .text(row.spawnedCwd)
        if let path = root ?? directory {
            let cwd = row.repository != nil ? self
                .text(row.placement?.remoteWorkspaceDir) ?? (row.execNode != nil ? self.text(row.execCwd) : nil) : self
                .text(row.spawnedCwd)
            let name = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
            let kind = root != nil ? String(localized: "Project") : String(localized: "Workspace")
            result.append(Context(
                symbol: "folder",
                text: name,
                detail: String(format: String(localized: "%@: %@"), kind, root != nil ? cwd ?? path : path),
                label: String(format: String(localized: "%@: %@"), kind, name)))
            if root != nil, var branch = self.string(row.repository?["branch"]) ?? self.text(row.worktree?.branch) {
                if row.repository == nil, branch.hasPrefix("openclaw/") { branch = String(branch.dropFirst(9)) }
                result.append(Context(
                    symbol: "arrow.triangle.branch",
                    text: branch,
                    detail: cwd,
                    label: String(format: String(localized: "Branch: %@"), branch)))
            }
        }
        if let placement = row.placement, let provider = placement.providerId, let profile = placement.profileId {
            let runsOn = String(format: String(localized: "Runs on %@ · %@"), provider, profile)
            result.append(Context(
                symbol: "server.rack",
                text: "\(provider) · \(profile)",
                detail: runsOn,
                label: runsOn))
            let machine = placement.machine?.value as? [String: AnyCodable]
            let parts = [
                self.string(machine?["osLabel"]) ?? self.string(machine?["os"]),
                self.string(machine?["class"]),
                self.string(machine?["cpu"])
                    .flatMap { $0 == "0" ? nil : String(format: String(localized: "%@ vCPU"), $0) },
                self.string(machine?["memoryGb"]).flatMap { $0 == "0" ? nil : String(
                    format: String(localized: "%@ GB"),
                    $0) },
            ].compactMap(\.self)
            if !parts.isEmpty {
                let summary = parts.joined(separator: " · ")
                result.append(Context(
                    symbol: "desktopcomputer",
                    text: summary,
                    label: String(format: String(localized: "Machine: %@"), summary)))
            }
        }
        if row.boardFace == "dashboard" { result.append(Context(
            symbol: "square.grid.2x2",
            text: String(localized: "Opens as dashboard"))) }
        return result
    }

    static func headsUp(_ card: ProgressCard?, session: OpenClawChatSessionEntry) -> HeadsUp? {
        guard let card else { return nil }
        let stale = session.startedAt
            .map { $0.isFinite && Double(card.updatedat) < $0 } ?? false
        // session-progress-card.ts:184: a previous run's unfinished step is paused, even after terminal status.
        guard stale || !["done", "failed", "killed", "timeout"].contains(session.status ?? ""),
              let steps = card.steps,
              let step = steps.first(where: { $0.status == .inProgress }) ?? steps
                  .first(where: { $0.status == .pending }) else { return nil }
        let active = !session
            .isArchived && (session.status == nil || ["running", "queued"].contains(session.status ?? "")) &&
            (session.hasActiveRun ?? [
                "running",
                "queued",
            ].contains(session.status ?? ""))
        return HeadsUp(
            step: step.step,
            completed: steps.count { $0.status == .completed },
            total: steps.count,
            paused: step.status == .inProgress && (stale || !active),
            running: step.status == .inProgress)
    }

    static func checksLabel(_ state: String) -> String {
        switch state {
        case "passing": String(localized: "CI checks passing")
        case "failing": String(localized: "CI checks failing")
        default: String(localized: "CI checks running")
        }
    }

    static func channel(_ row: OpenClawChatSessionEntry) -> Channel? {
        guard let label = ChatSessionSidebarModel.sidebarChannelLabel(for: row) else { return nil }
        let channel = self.text(self.match(
            #"^agent:[^:]+:([^:]+)(?:(?::[^:]+)?:(?:direct|dm)|:(?:group|channel|thread)):"#,
            row.key) ?? row.channel)?.lowercased() ?? ""
        let declared = self.text(row.channel)?.lowercased()
        let originChannel = self.string(row.origin?["provider"]) ?? self.string(row.origin?["surface"])
        let matches = (declared == nil || declared == channel) &&
            (originChannel == nil || originChannel?.lowercased() == channel)
        let origin = matches ? row.origin : nil
        let delivery = self.string(row.deliveryContext?["channel"])?.lowercased() == channel ? row.deliveryContext : nil
        var kind = (matches ? self.text(row.chatType) ?? self.string(origin?["chatType"]) : nil) ??
            self.match(#"^agent:[^:]+:[^:]+:(direct|dm|group|channel|thread):"#, row.key) ?? self.match(
                #"^agent:[^:]+:[^:]+:[^:]+:(direct|dm):"#,
                row.key)
        if kind == "dm" { kind = "direct" }
        let thread = self.string(origin?["threadId"]) ?? self.string(delivery?["threadId"]) ??
            self.match(#"(?i).*:thread:(.+)$"#, row.key) ?? (channel == "telegram" ? self.match(
                #":topic:(\d+)$"#,
                row.key) : nil)
        if thread != nil { kind = channel == "telegram" ? "topic" : "thread" }
        var address: String?
        if kind == "direct" || (matches && (row.chatType ?? self.string(origin?["chatType"])) == "direct") {
            var candidates = [self.string(origin?["nativeDirectUserId"]), self.string(origin?["from"])]
                .compactMap(\.self)
            if candidates.isEmpty, let peer = self.match(
                #"^agent:[^:]+:[^:]+:(?:[^:]+:)?(?:direct|dm):(.+?)(?i)(?::thread:.*)?$"#,
                row.key) { candidates = [peer] }
            for candidate in candidates {
                var value = candidate
                if channel == "matrix" {
                    value = value.replacingOccurrences(of: #"(?i)^matrix:"#, with: "", options: .regularExpression)
                    if self.match(#"^(@[^\s:]+:[^\s]+)$"#, value) != nil { address = value
                        break
                    }
                } else {
                    let prefix = [
                        "whatsapp": "whatsapp",
                        "signal": "signal",
                        "imessage": "imessage|bluebubbles|sms|auto|email",
                        "bluebubbles": "imessage|bluebubbles|sms|auto|email",
                        "sms": "imessage|bluebubbles|sms|auto|email",
                        "email": "imessage|bluebubbles|sms|auto|email",
                    ][channel]
                    guard let prefix else { continue }
                    value = value.replacingOccurrences(of: "(?i)^(?:\(prefix)):", with: "", options: .regularExpression)
                    if channel == "whatsapp",
                       let phone = self.match(#"(?i)^(\d+)(?:@s\.whatsapp\.net)?$"#, value) { value = "+\(phone)" }
                    if (["imessage", "bluebubbles", "sms", "email"].contains(channel) && self.match(
                        #"^([^\s@:]+@[^\s@:]+)$"#,
                        value) != nil) || self.match(#"^(\+[1-9]\d{1,14})$"#, value) != nil
                    { address = value
                        break
                    }
                }
            }
        }
        var conversation = self.string(origin?["label"])
        if let pattern = [
            "discord": #" (?:user|channel) id:\d+$"#,
            "telegram": #"(?:^| )id:-?\d+(?: topic:\d+)?$"#,
            "signal": #" id:\S+$"#,
        ][channel] {
            conversation = conversation?.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        if channel == "telegram",
           self
               .match(#"^((?:id:unknown|group:-?\d+(?: topic:\d+)?))$"#, conversation ?? "") !=
               nil { conversation = nil }
        let subject = matches ? self.text(row.subject) : nil
        let group = matches ? self.text(row.groupChannel) : nil
        conversation = channel == "discord" ? self.text(conversation) ?? group ?? subject :
            ((channel == "msteams" && ["personal", "groupChat", "channel"].contains(subject ?? "") ? nil : subject) ??
                group ?? self.text(conversation))
        if [address, self.string(origin?["from"]), self.string(origin?["to"]), self.string(origin?["nativeChannelId"])]
            .contains(conversation) { conversation = nil }
        let account = (declared == nil || declared == channel ? self.text(row.accountId) : nil) ?? self
            .string(delivery?["accountId"]) ?? self.string(origin?["accountId"])
        let kindLabel = kind == "topic" ? thread.map { String(format: String(localized: "Topic %@"), $0) } :
            [
                "direct": String(localized: "Direct chat"),
                "group": String(localized: "Group chat"),
                "channel": String(localized: "Channel"),
                "thread": String(localized: "Thread"),
            ][kind ?? ""]
        var seen = Set<String>()
        let title = ChatSessionSidebarModel.sidebarDisplayName(for: row)
        let conversationDetails = [conversation, address].compactMap { value -> String? in
            guard let value, value != title, seen.insert(value).inserted else { return nil }
            return value
        }
        let details: [String?] = [kindLabel] + conversationDetails +
            [account.flatMap { $0 == "default" ? nil : String(
                format: String(localized: "Via %@"),
                $0) }]
        return Channel(label: label, details: details.compactMap(\.self))
    }
}

extension OpenClawSessionPullRequestSnapshot.PullRequest {
    var accessibilityLabel: String {
        // ui/src/components/session-hovercard.ts:410 includes checks and diff in the link's accessible name.
        let details = [
            self.title,
            self.checks.map { ChatSessionHoverCardProjection.checksLabel($0.state) },
            self.additions.map { "+\($0.formatted())" },
            self.deletions.map { "−\($0.formatted())" },
        ]
            .compactMap(\.self).filter { !$0.isEmpty }
        return ([String(format: String(localized: "Pull request #%lld, %@"), self.number, self.stateLabel)] + details)
            .joined(separator: ", ")
    }

    var stateLabel: String {
        switch self.state {
        case "open": String(localized: "Open")
        case "draft": String(localized: "Draft")
        case "merged": String(localized: "Merged")
        default: String(localized: "Closed")
        }
    }
}

extension OpenClawSessionPullRequestSnapshot {
    var menuPullRequest: PullRequest? {
        // ui/src/components/session-menu-work.ts:26 prioritizes active work; the card keeps server order.
        ["open", "draft", "merged", "closed"].lazy.compactMap { state in
            self.pullRequests.first { $0.state == state }
        }.first
    }
}
#endif
