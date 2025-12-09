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
        case .tool(.bash): "💻"
        case .tool(.read): "📄"
        case .tool(.write): "✍️"
        case .tool(.edit): "📝"
        case .tool(.attach): "📎"
        case .tool(.other), .job: "🛠️"
        }
    }

    var tint: Color {
        switch self {
        case .workingMain: .accentColor
        case .workingOther: .gray
        case .overridden: .orange
        case .idle: .clear
        }
    }

    var isWorking: Bool {
        switch self {
        case .idle: false
        default: true
        }
    }

    private var activity: ActivityKind {
        switch self {
        case let .workingMain(kind),
             let .workingOther(kind),
             let .overridden(kind):
            kind
        case .idle:
            .job
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
        case .system: "System (auto)"
        case .idle: "Idle"
        case .mainBash: "Working main – bash"
        case .mainRead: "Working main – read"
        case .mainWrite: "Working main – write"
        case .mainEdit: "Working main – edit"
        case .mainOther: "Working main – other"
        case .otherBash: "Working other – bash"
        case .otherRead: "Working other – read"
        case .otherWrite: "Working other – write"
        case .otherEdit: "Working other – edit"
        case .otherOther: "Working other – other"
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
