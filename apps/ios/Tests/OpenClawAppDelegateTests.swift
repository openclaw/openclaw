import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct OpenClawAppDelegateTests {
    @Test @MainActor func `resolves registry model before view task assigns delegate model`() {
        let registryModel = NodeAppModel()
        OpenClawAppModelRegistry.appModel = registryModel
        defer { OpenClawAppModelRegistry.appModel = nil }

        let delegate = OpenClawAppDelegate()

        #expect(delegate._test_resolvedAppModel() === registryModel)
    }

    @Test @MainActor func `prefers explicit delegate model over registry fallback`() {
        let registryModel = NodeAppModel()
        let explicitModel = NodeAppModel()
        OpenClawAppModelRegistry.appModel = registryModel
        defer { OpenClawAppModelRegistry.appModel = nil }

        let delegate = OpenClawAppDelegate()
        delegate.appModel = explicitModel

        #expect(delegate._test_resolvedAppModel() === explicitModel)
    }

    @Test @MainActor func `derives background refresh task identifier from app bundle identifier`() {
        let delegate = OpenClawAppDelegate()
        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "ai.openclawfoundation.app.tests"

        #expect(delegate._test_wakeRefreshTaskIdentifier() == "\(bundleIdentifier).bgrefresh")
    }
}
