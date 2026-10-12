import Foundation

/// The native first run only prepares the local host; the dashboard owns AI setup.
@MainActor
enum OnboardingFirstRun {
    enum Page: Int {
        case welcome = 0, connection = 1, runtime = 2, aiSetup = 3
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
        selectLocal: () throws -> Void,
        prepareRuntime: () async throws -> Void,
        startGateway: () async throws -> Void,
        supportsAutomaticSetup: () async throws -> Bool,
        openDashboard: () async throws -> Void,
        markComplete: () -> Void) async -> Fallback?
    {
        var page = Page.connection
        do {
            try Task.checkCancellation()
            try selectLocal()
            page = .runtime
            try await prepareRuntime()
            try Task.checkCancellation()
            try await startGateway()
            try Task.checkCancellation()
            page = .connection
            guard try await supportsAutomaticSetup() else {
                return Fallback(page: .aiSetup, message: nil)
            }
            try Task.checkCancellation()
            page = .aiSetup
            try await openDashboard()
            try Task.checkCancellation()
            markComplete()
            return nil
        } catch {
            return Fallback(page: page, message: error.localizedDescription)
        }
    }
}
