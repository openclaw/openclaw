import Commander
import Foundation

@MainActor
protocol CLICommand: ParsableCommand {
    init(parsed: ParsedValues)
}

extension CLICommand {
    init(parsed _: ParsedValues) {
        self.init()
    }
}

@available(macOS 26.0, *)
@MainActor
enum CLIRegistry {
    @MainActor
    private enum Entry {
        case command(any CLICommand.Type)
        case group(String, String, [Entry])

        var name: String {
            switch self {
            case let .command(type): type.commandDescription.commandName ?? ""
            case let .group(name, _, _): name
            }
        }

        var descriptor: CommandDescriptor {
            switch self {
            case let .command(type):
                CommandDescriptor(
                    name: self.name,
                    abstract: type.commandDescription.abstract,
                    discussion: type.commandDescription.discussion,
                    signature: CommandSignature.describe(type.init()).withStandardRuntimeFlags())
            case let .group(name, abstract, children):
                CommandDescriptor(
                    name: name,
                    abstract: abstract,
                    discussion: nil,
                    signature: CommandSignature(),
                    subcommands: children.map(\.descriptor))
            }
        }
    }

    private static var entries: [Entry] {
        [
            .command(ServeCommand.self),
            .command(TranscribeCommand.self),
            .command(TestHookCommand.self),
            .group("mic", "Microphone management", [.command(MicList.self), .command(MicSet.self)]),
            .group("service", "launchd helper", [
                .command(ServiceInstall.self),
                .command(ServiceUninstall.self),
                .command(ServiceStatus.self),
            ]),
            .command(DoctorCommand.self),
            .command(SetupCommand.self),
            .command(HealthCommand.self),
            .command(TailLogCommand.self),
            .command(StartCommand.self),
            .command(StopCommand.self),
            .command(RestartCommand.self),
            .command(StatusCommand.self),
        ]
    }

    static var descriptors: [CommandDescriptor] {
        [CommandDescriptor(
            name: "swabble",
            abstract: "Speech hook daemon",
            discussion: "Local wake-word → SpeechTranscriber → hook",
            signature: CommandSignature().withStandardRuntimeFlags(),
            subcommands: self.entries.map(\.descriptor))]
    }

    static func run(parsed: ParsedValues, path: [String]) async throws {
        let type = try self.resolve(path.dropFirst(), entries: self.entries, parent: "swabble")
        var command = type.init(parsed: parsed)
        try await command.run()
    }

    private static func resolve(
        _ path: ArraySlice<String>,
        entries: [Entry],
        parent: String) throws -> any CLICommand.Type
    {
        guard let name = path.first else {
            throw CommanderProgramError.missingSubcommand(command: parent)
        }
        guard let entry = entries.first(where: { $0.name == name }) else {
            throw CommanderProgramError.unknownSubcommand(command: parent, name: name)
        }
        switch entry {
        case let .command(type):
            return type
        case let .group(name, _, children):
            return try self.resolve(path.dropFirst(), entries: children, parent: name)
        }
    }
}
