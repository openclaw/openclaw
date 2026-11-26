import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingOpenClawIDTests {
    @Test func `main build cannot claim an unbacked enrollment succeeded`() {
        let model = OnboardingOpenClawIDModel(service: UnavailableOnboardingOpenClawIDService())
        #expect(model.unavailableReason != nil)
        #expect(model.begin(.makeReachable) == nil)
        #expect(model.perform(.confirmRecoveryKit) == nil)
        #expect(model.step == .signIn)
        #expect(!model.busy)
    }

    @Test func `node approval stays separate from chat and a failed chat step preserves node approval`() async {
        let service = FixtureService()
        service.next = .chatAccess(claw: "fixture-claw", approvalURL: nil)
        let model = OnboardingOpenClawIDModel(service: service)
        await model.begin(.connect)?.value
        #expect(model.step == .chatAccess(claw: "fixture-claw", approvalURL: nil))
        service.fail = true
        await model.perform(.requestChat)?.value
        #expect(model.step == .chatAccess(claw: "fixture-claw", approvalURL: nil))
        #expect(model.error != nil)
        #expect(model.error?.contains("fixture-private-response") == false)
        #expect(!model.busy)
    }

    @Test func `cancelled enrollment cannot publish late success`() async {
        let service = FixtureService()
        service.suspend = true
        let model = OnboardingOpenClawIDModel(service: service)
        let task = model.begin(.connect)
        await service.waitUntilStarted()
        model.cancel()
        service.pending?.resume(returning: .connected(claw: "fixture-claw"))
        await task?.value
        #expect(model.step == .signIn)
        #expect(!model.busy)
        #expect(model.error == nil)
    }
}

@MainActor
private final class FixtureService: OnboardingOpenClawIDService {
    let unavailableReason: String? = nil
    var next: OnboardingOpenClawIDStep = .signIn
    var fail = false
    var suspend = false
    var pending: CheckedContinuation<OnboardingOpenClawIDStep, Never>?
    private var started: CheckedContinuation<Void, Never>?

    func waitUntilStarted() async {
        if self.pending != nil { return }
        await withCheckedContinuation { self.started = $0 }
    }

    func start(_: OnboardingOpenClawIDIntent) async throws -> OnboardingOpenClawIDStep {
        if self.suspend {
            return await withCheckedContinuation {
                self.pending = $0
                self.started?.resume()
            }
        }
        return self.next
    }

    func perform(_: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
        if self.fail { throw NSError(domain: "fixture-private-response", code: 1) }
        return self.next
    }

    func cancel() {}
}
