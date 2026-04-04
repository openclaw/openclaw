import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import SwiftUI

/// Helper class to store task reference outside of @MainActor context for proper cleanup
private final class TaskStorage {
    var task: Task<Void, Never>?

    deinit {
        task?.cancel()
    }
}

@MainActor
@Observable
final class WorkActivityStore {
    static let shared = WorkActivityStore()

    struct Activity: Equatable {
        let sessionKey: String
        let role: SessionRole
        let kind: ActivityKind
        let label: String
        let startedAt: Date
        var lastUpdate: Date

        mutating func refreshTimestamp() {
            self.lastUpdate = Date()
        }
    }

    private(set) var current: Activity?
    private(set) var iconState: IconState = .idle
    private(set) var lastToolLabel: String?
    private(set) var lastToolUpdatedAt: Date?

    internal var jobs: [String: Activity] = [:]
    private var tools: [String: Activity] = [:]
    private var currentSessionKey: String?
    private var toolSeqBySession: [String: Int] = [:]

    // MARK: - Watchdog Configuration

    /// Watchdog system to clear stale jobs that never received a "done" event.
    /// This prevents the menubar icon from freezing when AI providers (e.g. Anthropic)
    /// return overload/timeout errors and the gateway never sends run-end events.
    ///
    /// The watchdog runs every 30 seconds and evicts jobs/tools that haven't been
    /// updated in over 120 seconds. Job timestamps are refreshed on streaming updates
    /// and tool activity to prevent false evictions of healthy long-running tasks.
    private static let jobWatchdogInterval: TimeInterval = 30.0
    private static let jobStaleThreshold: TimeInterval = 120.0
    private let watchdogTaskStorage: TaskStorage = TaskStorage()

    /// Access the watchdog task for testing purposes
    internal var watchdogTask: Task<Void, Never>? {
        get { watchdogTaskStorage.task }
        set { watchdogTaskStorage.task = newValue }
    }

    private var mainSessionKeyStorage = "main"
    private let toolResultGrace: TimeInterval = 2.0

    init() {
        self.startWatchdog()
    }

    deinit {
        // TaskStorage will automatically cancel the task in its own deinit
    }

    var mainSessionKey: String {
        self.mainSessionKeyStorage
    }

    func handleJob(sessionKey: String, state: String) {
        let isStart = state.lowercased() == "started" || state.lowercased() == "streaming"
        if isStart {
            if var existing = self.jobs[sessionKey], state.lowercased() == "streaming" {
                // Update timestamp for streaming updates on existing jobs
                existing.refreshTimestamp()
                self.setJobActive(existing)
            } else {
                // Create new job activity
                let activity = Activity(
                    sessionKey: sessionKey,
                    role: self.role(for: sessionKey),
                    kind: .job,
                    label: "job",
                    startedAt: Date(),
                    lastUpdate: Date())
                self.setJobActive(activity)
            }
        } else {
            // Job ended (done/error/aborted/etc). Clear everything for this session.
            self.clearTool(sessionKey: sessionKey)
            self.clearJob(sessionKey: sessionKey)
        }
    }

    func handleTool(
        sessionKey: String,
        phase: String,
        name: String?,
        meta: String?,
        args: [String: OpenClawProtocol.AnyCodable]?)
    {
        let toolKind = Self.mapToolKind(name)
        let label = Self.buildLabel(name: name, meta: meta, args: args)
        if phase.lowercased() == "start" {
            self.lastToolLabel = label
            self.lastToolUpdatedAt = Date()
            self.toolSeqBySession[sessionKey, default: 0] += 1

            // Refresh the job's lastUpdate timestamp to keep it alive during tool activity
            if var job = self.jobs[sessionKey] {
                job.refreshTimestamp()
                self.jobs[sessionKey] = job
            }

            let activity = Activity(
                sessionKey: sessionKey,
                role: self.role(for: sessionKey),
                kind: .tool(toolKind),
                label: label,
                startedAt: Date(),
                lastUpdate: Date())
            self.setToolActive(activity)
        } else {
            // Delay removal slightly to avoid flicker on rapid result/start bursts.
            let key = sessionKey
            let seq = self.toolSeqBySession[key, default: 0]
            Task { [weak self] in
                let nsDelay = UInt64((self?.toolResultGrace ?? 0) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nsDelay)
                await MainActor.run {
                    guard let self else { return }
                    guard self.toolSeqBySession[key, default: 0] == seq else { return }
                    self.lastToolUpdatedAt = Date()
                    self.clearTool(sessionKey: key)
                }
            }
        }
    }

