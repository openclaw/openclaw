import Foundation
import Testing
@testable import OpenClaw

struct ExecSystemRunCommandValidatorTests {
    @Test func rejectsPayloadOnlyRawForPositionalCarrierWrappers() {
        let command = ["/bin/sh", "-lc", #"$0 "$1""#, "/usr/bin/touch", "/tmp/marker"]
        let result = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: #"$0 "$1""#)
        switch result {
        case .ok:
            Issue.record("expected rawCommand mismatch")
        case .invalid(let message):
            #expect(message.contains("rawCommand does not match command"))
        }
    }

    @Test func acceptsCanonicalDisplayForPositionalCarrierWrappers() {
        let command = ["/bin/sh", "-lc", #"$0 "$1""#, "/usr/bin/touch", "/tmp/marker"]
        let expected = ExecCommandFormatter.displayString(for: command)
        let result = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: expected)
        switch result {
        case .ok(let resolved):
            #expect(resolved.displayCommand == expected)
        case .invalid(let message):
            Issue.record("unexpected validation failure: \(message)")
        }
    }

    @Test func acceptsShellPayloadRawForTransparentEnvWrapper() {
        let command = ["/usr/bin/env", "bash", "-lc", "echo hi"]
        let result = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: "echo hi")
        switch result {
        case .ok(let resolved):
            #expect(resolved.displayCommand == "echo hi")
        case .invalid(let message):
            Issue.record("unexpected validation failure: \(message)")
        }
    }

    @Test func rejectsShellPayloadRawForEnvModifierPrelude() {
        let command = ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo hi"]
        let result = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: "echo hi")
        switch result {
        case .ok:
            Issue.record("expected rawCommand mismatch")
        case .invalid(let message):
            #expect(message.contains("rawCommand does not match command"))
        }
    }
}
