import Foundation
import Observation

/// Recorded fact for the Mac node channel, written by MacNodeModeCoordinator at
/// the connect boundary. The menu bar reads this instead of inferring node
/// health from gateway node listings, so a node channel that never dials still
/// surfaces its reason to the operator.
enum MacNodeChannelState: Equatable, Sendable {
    enum RecoveryAction: Equatable, Sendable {
        case checkForUpdates
    }

    /// Node mode is paused, stopped, or not configured to run.
    case idle
    /// The channel connected. A non-nil reason means the node-host worker is
    /// unavailable and only native capabilities are advertised.
    case connected(workerUnavailableReason: String?, diagnostic: String? = nil)
    /// The last connect attempt failed; the coordinator keeps retrying.
    case unavailable(reason: String, diagnostic: String? = nil)

    var operatorStatusLine: (
        label: String,
        diagnostic: String?,
        isDegraded: Bool,
        recoveryAction: RecoveryAction?)?
    {
        switch self {
        case .idle, .connected(workerUnavailableReason: nil, diagnostic: _):
            return nil
        case let .connected(workerUnavailableReason: .some(reason), diagnostic: diagnostic):
            let compatibility = Self.workerSchemaMismatch(in: reason + "\n" + (diagnostic ?? ""))
            let label = compatibility.map {
                "Mac node degraded — update the OpenClaw app: its worker supports schema \($0.supported), " +
                    "but shared state requires schema \($0.required)"
            } ?? "Mac node degraded — \(Self.condense(reason))"
            return (label, Self.excerpt(diagnostic), true, compatibility == nil ? nil : .checkForUpdates)
        case let .unavailable(reason, diagnostic):
            let compatibility = Self.workerSchemaMismatch(in: reason + "\n" + (diagnostic ?? ""))
            let label = compatibility.map {
                "Mac node unavailable — update the OpenClaw app: its worker supports schema \($0.supported), " +
                    "but shared state requires schema \($0.required)"
            } ?? "Mac node unavailable — \(Self.condense(reason))"
            return (label, Self.excerpt(diagnostic), false, compatibility == nil ? nil : .checkForUpdates)
        }
    }

    private static func workerSchemaMismatch(in message: String) -> (required: Int, supported: Int)? {
        let marker = "uses newer schema version "
        guard let markerRange = message.range(of: marker),
              let separatorRange = message[markerRange.upperBound...].range(of: "; this build supports ")
        else { return nil }

        let requiredText = message[markerRange.upperBound..<separatorRange.lowerBound]
        let supportedSuffix = message[separatorRange.upperBound...]
        let supportedText = supportedSuffix.prefix(while: \.isNumber)
        guard let required = Int(requiredText),
              let supported = Int(supportedText),
              required > supported
        else { return nil }
        return (required, supported)
    }

    /// Menu status lines are single-line; keep the leading reason sentence and
    /// bound it so a CLI stack trace cannot flood the menu.
    private static func condense(_ reason: String) -> String {
        let firstLine = reason
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? reason
        return firstLine.count > 220 ? firstLine.prefix(220) + "…" : firstLine
    }

    /// Preserve complete stderr lines whenever possible so truncation cannot
    /// turn a useful CLI diagnostic into another clipped headline fragment.
    private static func excerpt(_ diagnostic: String?) -> String? {
        guard let diagnostic = diagnostic?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else {
            return nil
        }
        let lines = diagnostic.split(separator: "\n", omittingEmptySubsequences: false)
        let needsEllipsis = diagnostic.count > 360 || lines.count > 4
        let maximumLength = needsEllipsis ? 359 : 360
        var retainedLines: [Substring] = []
        var retainedLength = 0

        for line in lines.prefix(4) {
            let length = retainedLength + (retainedLines.isEmpty ? 0 : 1) + line.count
            guard length <= maximumLength else { break }
            retainedLines.append(line)
            retainedLength = length
        }

        if retainedLines.isEmpty {
            let prefix = diagnostic.prefix(maximumLength)
            let boundary = prefix.lastIndex(where: \.isWhitespace) ?? prefix.endIndex
            return "\(prefix[..<boundary])…"
        }

        let excerpt = retainedLines.joined(separator: "\n")
        return retainedLines.count == lines.count ? excerpt : "\(excerpt)…"
    }
}

@MainActor
@Observable
final class MacNodeChannelStatusStore {
    static let shared = MacNodeChannelStatusStore()

    private(set) var state: MacNodeChannelState = .idle

    func record(_ state: MacNodeChannelState) {
        guard self.state != state else { return }
        self.state = state
    }
}
