import AppKit
import Foundation

enum SessionActions {
    static func patchSession(
        key: String,
        thinking: String?? = nil,
        verbose: String?? = nil) async throws
    {
        var params: [String: AnyHashable] = ["key": AnyHashable(key)]

        if let thinking {
            params["thinkingLevel"] = thinking.map(AnyHashable.init) ?? AnyHashable(NSNull())
        }
        if let verbose {
            params["verboseLevel"] = verbose.map(AnyHashable.init) ?? AnyHashable(NSNull())
        }

        _ = try await ControlChannel.shared.request(method: "sessions.patch", params: params)
    }

    static func resetSession(key: String) async throws {
        _ = try await ControlChannel.shared.request(
            method: "sessions.reset",
            params: ["key": AnyHashable(key)])
    }

    static func deleteSession(key: String) async throws {
        _ = try await ControlChannel.shared.request(
            method: "sessions.delete",
            params: ["key": AnyHashable(key), "deleteTranscript": AnyHashable(true)])
    }

    static func compactSession(key: String, maxLines: Int = 400) async throws {
        _ = try await ControlChannel.shared.request(
            method: "sessions.compact",
            params: ["key": AnyHashable(key), "maxLines": AnyHashable(maxLines)])
    }

    @MainActor
    static func confirmDestructiveAction(title: String, message: String, action: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        return alert.runModal() == .alertFirstButtonReturn
    }

    @MainActor
    static func presentError(title: String, error: Error) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.alertStyle = .warning
        alert.runModal()
    }

}
