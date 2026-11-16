import Foundation

/// Native first run prepares the host, then waits for an explicit AI connection choice.
@MainActor
enum OnboardingFirstRun {
    enum Page: Int {
        case welcome = 0, connection = 1, runtime = 2, aiSetup = 3
    }

    enum Step {
        case preparingRuntime, startingGateway
    }

    struct Fallback: Equatable {
        let page: Page
        let message: String?
    }

    static func isFresh(
        isUnconfigured: Bool,
        onboardingSeen: Bool,
        onboardingVersion: Int,
        configExists: Bool,
        hasRemoteSettings: Bool) -> Bool
    {
        isUnconfigured && !onboardingSeen && onboardingVersion == 0 &&
            !configExists && !hasRemoteSettings
    }

    static func run(
        reportProgress: (Step) -> Void = { _ in },
        selectLocal: () throws -> Void,
        prepareRuntime: () async throws -> Void,
        startGateway: () async throws -> Void) async -> Fallback?
    {
        var page = Page.connection
        do {
            try Task.checkCancellation()
            reportProgress(.preparingRuntime)
            try selectLocal()
            page = .runtime
            try await prepareRuntime()
            try Task.checkCancellation()
            reportProgress(.startingGateway)
            try await startGateway()
            try Task.checkCancellation()
            // Detection is passive. The AI page owns the user's choice and the
            // verified handoff; opening a dashboard must not choose AI for them.
            return Fallback(page: .aiSetup, message: nil)
        } catch {
            return Fallback(page: page, message: error.localizedDescription)
        }
    }
}
