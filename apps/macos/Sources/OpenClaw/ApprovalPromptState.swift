import Foundation
import Observation
import OpenClawKit

/// Presentation owners publish their pending state; automation never resolves it.
@MainActor
@Observable
final class ApprovalPromptState {
    static let shared = ApprovalPromptState()
    private var sources: Set<UUID> = []

    var isPending: Bool {
        !self.sources.isEmpty
    }

    func setPending(_ pending: Bool, source: UUID) {
        if pending {
            self.sources.insert(source)
        } else {
            self.sources.remove(source)
        }
    }

    func checkScreenCapture(excludesApplication: Bool) throws {
        if !excludesApplication {
            try self.checkComputerAction(.screenshot)
        }
    }

    func checkComputerAction(_ action: OpenClawComputerAction) throws {
        switch action {
        case .listApps, .listWindows, .getCursorPosition:
            return
        default:
            guard !self.isPending else {
                throw ComputerActionService.ComputerActionError.refused(
                    "A human approval prompt is open on this Mac; wait for the user to answer it")
            }
        }
    }
}
