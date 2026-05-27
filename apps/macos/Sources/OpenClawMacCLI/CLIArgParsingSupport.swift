import Foundation

enum CLIArgParsingSupport {
    static func nextValue(_ args: [String], index: inout Int) -> String? {
        guard index + 1 < args.count else { return nil }
        index += 1
        return args[index].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum CLISecretInputError: Error, CustomStringConvertible, LocalizedError, Equatable {
    case missingValue(String)
    case mutuallyExclusive(String)
    case emptyValue(String)
    case missingEnvironment(String)
    case unreadableFile(String)

    var description: String {
        switch self {
        case let .missingValue(flag):
            return "\(flag) requires a value"
        case let .mutuallyExclusive(name):
            return "only one \(name) input flag may be used"
        case let .emptyValue(source):
            return "\(source) did not provide a non-empty secret"
        case let .missingEnvironment(name):
            return "environment variable \(name) is not set"
        case let .unreadableFile(path):
            return "could not read secret file: \(path)"
        }
    }

    var errorDescription: String? { description }
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
            guard let value = String(data: data, encoding: .utf8) else {
                throw CLISecretInputError.emptyValue("--password-stdin")
            }
            return try nonEmptySecret(value, source: "--password-stdin")
        case let .file(path):
            let trimmedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedPath.isEmpty else {
                throw CLISecretInputError.missingValue("--password-file")
            }
            do {
                let expandedPath = NSString(string: trimmedPath).expandingTildeInPath
                let value = try String(contentsOfFile: expandedPath, encoding: .utf8)
                return try nonEmptySecret(value, source: "--password-file")
            } catch let error as CLISecretInputError {
                throw error
            } catch {
                throw CLISecretInputError.unreadableFile(trimmedPath)
            }
        case let .environment(name):
            let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedName.isEmpty else {
                throw CLISecretInputError.missingValue("--password-env")
            }
            guard let value = ProcessInfo.processInfo.environment[trimmedName] else {
                throw CLISecretInputError.missingEnvironment(trimmedName)
            }
            return try nonEmptySecret(value, source: "--password-env \(trimmedName)")
        }
    }

    private func nonEmptySecret(_ value: String, source: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw CLISecretInputError.emptyValue(source)
        }
        return trimmed
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