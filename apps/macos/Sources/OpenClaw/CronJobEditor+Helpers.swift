import Foundation
import OpenClawProtocol
import SwiftUI

extension CronJobEditor {
    func gridLabel(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(width: self.labelColumnWidth, alignment: .leading)
    }

    func hydrateFromJob() {
        guard let job else { return }
        self.name = job.name
        self.description = job.description ?? ""
        self.agentId = job.agentId ?? ""
        self.enabled = job.enabled
        self.deleteAfterRun = job.deleteAfterRun ?? false
        self.sessionTarget = job.sessionTarget
        self.wakeMode = job.wakeMode

        switch job.schedule {
        case let .at(at):
            self.scheduleKind = .at
            if let date = CronSchedule.parseAtDate(at) {
                self.atDate = date
            }
        case let .every(everyMs, _):
            self.scheduleKind = .every
            self.everyText = self.formatDuration(ms: everyMs)
        case let .cron(expr, tz):
            self.scheduleKind = .cron
            self.cronExpr = expr
            self.cronTz = tz ?? ""
        }

        switch job.payload {
        case let .systemEvent(text):
            self.payloadKind = .systemEvent
            self.systemEventText = text
        case let .agentTurn(message, thinking, timeoutSeconds, _, _, _, _):
            self.payloadKind = .agentTurn
            self.agentMessage = message
            self.thinking = thinking ?? ""
            self.timeoutSeconds = timeoutSeconds.map(String.init) ?? ""
        }

        if let delivery = job.delivery {
            self.deliveryMode = delivery.mode
            let trimmed = (delivery.channel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self.channel = trimmed.isEmpty ? "last" : trimmed
            self.to = delivery.to ?? ""
            self.bestEffortDeliver = delivery.bestEffort ?? false
        } else {
            self.deliveryMode = .none
            self.channel = "last"
            self.to = ""
            self.bestEffortDeliver = false
        }
    }

    func save() {
        do {
            self.error = nil
            let payload = try self.buildPayload()
            self.onSave(payload)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func buildPayload() throws -> [String: AnyCodable] {
        let root = try self.buildPayloadRoot()
        guard let job else {
            return root.mapValues { AnyCodable($0) }
        }
        let current = self.buildComparableRoot(from: job)
        let patch = self.diffPatch(next: root, current: current)
        return patch.mapValues { AnyCodable($0) }
    }

    func buildPayloadRoot() throws -> [String: Any] {
        let name = try self.requireName()
        let description = self.trimmed(self.description)
        let agentId = self.trimmed(self.agentId)
        let schedule = try self.buildSchedule()
        let payload = try self.buildSelectedPayload()

        try self.validateSessionTarget(payload)
        try self.validatePayloadRequiredFields(payload)

        var root: [String: Any] = [
            "name": name,
            "enabled": self.enabled,
            "schedule": schedule,
            "sessionTarget": self.sessionTarget.rawValue,
            "wakeMode": self.wakeMode.rawValue,
            "payload": payload,
        ]
        self.applyDeleteAfterRun(to: &root)
        if !description.isEmpty {
            root["description"] = description
        } else if self.job?.description != nil {
            root["description"] = NSNull()
        }
        if !agentId.isEmpty {
            root["agentId"] = agentId
        } else if self.job?.agentId != nil {
            root["agentId"] = NSNull()
        }

        if self.shouldIncludeDeliveryInRoot() {
            root["delivery"] = self.buildDelivery()
        }
        return root
    }

    func buildDelivery() -> [String: Any] {
        let mode = self.deliveryMode.rawValue
        var delivery: [String: Any] = ["mode": mode]
        if self.deliveryMode == .announce {
            let trimmed = self.channel.trimmingCharacters(in: .whitespacesAndNewlines)
            delivery["channel"] = trimmed.isEmpty ? "last" : trimmed
            let to = self.to.trimmingCharacters(in: .whitespacesAndNewlines)
            if !to.isEmpty {
                delivery["to"] = to
            } else if self.job?.delivery?.to != nil {
                delivery["to"] = NSNull()
            }
            if self.bestEffortDeliver {
                delivery["bestEffort"] = true
            } else if self.job?.delivery?.bestEffort == true {
                delivery["bestEffort"] = false
            }
        } else if self.deliveryMode == .webhook {
            let to = self.to.trimmingCharacters(in: .whitespacesAndNewlines)
            if !to.isEmpty {
                delivery["to"] = to
            } else if self.job?.delivery?.to != nil {
                delivery["to"] = NSNull()
            }
        } else if self.deliveryMode == .raw || self.isUnknownDeliveryMode(self.deliveryMode) {
            let channel = self.channel.trimmingCharacters(in: .whitespacesAndNewlines)
            if !channel.isEmpty {
                delivery["channel"] = channel
            }
            let to = self.to.trimmingCharacters(in: .whitespacesAndNewlines)
            if !to.isEmpty {
                delivery["to"] = to
            }
            if self.bestEffortDeliver {
                delivery["bestEffort"] = true
            }
        }
        return delivery
    }

    func shouldIncludeDeliveryInRoot() -> Bool {
        guard self.sessionTarget == .isolated else { return false }
        guard let job else { return true }
        if job.delivery != nil { return true }
        if self.deliveryMode != .none { return true }
        if !self.trimmed(self.to).isEmpty { return true }
        if self.trimmed(self.channel).lowercased() != "last" { return true }
        if self.bestEffortDeliver { return true }
        return false
    }

    func buildComparableRoot(from job: CronJob) -> [String: Any] {
        var root: [String: Any] = [
            "name": self.trimmed(job.name),
            "enabled": job.enabled,
            "schedule": self.scheduleDictionary(from: job.schedule),
            "sessionTarget": job.sessionTarget.rawValue,
            "wakeMode": job.wakeMode.rawValue,
            "payload": self.payloadDictionary(from: job.payload),
        ]

        if let description = job.description?.trimmingCharacters(in: .whitespacesAndNewlines),
           !description.isEmpty
        {
            root["description"] = description
        }
        if let agentId = job.agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !agentId.isEmpty
        {
            root["agentId"] = agentId
        }

        switch job.schedule {
        case .at:
            root["deleteAfterRun"] = job.deleteAfterRun ?? false
        case .every, .cron:
            if job.deleteAfterRun != nil {
                root["deleteAfterRun"] = false
            }
        }

        if job.sessionTarget == .isolated, let delivery = job.delivery {
            root["delivery"] = self.deliveryDictionary(from: delivery)
        }

        return root
    }

    func scheduleDictionary(from schedule: CronSchedule) -> [String: Any] {
        switch schedule {
        case let .at(at):
            return ["kind": "at", "at": at]
        case let .every(everyMs, _):
            return ["kind": "every", "everyMs": everyMs]
        case let .cron(expr, tz):
            let trimmedTz = tz?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if trimmedTz.isEmpty {
                return ["kind": "cron", "expr": expr]
            }
            return ["kind": "cron", "expr": expr, "tz": trimmedTz]
        }
    }

    func payloadDictionary(from payload: CronPayload) -> [String: Any] {
        switch payload {
        case let .systemEvent(text):
            return ["kind": "systemEvent", "text": text]
        case let .agentTurn(message, thinking, timeoutSeconds, _, _, _, _):
            var dict: [String: Any] = ["kind": "agentTurn", "message": message]
            let trimmedThinking = thinking?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmedThinking.isEmpty {
                dict["thinking"] = trimmedThinking
            }
            if let timeoutSeconds, timeoutSeconds > 0 {
                dict["timeoutSeconds"] = timeoutSeconds
            }
            return dict
        }
    }

    func deliveryDictionary(from delivery: CronDelivery) -> [String: Any] {
        var dict: [String: Any] = ["mode": delivery.mode.rawValue]
        let channel = delivery.channel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let to = delivery.to?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch delivery.mode {
        case .announce:
            dict["channel"] = channel.isEmpty ? "last" : channel
            if !to.isEmpty {
                dict["to"] = to
            }
            if delivery.bestEffort == true {
                dict["bestEffort"] = true
            }
        case .webhook:
            if !to.isEmpty {
                dict["to"] = to
            }
        case .raw:
            if !channel.isEmpty {
                dict["channel"] = channel
            }
            if !to.isEmpty {
                dict["to"] = to
            }
            if delivery.bestEffort == true {
                dict["bestEffort"] = true
            }
        case .none:
            break
        case .unknown(_):
            if !channel.isEmpty {
                dict["channel"] = channel
            }
            if !to.isEmpty {
                dict["to"] = to
            }
            if delivery.bestEffort == true {
                dict["bestEffort"] = true
            }
        }
        return dict
    }

    func isUnknownDeliveryMode(_ mode: CronDeliveryMode) -> Bool {
        if case .unknown(_) = mode {
            return true
        }
        return false
    }

    func diffPatch(next: [String: Any], current: [String: Any]) -> [String: Any] {
        var patch: [String: Any] = [:]
        for (key, value) in next {
            if !self.valuesEqual(value, current[key]) {
                patch[key] = value
            }
        }
        return patch
    }

    func valuesEqual(_ lhs: Any, _ rhs: Any?) -> Bool {
        guard let rhs else { return false }
        guard let lhsData = self.jsonComparableData(lhs),
              let rhsData = self.jsonComparableData(rhs)
        else {
            return String(describing: lhs) == String(describing: rhs)
        }
        return lhsData == rhsData
    }

    func jsonComparableData(_ value: Any) -> Data? {
        let wrapped: [String: Any] = ["v": value]
        guard JSONSerialization.isValidJSONObject(wrapped) else { return nil }
        return try? JSONSerialization.data(withJSONObject: wrapped, options: [.sortedKeys])
    }

    func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func requireName() throws -> String {
        let name = self.trimmed(self.name)
        if name.isEmpty {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Name is required."])
        }
        return name
    }

    func buildSchedule() throws -> [String: Any] {
        switch self.scheduleKind {
        case .at:
            return ["kind": "at", "at": CronSchedule.formatIsoDate(self.atDate)]
        case .every:
            guard let ms = Self.parseDurationMs(self.everyText) else {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid every duration (use 10m, 1h, 1d)."])
            }
            return ["kind": "every", "everyMs": ms]
        case .cron:
            let expr = self.trimmed(self.cronExpr)
            if expr.isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Cron expression is required."])
            }
            let tz = self.trimmed(self.cronTz)
            if tz.isEmpty {
                return ["kind": "cron", "expr": expr]
            }
            return ["kind": "cron", "expr": expr, "tz": tz]
        }
    }

    func buildSelectedPayload() throws -> [String: Any] {
        if self.sessionTarget == .isolated { return self.buildAgentTurnPayload() }
        switch self.payloadKind {
        case .systemEvent:
            let text = self.trimmed(self.systemEventText)
            return ["kind": "systemEvent", "text": text]
        case .agentTurn:
            return self.buildAgentTurnPayload()
        }
    }

    func validateSessionTarget(_ payload: [String: Any]) throws {
        if self.sessionTarget == .main, payload["kind"] as? String == "agentTurn" {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Main session jobs require systemEvent payloads (switch Session target to isolated).",
                ])
        }

        if self.sessionTarget == .isolated, payload["kind"] as? String == "systemEvent" {
            throw NSError(
                domain: "Cron",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "Isolated jobs require agentTurn payloads."])
        }
    }

    func validatePayloadRequiredFields(_ payload: [String: Any]) throws {
        if payload["kind"] as? String == "systemEvent" {
            if (payload["text"] as? String ?? "").isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "System event text is required."])
            }
        }
        if payload["kind"] as? String == "agentTurn" {
            if (payload["message"] as? String ?? "").isEmpty {
                throw NSError(
                    domain: "Cron",
                    code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Agent message is required."])
            }
        }
    }

    func applyDeleteAfterRun(
        to root: inout [String: Any],
        scheduleKind: ScheduleKind? = nil,
        deleteAfterRun: Bool? = nil)
    {
        let resolvedSchedule = scheduleKind ?? self.scheduleKind
        let resolvedDelete = deleteAfterRun ?? self.deleteAfterRun
        if resolvedSchedule == .at {
            root["deleteAfterRun"] = resolvedDelete
        } else if self.job?.deleteAfterRun != nil {
            root["deleteAfterRun"] = false
        }
    }

    func buildAgentTurnPayload() -> [String: Any] {
        let msg = self.agentMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        var payload: [String: Any] = ["kind": "agentTurn", "message": msg]
        let thinking = self.thinking.trimmingCharacters(in: .whitespacesAndNewlines)
        if !thinking.isEmpty { payload["thinking"] = thinking }
        if let n = Int(self.timeoutSeconds), n > 0 { payload["timeoutSeconds"] = n }
        return payload
    }

    static func parseDurationMs(_ input: String) -> Int? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }

        let rx = try? NSRegularExpression(pattern: "^(\\d+(?:\\.\\d+)?)(ms|s|m|h|d)$", options: [.caseInsensitive])
        guard let match = rx?.firstMatch(in: raw, range: NSRange(location: 0, length: raw.utf16.count)) else {
            return nil
        }
        func group(_ idx: Int) -> String {
            let range = match.range(at: idx)
            guard let r = Range(range, in: raw) else { return "" }
            return String(raw[r])
        }
        let n = Double(group(1)) ?? 0
        if !n.isFinite || n <= 0 { return nil }
        let unit = group(2).lowercased()
        let factor: Double = switch unit {
        case "ms": 1
        case "s": 1000
        case "m": 60000
        case "h": 3_600_000
        default: 86_400_000
        }
        return Int(floor(n * factor))
    }

    func formatDuration(ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let s = Double(ms) / 1000.0
        if s < 60 { return "\(Int(round(s)))s" }
        let m = s / 60.0
        if m < 60 { return "\(Int(round(m)))m" }
        let h = m / 60.0
        if h < 48 { return "\(Int(round(h)))h" }
        let d = h / 24.0
        return "\(Int(round(d)))d"
    }
}
