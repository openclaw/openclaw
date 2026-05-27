import Foundation

enum CLIArgParsingSupport {
    static func nextValue(_ args: [String], index: inout Int) -> String? {
        guard index + 1 < args.count else { return nil }
        index += 1
        return args[index].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum CLISecretInputError: Error, CustomStringConvertible {
    case missingValue(String)
    case mutuallyExclusive(String)
    case unreadableFile(String)

    var description: String {
        switch self {
        case let .missingValue(flag):
            return "\(flag) requires a value"
        case let .mutuallyExclusive(name):
            return "only one \(name) input flag may be used"
        case let .unreadableFile(path):
            return "could not read secret file: \(path)"
        }
    }
}

enum CLISecretInput: Equatable {
    case inline(String)
    case stdin
    case file(String)
    case environment(String)

    func resolve() throws -> String? {
        switch self {
        case let .inline(value):
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        case .stdin:
            let data = FileHandle.standardInput.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        case let .file(path):
            do {
                let expandedPath = NSString(string: path).expandingTildeInPath
                return try String(contentsOfFile: expandedPath, encoding: .utf8)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            } catch {
                throw CLISecretInputError.unreadableFile(path)
            }
        case let .environment(name):
            return ProcessInfo.processInfo.environment[name]?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

struct CLISecretInputParser {
    private(set) var value: CLISecretInput?
    private let name: String

    init(name: String) {
        self.name = name
    }

    mutating func set(_ next: CLISecretInput) throws {
        if value != nil {
            throw CLISecretInputError.mutuallyExclusive(name)
        }
        value = next
    }

    mutating func parseInline(_ args: [String], index: inout Int, flag: String) throws {
        guard let raw = CLIArgParsingSupport.nextValue(args, index: &index) else {
            throw CLISecretInputError.missingValue(flag)
        }
        try set(.inline(raw))
    }

    mutating func parseFile(_ args: [String], index: inout Int, flag: String) throws {
        guard let path = CLIArgParsingSupport.nextValue(args, index: &index) else {
            throw CLISecretInputError.missingValue(flag)
        }
        try set(.file(path))
    }

    mutating func parseEnvironment(_ args: [String], index: inout Int, flag: String) throws {
        guard let name = CLIArgParsingSupport.nextValue(args, index: &index) else {
            throw CLISecretInputError.missingValue(flag)
        }
        try set(.environment(name))
    }

    mutating func parseStdin() throws {
        try set(.stdin)
    }

    func resolve() throws -> String? {
        guard let value else { return nil }
        return try value.resolve()
    }
}