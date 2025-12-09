import Foundation
import SwiftUI

enum SessionRole {
    case main
    case other
}

enum ToolKind: String, Codable {
    case bash, read, write, edit, attach, other
}

enum ActivityKind: Codable, Equatable {
    case job
    case tool(ToolKind)
}

enum IconState: Equatable {
    case idle
    case workingMain(ActivityKind)
    case workingOther(ActivityKind)
    case overridden(ActivityKind)

    var glyph: String {
        switch self.activity {
        case .tool(.bash): return "💻"
        case .tool(.read): return "📄"
        case .tool(.write): return "✍️"
        case .tool(.edit): return "📝"
        case .tool(.attach): return "📎"
        case .tool(.other), .job: return "🛠️"
        }
    }

    var tint: Color {
        switch self {
        case .workingMain: return .accentColor
        case .workingOther: return .gray
        case .overridden: return .orange
        case .idle: return .clear
        }
    }

    var isWorking: Bool {
        switch self {
        case .idle: return false
        default: return true
        }
    }

    private var activity: ActivityKind {
        switch self {
        case let .workingMain(kind),
             let .workingOther(kind),
             let .overridden(kind):
            return kind
        case .idle:
            return .job
        }
    }
}

enum IconOverrideSelection: String, CaseIterable, Identifiable {
    case system
    case idle
    case mainBash, mainRead, mainWrite, mainEdit, mainOther
    case otherBash, otherRead, otherWrite, otherEdit, otherOther

    var id: String { self.rawValue }

    var label: String {
        switch self {
        case .system: return "System (auto)"
        case .idle: return "Idle"
        case .mainBash: return "Working main – bash"
        case .mainRead: return "Working main – read"
        case .mainWrite: return "Working main – write"
        case .mainEdit: return "Working main – edit"
        case .mainOther: return "Working main – other"
        case .otherBash: return "Working other – bash"
        case .otherRead: return "Working other – read"
        case .otherWrite: return "Working other – write"
        case .otherEdit: return "Working other – edit"
        case .otherOther: return "Working other – other"
        }
    }

    func toIconState() -> IconState {
        let map: (ToolKind) -> ActivityKind = { .tool($0) }
        switch self {
        case .system: return .idle
        case .idle: return .idle
        case .mainBash: return .workingMain(map(.bash))
        case .mainRead: return .workingMain(map(.read))
        case .mainWrite: return .workingMain(map(.write))
        case .mainEdit: return .workingMain(map(.edit))
        case .mainOther: return .workingMain(map(.other))
        case .otherBash: return .workingOther(map(.bash))
        case .otherRead: return .workingOther(map(.read))
        case .otherWrite: return .workingOther(map(.write))
        case .otherEdit: return .workingOther(map(.edit))
        case .otherOther: return .workingOther(map(.other))
        }
    }
}
