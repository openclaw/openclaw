import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingFirstRunTests {
    @Test func `automatic setup only selects a completely fresh installation`() {
        #expect(OnboardingFirstRun.isFresh(
            isUnconfigured: true, onboardingSeen: false, onboardingVersion: 0,
            configExists: false, hasRemoteSettings: false))
        #expect(!OnboardingFirstRun.isFresh(
            isUnconfigured: false, onboardingSeen: false, onboardingVersion: 0,
            configExists: false, hasRemoteSettings: false))
        for existing in 0..<4 {
            #expect(!OnboardingFirstRun.isFresh(
                isUnconfigured: true, onboardingSeen: existing == 0, onboardingVersion: existing == 1 ? 1 : 0,
                configExists: existing == 2, hasRemoteSettings: existing == 3))
        }
    }

    @Test func `first run prepares the host then waits for an explicit AI choice`() async {
        var effects: [String] = []
        let fallback = await OnboardingFirstRun.run(
            reportProgress: { effects.append("show \($0)") },
            selectLocal: { effects.append("local") },
            prepareRuntime: { effects.append("runtime") },
            startGateway: { effects.append("start") })
        #expect(fallback == .init(page: .aiSetup, message: nil))
        #expect(effects == ["show preparingRuntime", "local", "runtime", "show startingGateway", "start"])
    }

    @Test(arguments: 0..<3)
    func `failures preserve unfinished onboarding and return to the relevant page`(failureStep: Int) async {
        struct Failure: LocalizedError {
            var errorDescription: String? { "Fixture setup failure" }
        }
        let check: (Int) throws -> Void = { step in
            if step == failureStep { throw Failure() }
        }
        let fallback = await OnboardingFirstRun.run(
            selectLocal: { try check(0) },
            prepareRuntime: { try check(1) },
            startGateway: { try check(2) })
        let expectedPages: [OnboardingFirstRun.Page] = [.connection, .runtime, .runtime]
        #expect(fallback == .init(page: expectedPages[failureStep], message: "Fixture setup failure"))
    }

    @Test func `cancelling runtime setup does not advance to AI selection`() async {
        let task = Task {
            var gatewayStarted = false
            let fallback = await OnboardingFirstRun.run(
                selectLocal: {},
                prepareRuntime: { withUnsafeCurrentTask { $0?.cancel() } },
                startGateway: { gatewayStarted = true })
            #expect(!gatewayStarted)
            #expect(fallback?.page == .runtime)
            #expect(fallback?.message != nil)
        }
        await task.value
    }
}
