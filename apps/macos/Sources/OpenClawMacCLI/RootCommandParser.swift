struct RootCommand: Equatable {
    var name: String
    var args: [String]
}

enum RootCommandAction: Equatable {
    case usage
    case connect([String])
    case configureRemote([String])
    case discover([String])
    case wizard([String])
    case unknown(exitCode: Int32)
}

func parseRootCommand(_ args: [String]) -> RootCommand? {
    guard let first = args.first else { return nil }
    return RootCommand(name: first, args: Array(args.dropFirst()))
}

func rootCommandAction(for args: [String]) -> RootCommandAction {
    let command = parseRootCommand(args)
    switch command?.name {
    case nil, "-h", "--help", "help":
        return .usage
    case "connect":
        return .connect(command?.args ?? [])
    case "configure-remote":
        return .configureRemote(command?.args ?? [])
    case "discover":
        return .discover(command?.args ?? [])
    case "wizard":
        return .wizard(command?.args ?? [])
    default:
        return .unknown(exitCode: 1)
    }
}
