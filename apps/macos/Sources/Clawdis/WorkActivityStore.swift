import Foundation
import SwiftUI

@MainActor
final class WorkActivityStore: ObservableObject {
    static let shared = WorkActivityStore()

    struct Activity: Equatable {
        let sessionKey: String
        let role: SessionRole
        let kind: ActivityKind
        let label: String
        let startedAt: Date
        var lastUpdate: Date
    }

    @Published private(set) var current: Activity?
    @Published private(set) var iconState: IconState = .idle

    private var active: [String: Activity] = [:]
    private var currentSessionKey: String?

    private let mainSessionKey = "main"
    private let toolResultGrace: TimeInterval = 2.0

    func handleJob(sessionKey: String, state: String) {
        let isStart = state.lowercased() == "started" || state.lowercased() == "streaming"
        if isStart {
            let activity = Activity(
                sessionKey: sessionKey,
                role: self.role(for: sessionKey),
                kind: .job,
                label: "job",
                startedAt: Date(),
                lastUpdate: Date())
            self.setActive(activity)
        } else {
            self.markIdle(sessionKey: sessionKey)
        }
    }

    func handleTool(
        sessionKey: String,
        phase: String,
        name: String?,
        meta: String?,
        args: [String: AnyCodable]?
    ) {
        let toolKind = Self.mapToolKind(name)
        let label = Self.buildLabel(kind: toolKind, meta: meta, args: args)
        if phase.lowercased() == "start" {
            let activity = Activity(
                sessionKey: sessionKey,
                role: self.role(for: sessionKey),
                kind: .tool(toolKind),
                label: label,
                startedAt: Date(),
                lastUpdate: Date())
            self.setActive(activity)
        } else {
            // Delay removal slightly to avoid flicker on rapid result/start bursts.
            let key = sessionKey
            Task { [weak self] in
                let nsDelay = UInt64((self?.toolResultGrace ?? 0) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nsDelay)
                await MainActor.run {
                    self?.markIdle(sessionKey: key)
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

    private func setActive(_ activity: Activity) {
        self.active[activity.sessionKey] = activity
        // Main session preempts immediately.
        if activity.role == .main {
            self.currentSessionKey = activity.sessionKey
        } else if self.currentSessionKey == nil || self.active[self.currentSessionKey!] == nil {
            self.currentSessionKey = activity.sessionKey
        }
        self.current = self.active[self.currentSessionKey ?? ""]
        self.iconState = self.deriveIconState()
    }

    private func markIdle(sessionKey: String) {
        guard let existing = self.active[sessionKey] else { return }
        // Update timestamp so replacement prefers newer others.
        var updated = existing
        updated.lastUpdate = Date()
        self.active[sessionKey] = updated
        self.active.removeValue(forKey: sessionKey)

        if self.currentSessionKey == sessionKey {
            self.pickNextSession()
        }
        self.current = self.active[self.currentSessionKey ?? ""]
        self.iconState = self.deriveIconState()
    }

    private func pickNextSession() {
        // Prefer main if present.
        if let main = self.active[self.mainSessionKey] {
            self.currentSessionKey = main.sessionKey
            return
        }
        // Otherwise, pick most recent by lastUpdate.
        if let next = self.active.values.sorted(by: { $0.lastUpdate > $1.lastUpdate }).first {
            self.currentSessionKey = next.sessionKey
        } else {
            self.currentSessionKey = nil
        }
    }

    private func role(for sessionKey: String) -> SessionRole {
        sessionKey == self.mainSessionKey ? .main : .other
    }

    private func deriveIconState() -> IconState {
        guard let activity = self.current else { return .idle }
        switch activity.role {
        case .main: return .workingMain(activity.kind)
        case .other: return .workingOther(activity.kind)
        }
    }

    private static func mapToolKind(_ name: String?) -> ToolKind {
        switch name?.lowercased() {
        case "bash", "shell": return .bash
        case "read": return .read
        case "write": return .write
        case "edit": return .edit
        case "attach": return .attach
        default: return .other
        }
    }

    private static func buildLabel(
        kind: ToolKind,
        meta: String?,
        args: [String: AnyCodable]?
    ) -> String {
        switch kind {
        case .bash:
            if let cmd = args?["command"]?.value as? String {
                return "bash: \(cmd.split(separator: "\n").first ?? "")"
            }
            return "bash"
        case .read, .write, .edit, .attach:
            if let path = Self.extractPath(args: args, meta: meta) {
                return "\(kind.rawValue): \(path)"
            }
            return kind.rawValue
        case .other:
            if let name = args?["name"]?.value as? String {
                return name
            }
            return "tool"
        }
    }

    private static func extractPath(args: [String: AnyCodable]?, meta: String?) -> String? {
        if let p = args?["path"]?.value as? String { return shortenHome(path: p) }
        if let p = args?["file_path"]?.value as? String { return shortenHome(path: p) }
        if let meta { return shortenHome(path: meta) }
        return nil
    }

    private static func shortenHome(path: String) -> String {
        let home = NSHomeDirectory()
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }
}
