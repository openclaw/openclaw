import Foundation

/// A change to effort, speed or the model that the server did not save, after one quiet retry.
public struct ChatSettingsChangeFailure {
    public let id: Int
    public let text: String
    public let retry: @MainActor () -> Void
}

struct OptimisticSettingsLane {
    var latestFastModeRequestID: UInt64?
    /// The model the server had when a run of picks began: a failed pick falls back to it.
    var modelBaselineSelectionID: String?
}

extension OpenClawChatViewModel {
    /// How long a send waits for a model or speed save in flight. The person's message is already on
    /// screen while it waits, and one save on a healthy connection takes well under this.
    static let settingsFlushBeforeSend: Duration = .milliseconds(1500)

    /// One quiet retry for a settings save: a busy or reconnecting server often answers the second time.
    static func retryingOnce<T>(_ operation: () async throws -> T) async throws -> T {
        do {
            return try await operation()
        } catch {
            return try await operation()
        }
    }

    /// Each failure gets a new id, so the same change failing twice is announced twice.
    func reportSettingsChangeFailure(_ text: String, retry: @escaping @MainActor () -> Void) {
        self.settingsChangeFailure = ChatSettingsChangeFailure(
            id: (self.settingsChangeFailure?.id ?? 0) + 1,
            text: text,
            retry: retry)
    }

    /// The model the server had when a run of picks began; a failed pick falls back to it.
    func modelLaneBaseline(for target: ModelPatchTarget, current: String) -> String {
        if self.inFlightSettingsPatchCountsByTarget[target] == nil {
            self.optimisticSettingsLanes[target, default: .init()].modelBaselineSelectionID = current
        }
        return self.optimisticSettingsLanes[target]?.modelBaselineSelectionID ?? current
    }

    func clearOptimisticSettingsLane(for target: ModelPatchTarget) {
        self.latestThinkingSelectionRequestIDsByTarget.removeValue(forKey: target)
        self.optimisticSettingsLanes.removeValue(forKey: target)
    }

    func reportModelChangeFailure(_ error: Error, selectionID: String) {
        chatUILogger.error("sessions.patch(model) failed \(error.localizedDescription, privacy: .public)")
        #if os(iOS)
        self.reportSettingsChangeFailure(String(localized: "Couldn’t change the model")) { [weak self] in
            self?.selectModel(selectionID)
        }
        #else
        self.errorText = String(localized: "Couldn’t change the model.")
        #endif
    }
}
