import ClawdisIPC
import Foundation
import Testing
@testable import Clawdis

@Suite(.serialized)
struct ControlRequestHandlerTests {
    private static func withDefaultOverride<T>(
        _ key: String,
        value: Any?,
        operation: () async throws -> T) async rethrows -> T
    {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: key)
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
        return try await operation()
    }

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

    @Test
    func agentRejectsEmptyMessage() async throws {
        let res = try await Self.withDefaultOverride(pauseDefaultsKey, value: false) {
            try await ControlRequestHandler.process(request: .agent(
                message: "   ",
                thinking: nil,
                session: nil,
                deliver: false,
                to: nil))
        }
        #expect(res.ok == false)
        #expect(res.message == "message empty")
    }

    @Test
    func runShellEchoReturnsPayload() async throws {
        let res = try await Self.withDefaultOverride(pauseDefaultsKey, value: false) {
            try await ControlRequestHandler.process(request: .runShell(
                command: ["echo", "hello"],
                cwd: nil,
                env: nil,
                timeoutSec: nil,
                needsScreenRecording: false))
        }
        #expect(res.ok == true)
        #expect(String(data: res.payload ?? Data(), encoding: .utf8) == "hello\n")
    }

    @Test
    func cameraRequestsReturnDisabledWhenCameraDisabled() async throws {
        let snap = try await Self.withDefaultOverride(pauseDefaultsKey, value: false) {
            try await Self.withDefaultOverride(cameraEnabledKey, value: false) {
                try await ControlRequestHandler.process(request: .cameraSnap(
                    facing: nil,
                    maxWidth: nil,
                    quality: nil,
                    outPath: nil))
            }
        }
        #expect(snap.ok == false)
        #expect(snap.message == "Camera disabled by user")

        let clip = try await Self.withDefaultOverride(pauseDefaultsKey, value: false) {
            try await Self.withDefaultOverride(cameraEnabledKey, value: false) {
                try await ControlRequestHandler.process(request: .cameraClip(
                    facing: nil,
                    durationMs: nil,
                    includeAudio: true,
                    outPath: nil))
            }
        }
        #expect(clip.ok == false)
        #expect(clip.message == "Camera disabled by user")
    }

    @Test
    func canvasRequestsReturnDisabledWhenCanvasDisabled() async throws {
        let show = try await Self.withDefaultOverride(pauseDefaultsKey, value: false) {
            try await Self.withDefaultOverride(canvasEnabledKey, value: false) {
                try await ControlRequestHandler.process(request: .canvasShow(session: "s", path: nil, placement: nil))
            }
        }
        #expect(show.ok == false)
        #expect(show.message == "Canvas disabled by user")

        let eval = try await Self.withDefaultOverride(pauseDefaultsKey, value: false) {
            try await Self.withDefaultOverride(canvasEnabledKey, value: false) {
                try await ControlRequestHandler.process(request: .canvasEval(session: "s", javaScript: "1+1"))
            }
        }
        #expect(eval.ok == false)
        #expect(eval.message == "Canvas disabled by user")

        let snap = try await Self.withDefaultOverride(pauseDefaultsKey, value: false) {
            try await Self.withDefaultOverride(canvasEnabledKey, value: false) {
                try await ControlRequestHandler.process(request: .canvasSnapshot(session: "s", outPath: nil))
            }
        }
        #expect(snap.ok == false)
        #expect(snap.message == "Canvas disabled by user")

        let a2ui = try await Self.withDefaultOverride(pauseDefaultsKey, value: false) {
            try await Self.withDefaultOverride(canvasEnabledKey, value: false) {
                try await ControlRequestHandler.process(request: .canvasA2UI(session: "s", command: .reset, jsonl: nil))
            }
        }
        #expect(a2ui.ok == false)
        #expect(a2ui.message == "Canvas disabled by user")
    }
}