    func resolveIconState(override selection: IconOverrideSelection) {
        switch selection {
        case .system:
            self.iconState = self.deriveIconState()
        case .idle:
            self.iconState = .idle
        default:
            let base = selection.toIconState()
            switch base {
            case let .workingMain(kind),
                 let .workingOther(kind):
                self.iconState = .overridden(kind)
            case let .overridden(kind):
                self.iconState = .overridden(kind)
            case .idle:
                self.iconState = .idle
            }
        }
    }

    private func setJobActive(_ activity: Activity) {
        self.jobs[activity.sessionKey] = activity
        self.updateCurrentSession(with: activity)
    }

    private func setToolActive(_ activity: Activity) {
        self.tools[activity.sessionKey] = activity
        self.updateCurrentSession(with: activity)
    }

    private func updateCurrentSession(with activity: Activity) {
        // Main session preempts immediately.
        if activity.role == .main {
            self.currentSessionKey = activity.sessionKey
        } else if self.currentSessionKey == nil || !self.isActive(sessionKey: self.currentSessionKey!) {
            self.currentSessionKey = activity.sessionKey
        }
        self.refreshDerivedState()
    }

    func setMainSessionKey(_ sessionKey: String) {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard trimmed != self.mainSessionKeyStorage else { return }
        self.mainSessionKeyStorage = trimmed
        if let current = self.currentSessionKey, !self.isActive(sessionKey: current) {
            self.pickNextSession()
        }
        self.refreshDerivedState()
    }

    private func clearJob(sessionKey: String) {
        guard self.jobs[sessionKey] != nil else { return }
        self.jobs.removeValue(forKey: sessionKey)

        if self.currentSessionKey == sessionKey, !self.isActive(sessionKey: sessionKey) {
            self.pickNextSession()
        }
        self.refreshDerivedState()
    }

    private func clearTool(sessionKey: String) {
        guard self.tools[sessionKey] != nil else { return }
        self.tools.removeValue(forKey: sessionKey)

        if self.currentSessionKey == sessionKey, !self.isActive(sessionKey: sessionKey) {
            self.pickNextSession()
        }
        self.refreshDerivedState()
    }

    private func pickNextSession() {
        // Prefer main if present.
        if self.isActive(sessionKey: self.mainSessionKeyStorage) {
            self.currentSessionKey = self.mainSessionKeyStorage
            return
        }

        // Otherwise, pick most recent by lastUpdate across job/tool.
        let keys = Set(self.jobs.keys).union(self.tools.keys)
        let next = keys.max(by: { self.lastUpdate(for: $0) < self.lastUpdate(for: $1) })
        self.currentSessionKey = next
    }

    private func role(for sessionKey: String) -> SessionRole {
        sessionKey == self.mainSessionKeyStorage ? .main : .other
    }

    private func isActive(sessionKey: String) -> Bool {
        self.jobs[sessionKey] != nil || self.tools[sessionKey] != nil
    }

    private func lastUpdate(for sessionKey: String) -> Date {
        max(self.jobs[sessionKey]?.lastUpdate ?? .distantPast, self.tools[sessionKey]?.lastUpdate ?? .distantPast)
    }

