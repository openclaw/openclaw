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

    @Test func `first run marks completion only after the dashboard loads`() async {
        var effects: [String] = []
        let fallback = await OnboardingFirstRun.run(
            selectLocal: { effects.append("local") },
            prepareRuntime: { effects.append("runtime") },
            startGateway: { effects.append("start") },
            supportsAutomaticSetup: { effects.append("capability")
                return true
            },
            openDashboard: {
                #expect(!effects.contains("complete"))
                effects.append("dashboard loaded")
            },
            markComplete: { effects.append("complete") })
        #expect(fallback == nil)
        #expect(effects == ["local", "runtime", "start", "capability", "dashboard loaded", "complete"])
    }

    @Test(arguments: 0..<5)
    func `failures preserve unfinished onboarding and return to the relevant manual page`(failureStep: Int) async {
        struct Failure: LocalizedError {
            var errorDescription: String? {
                "Fixture setup failure"
            }
        }
        var completed = false
        var dashboardOpened = false
        let check: (Int) throws -> Void = { step in
            if step == failureStep { throw Failure() }
        }
        let fallback = await OnboardingFirstRun.run(
            selectLocal: { try check(0) },
            prepareRuntime: { try check(1) },
            startGateway: { try check(2) },
            supportsAutomaticSetup: { try check(3)
                return true
            },
            openDashboard: { try check(4)
                dashboardOpened = true
            },
            markComplete: { completed = true })
        #expect(!completed)
        #expect(!dashboardOpened)
        let expectedPages: [OnboardingFirstRun.Page] = [.connection, .runtime, .runtime, .connection, .aiSetup]
        #expect(fallback == .init(page: expectedPages[failureStep], message: "Fixture setup failure"))
    }

    @Test func `opening manual setup cancels the automatic handoff before completion`() async {
        let task = Task {
            var completed = false
            let fallback = await OnboardingFirstRun.run(
                selectLocal: {}, prepareRuntime: {}, startGateway: {},
                supportsAutomaticSetup: { true },
                openDashboard: { withUnsafeCurrentTask { $0?.cancel() } },
                markComplete: { completed = true })
            #expect(!completed)
            #expect(fallback?.page == .aiSetup)
        }
        await task.value
    }

    @Test func `older Gateways retain manual AI setup without a dashboard handoff`() async {
        var handoff = false
        var completed = false
        let fallback = await OnboardingFirstRun.run(
            selectLocal: {}, prepareRuntime: {}, startGateway: {},
            supportsAutomaticSetup: { false },
            openDashboard: { handoff = true },
            markComplete: { completed = true })
        #expect(fallback == .init(page: .aiSetup, message: nil))
        #expect(!handoff)
        #expect(!completed)
    }
}
