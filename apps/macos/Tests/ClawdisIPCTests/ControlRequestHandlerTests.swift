import ClawdisIPC
import Foundation
import Testing
@testable import Clawdis

@Suite(.serialized)
struct ControlRequestHandlerTests {
    @Test
    func statusReturnsReadyWhenNotPaused() async throws {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: pauseDefaultsKey)
        defaults.set(false, forKey: pauseDefaultsKey)
        defer {
            if let previous {
                defaults.set(previous, forKey: pauseDefaultsKey)
            } else {
                defaults.removeObject(forKey: pauseDefaultsKey)
            }
        }

        let res = try await ControlRequestHandler.process(request: .status)
        #expect(res.ok == true)
        #expect(res.message == "ready")
    }

    @Test
    func statusReturnsPausedWhenPaused() async throws {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: pauseDefaultsKey)
        defaults.set(true, forKey: pauseDefaultsKey)
        defer {
            if let previous {
                defaults.set(previous, forKey: pauseDefaultsKey)
            } else {
                defaults.removeObject(forKey: pauseDefaultsKey)
            }
        }

        let res = try await ControlRequestHandler.process(request: .status)
        #expect(res.ok == false)
        #expect(res.message == "clawdis paused")
    }

    @Test
    func nonStatusRequestsShortCircuitWhenPaused() async throws {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: pauseDefaultsKey)
        defaults.set(true, forKey: pauseDefaultsKey)
        defer {
            if let previous {
                defaults.set(previous, forKey: pauseDefaultsKey)
            } else {
                defaults.removeObject(forKey: pauseDefaultsKey)
            }
        }

        let res = try await ControlRequestHandler.process(request: .rpcStatus)
        #expect(res.ok == false)
        #expect(res.message == "clawdis paused")
    }
}

