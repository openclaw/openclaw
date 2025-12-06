import Commander
import Foundation

@MainActor
private func runCLI() async -> Int32 {
    do {
        let descriptors = CLIRegistry.descriptors
        let program = Program(descriptors: descriptors)
        let invocation = try program.resolve(argv: CommandLine.arguments)
        try await dispatch(invocation: invocation)
        return 0
    } catch {
        fputs("error: \(error)\n", stderr)
        return 1
    }
}

@MainActor
private func dispatch(invocation: CommandInvocation) async throws {
    let parsed = invocation.parsedValues
    let path = invocation.path
    guard let first = path.first else { throw CommanderProgramError.missingCommand }

    switch first {
    case "swabble":
        guard path.count >= 2 else { throw CommanderProgramError.missingSubcommand(command: "swabble") }
        let sub = path[1]
        switch sub {
        case "serve":
            var cmd = ServeCommand(parsed: parsed)
            try await cmd.run()
        case "transcribe":
            var cmd = TranscribeCommand(parsed: parsed)
            try await cmd.run()
        case "test-hook":
            var cmd = TestHookCommand(parsed: parsed)
            try await cmd.run()
        case "mic":
            guard path.count >= 3 else { throw CommanderProgramError.missingSubcommand(command: "mic") }
            let micSub = path[2]
            if micSub == "list" {
                var cmd = MicList(parsed: parsed)
                try await cmd.run()
            } else if micSub == "set" {
                var cmd = MicSet(parsed: parsed)
                try await cmd.run()
            } else {
                throw CommanderProgramError.unknownSubcommand(command: "mic", name: micSub)
            }
        case "service":
            guard path.count >= 3 else { throw CommanderProgramError.missingSubcommand(command: "service") }
            let svcSub = path[2]
            switch svcSub {
            case "install":
                var cmd = ServiceInstall()
                try await cmd.run()
            case "uninstall":
                var cmd = ServiceUninstall()
                try await cmd.run()
            case "status":
                var cmd = ServiceStatus()
                try await cmd.run()
            default:
                throw CommanderProgramError.unknownSubcommand(command: "service", name: svcSub)
            }
        case "doctor":
            var cmd = DoctorCommand(parsed: parsed)
            try await cmd.run()
        case "setup":
            var cmd = SetupCommand(parsed: parsed)
            try await cmd.run()
        case "health":
            var cmd = HealthCommand(parsed: parsed)
            try await cmd.run()
        case "tail-log":
            var cmd = TailLogCommand(parsed: parsed)
            try await cmd.run()
        case "start":
            var cmd = StartCommand()
            try await cmd.run()
        case "stop":
            var cmd = StopCommand()
            try await cmd.run()
        case "restart":
            var cmd = RestartCommand()
            try await cmd.run()
        case "status":
            var cmd = StatusCommand()
            try await cmd.run()
        default:
            throw CommanderProgramError.unknownSubcommand(command: "swabble", name: sub)
        }
    default:
        throw CommanderProgramError.unknownCommand(first)
    }
}

let exitCode = await runCLI()
exit(exitCode)
