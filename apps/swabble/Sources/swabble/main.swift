import Commander
import Foundation

@available(macOS 26.0, *)
@MainActor
private func runCLI() async -> Int32 {
    do {
        let arguments = CommandLine.arguments.dropFirst()
        if let help = CLIRegistry.help(for: arguments) {
            print(help)
            return 0
        }
        let program = Program(descriptors: CLIRegistry.descriptors)
        let invocation = try program.resolve(arguments: ["swabble"] + arguments)
        try await CLIRegistry.run(parsed: invocation.parsedValues, path: invocation.path)
        return 0
    } catch {
        fputs("error: \(error)\n", stderr)
        return 1
    }
}

if #available(macOS 26.0, *) {
    let exitCode = await runCLI()
    exit(exitCode)
} else {
    fputs("error: swabble requires macOS 26 or newer\n", stderr)
    exit(1)
}