    private func currentActivity(for sessionKey: String) -> Activity? {
        // Prefer tool overlay if present, otherwise job.
        self.tools[sessionKey] ?? self.jobs[sessionKey]
    }

    private func refreshDerivedState() {
        if let key = self.currentSessionKey, !self.isActive(sessionKey: key) {
            self.currentSessionKey = nil
        }
        self.current = self.currentSessionKey.flatMap { self.currentActivity(for: $0) }
        self.iconState = self.deriveIconState()
    }

    private func deriveIconState() -> IconState {
        guard let sessionKey = self.currentSessionKey,
              let activity = self.currentActivity(for: sessionKey)
        else { return .idle }

        switch activity.role {
        case .main: return .workingMain(activity.kind)
        case .other: return .workingOther(activity.kind)
        }
    }

    private static func mapToolKind(_ name: String?) -> ToolKind {
        switch name?.lowercased() {
        case "bash", "shell": .bash
        case "read": .read
        case "write": .write
        case "edit": .edit
        case "attach": .attach
        default: .other
        }
    }

    private static func buildLabel(
        name: String?,
        meta: String?,
        args: [String: OpenClawProtocol.AnyCodable]?) -> String
    {
        let wrappedArgs = self.wrapToolArgs(args)
        let display = ToolDisplayRegistry.resolve(name: name ?? "tool", args: wrappedArgs, meta: meta)
        if let detail = display.detailLine, !detail.isEmpty {
            return "\(display.label): \(detail)"
        }

        return display.label
    }

    private static func wrapToolArgs(_ args: [String: OpenClawProtocol.AnyCodable]?) -> OpenClawKit.AnyCodable? {
        guard let args else { return nil }
        let converted: [String: Any] = args.mapValues { self.unwrapJSONValue($0.value) }
        return OpenClawKit.AnyCodable(converted)
    }

    private static func unwrapJSONValue(_ value: Any) -> Any {
        if let dict = value as? [String: OpenClawProtocol.AnyCodable] {
            return dict.mapValues { self.unwrapJSONValue($0.value) }
        }
        if let array = value as? [OpenClawProtocol.AnyCodable] {
            return array.map { self.unwrapJSONValue($0.value) }
        }
        if let dict = value as? [String: Any] {
            return dict.mapValues { self.unwrapJSONValue($0) }
        }
        if let array = value as? [Any] {
            return array.map { self.unwrapJSONValue($0) }
        }
        return value
    }

    // MARK: - Watchdog

    /// Periodically evicts jobs and tools that have been stuck with no completion event.
    /// This prevents the menubar icon from freezing when the AI provider (e.g. Anthropic)
    /// returns an overload/timeout error and the gateway never sends the run-end event.
    private func startWatchdog() {
        self.watchdogTask?.cancel()
        self.watchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.jobWatchdogInterval * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await MainActor.run { self?.evictStaleActivities() }
            }
        }
    }

    internal func evictStaleActivities() {
        let now = Date()
        let threshold = Self.jobStaleThreshold
        var changed = false

        // Collect stale keys first to avoid mutation during iteration
        var staleJobKeys: [String] = []
        var staleToolKeys: [String] = []

        for (key, activity) in self.jobs {
            if now.timeIntervalSince(activity.lastUpdate) > threshold {
                staleJobKeys.append(key)
            }
        }
        for (key, activity) in self.tools {
            if now.timeIntervalSince(activity.lastUpdate) > threshold {
                staleToolKeys.append(key)
            }
        }

        // Remove stale activities
        for key in staleJobKeys {
            self.jobs.removeValue(forKey: key)
            changed = true
        }
        for key in staleToolKeys {
            self.tools.removeValue(forKey: key)
            changed = true
        }

        if changed {
            if let key = self.currentSessionKey, !self.isActive(sessionKey: key) {
                self.pickNextSession()
            }
            self.refreshDerivedState()
        }
    }
}
