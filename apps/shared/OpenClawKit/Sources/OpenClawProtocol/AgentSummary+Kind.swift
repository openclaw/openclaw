import Foundation

public extension AgentSummary {
    var isSelectableAgent: Bool {
        kind != .system
    }
}
