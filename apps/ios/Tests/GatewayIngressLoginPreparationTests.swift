import Foundation
import Testing
@testable import OpenClaw

struct GatewayIngressLoginPreparationTests {
    @Test(arguments: [false, true]) @MainActor
    func `website preparation cannot admit a session or start a canceled transfer`(cancel: Bool) async throws {
        let fixture = try IngressTestHarness()
        let gate = IngressTestGate()
        fixture.browser.preparationGate = gate
        let ingress = fixture.controller()
        let admission = Task {
            try await ingress.prepare(
                route: fixture.route,
                userInitiated: true,
                admissionCheckpoint: ingress.admissionCheckpoint())
        }
        defer {
            gate.release()
            fixture.release.continuation.finish()
            admission.cancel()
        }
        await gate.waitUntilStarted()
        #expect(fixture.browser.prepared.count == 1)
        #expect(fixture.browser.presented.isEmpty)
        #expect(fixture.persisted == nil)
        if cancel { fixture.browser.cancel?() }
        gate.release()
        if cancel {
            await #expect(throws: CancellationError.self) { try await admission.value }
            #expect(fixture.browser.presented.isEmpty)
            #expect(fixture.persisted == nil)
        } else {
            try await waitForIngress { fixture.browser.presented.count == 1 }
            #expect(fixture.browser.prepared == fixture.browser.presented)
            #expect(fixture.persisted == nil)
            fixture.release.continuation.yield()
            let authorization = try #require(try await admission.value)
            #expect(authorization.isCurrent())
            #expect(fixture.persisted != nil)
        }
    }
}
