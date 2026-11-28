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

    private static var root: Entry {
        .group("swabble", "Speech hook daemon", self.entries)
    }

    private static func entry(at path: ArraySlice<String>) -> Entry? {
        var entry = self.root
        for name in path {
            guard case let .group(_, _, children) = entry,
                  let next = children.first(where: { $0.name == name }) else { return nil }
            entry = next
        }
        return entry
    }

    static var descriptors: [CommandDescriptor] {
        let root = self.root.descriptor
        return [CommandDescriptor(
            name: root.name,
            abstract: root.abstract,
            discussion: "Local wake-word → SpeechTranscriber → hook",
            signature: root.signature.withStandardRuntimeFlags(),
            subcommands: root.subcommands)]
    }

    static func help(for arguments: ArraySlice<String>) -> String? {
        guard let flag = arguments.last, flag == "--help" || flag == "-h",
              let entry = self.entry(at: arguments.dropLast()) else { return nil }
        let usage = ([self.root.name] + arguments.dropLast()).joined(separator: " ")
        let type: any CLICommand.Type
        switch entry {
        case let .group(_, abstract, children):
            let commands = children.map { "  \($0.name)  \($0.descriptor.abstract)" }
            return (["Usage: \(usage) <command>", abstract, "", "Commands:"] + commands +
                ["", "Use \(usage) <command> --help for command details."]).joined(separator: "\n")
        case let .command(command): type = command
        }
        // Show the options each command consumes, not the parser's unused runtime flags.
        let signature = CommandSignature.describe(type.init()).flattened()
        let positional = signature.arguments.map { $0.isOptional ? "[\($0.label)]" : "<\($0.label)>" }
        var lines = [
            "Usage: " + ([usage] + positional + ["[options]"]).joined(separator: " "),
            type.commandDescription.abstract,
        ]
        if !signature.arguments.isEmpty {
            lines += ["", "Arguments:"] + signature.arguments.map { "  \($0.label)  \($0.help ?? "")" }
        }
        func spellings(_ names: [CommanderName]) -> String {
            names.compactMap { name -> String? in
                switch name {
                case let .long(value): "--\(value)"
                case let .short(value): "-\(value)"
                case .aliasLong, .aliasShort: nil
                }
            }.joined(separator: ", ")
        }
        lines += ["", "Options:"] + signature.options.map { "  \(spellings($0.names)) <value>  \($0.help ?? "")" }
        lines += signature.flags.map { "  \(spellings($0.names))  \($0.help ?? "")" }
        lines.append("  -h, --help  Show command help")
        return lines.joined(separator: "\n")
    }

    static func run(parsed: ParsedValues, path: [String]) async throws {
        guard case let .command(type) = self.entry(at: path.dropFirst()) else {
            throw CommanderProgramError.missingSubcommand(command: path.joined(separator: " "))
        }
        var command = type.init(parsed: parsed)
        try await command.run()
    }
}
