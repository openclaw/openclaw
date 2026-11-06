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

    enum BadgeProminence: Equatable {
        case primary
        case secondary
        case overridden
    }

    var badgeSymbolName: String {
        switch self.activity {
        case .tool(.bash): "chevron.left.slash.chevron.right"
        case .tool(.read): "doc"
        case .tool(.write): "pencil"
        case .tool(.edit): "pencil.tip"
        case .tool(.attach): "paperclip"
        case .tool(.other), .job: "gearshape.fill"
        }
    }

    var badgeProminence: BadgeProminence? {
        switch self {
        case .idle: nil
        case .workingMain: .primary
        case .workingOther: .secondary
        case .overridden: .overridden
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

    var id: String {
        self.rawValue
    }

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

    func fixedIconState() -> IconState? {
        switch self {
        case .system: nil
        case .idle: .idle
        case .mainBash, .otherBash: .overridden(.tool(.bash))
        case .mainRead, .otherRead: .overridden(.tool(.read))
        case .mainWrite, .otherWrite: .overridden(.tool(.write))
        case .mainEdit, .otherEdit: .overridden(.tool(.edit))
        case .mainOther, .otherOther: .overridden(.tool(.other))
        }
    }
}
