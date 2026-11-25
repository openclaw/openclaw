import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingOpenClawIDTests {
    @Test func `main build cannot claim an unbacked enrollment succeeded`() {
        let model = OpenClawIDSetupModel(service: UnavailableOpenClawIDSetupService(), onJoined: { _ in })
        #expect(model.unavailableReason != nil)
        #expect(model.begin(.makeReachable) == nil)
        #expect(model.perform(.confirmRecoveryKit) == nil)
        #expect(model.step == .signIn)
        #expect(!model.busy)
    }

    @Test func `node approval stays separate from chat and a failed chat step preserves node approval`() async {
        let service = FixtureService()
        service.next = .chatAccess(claw: "fixture-claw", approvalURL: nil)
        let model = OpenClawIDSetupModel(service: service, onJoined: { _ in })
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
        let model = OpenClawIDSetupModel(service: service, onJoined: { _ in })
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
private final class FixtureService: OpenClawIDSetupService {
    let unavailableReason: String? = nil
    var next: OpenClawIDSetupStep = .signIn
    var fail = false
    var suspend = false
    var pending: CheckedContinuation<OpenClawIDSetupStep, Never>?
    private var started: CheckedContinuation<Void, Never>?

    func waitUntilStarted() async {
        if self.pending != nil { return }
        await withCheckedContinuation { self.started = $0 }
    }

    func start(_: OpenClawIDSetupIntent) async throws -> OpenClawIDSetupStep {
        if self.suspend {
            return await withCheckedContinuation {
                self.pending = $0
                self.started?.resume()
            }
        }
        return self.next
    }

    func perform(_: OpenClawIDSetupAction) async throws -> OpenClawIDSetupStep {
        if self.fail { throw NSError(domain: "fixture-private-response", code: 1) }
        return self.next
    }

    func cancel() {}
}
