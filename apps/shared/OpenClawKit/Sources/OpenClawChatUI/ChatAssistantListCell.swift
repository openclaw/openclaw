import Foundation

/// A native List cell's identity is its content, not the transient run-group
/// ancestry. Trimming an input may change grouping but must not replace surviving rows.
struct ChatAssistantListCell: Identifiable {
    enum ID: Hashable {
        case row(UUID)
        case tool(String?, String)
        case live
    }

    let id: ID
    let group: ChatAssistantRunGroup
    let part: ChatAssistantRunGroup.Part?
    let joinsAbove: Bool
    let joinsBelow: Bool

    static func cells(_ groups: ArraySlice<ChatAssistantRunGroup>) -> [Self] {
        groups.flatMap { group in
            let count = group.parts.count + (group.includesLive ? 1 : 0)
            var cells = group.parts.enumerated().map { index, part in
                let id: ID = switch part {
                case let .row(row): .row(row.id)
                case let .tool(tool): .tool(tool.runID, tool.id)
                }
                return Self(
                    id: id,
                    group: group,
                    part: part,
                    joinsAbove: group.runID != nil && index > 0,
                    joinsBelow: group.runID != nil && index < count - 1)
            }
            if group.includesLive {
                cells.append(Self(
                    id: .live,
                    group: group,
                    part: nil,
                    joinsAbove: group.runID != nil && !group.parts.isEmpty,
                    joinsBelow: false))
            }
            return cells
        }
    }
}
