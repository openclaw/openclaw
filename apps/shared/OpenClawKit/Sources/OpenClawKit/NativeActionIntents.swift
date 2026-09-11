#if os(iOS) || os(macOS)
import AppIntents
import Foundation

public struct OpenClawNativeAppIntents: AppIntentsPackage {}

private enum NativeEntityIdentifier {
    static func validate(_ session: OpenClawNativeSessionRef) throws {
        guard !session.owner.gatewayID.isEmpty, !session.owner.profileID.isEmpty,
              !session.agentID.isEmpty, !session.sessionKey.isEmpty
        else {
            throw OpenClawNativeActionError("Select a connected account, agent, and session in OpenClaw.")
        }
    }

    static func encode(_ value: some Encodable) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value).base64EncodedString()
    }

    static func decode<Value: Decodable>(_ id: String, as _: Value.Type) throws -> Value {
        guard id.utf8.count <= 16384, let data = Data(base64Encoded: id) else {
            throw OpenClawNativeActionError("This saved selection is invalid. Select the session again.")
        }
        return try JSONDecoder().decode(Value.self, from: data)
    }
}

public struct OpenClawSessionEntity: AppEntity {
    public static let typeDisplayRepresentation: TypeDisplayRepresentation = "OpenClaw Session"
    public static let defaultQuery = OpenClawSessionQuery()
    public let id: String
    public let session: OpenClawNativeSessionRef
    public let title: String
    public let gatewayName: String

    public var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(self.title)",
            subtitle: "\(self.gatewayName) / \(self.session.agentID)",
            image: .init(systemName: "bubble.left.and.bubble.right"))
    }

    public init(session: OpenClawNativeSessionRef, title: String? = nil, gatewayName: String? = nil) throws {
        try NativeEntityIdentifier.validate(session)
        self.id = try NativeEntityIdentifier.encode(session)
        self.session = session
        self.title = String((title ?? session.sessionKey).prefix(120))
        self.gatewayName = String((gatewayName ?? session.owner.gatewayID).prefix(80))
    }
}

public struct OpenClawSessionQuery: EntityStringQuery {
    public init() {}

    public func entities(for identifiers: [String]) async throws -> [OpenClawSessionEntity] {
        try identifiers.prefix(50).map {
            try OpenClawSessionEntity(session: NativeEntityIdentifier.decode($0, as: OpenClawNativeSessionRef.self))
        }
    }

    public func suggestedEntities() async throws -> [OpenClawSessionEntity] {
        try await self.choices(matching: nil)
    }

    public func entities(matching string: String) async throws -> [OpenClawSessionEntity] {
        try await self.choices(matching: String(string.prefix(200)))
    }

    @MainActor
    private func choices(matching query: String?) async throws -> [OpenClawSessionEntity] {
        guard let catalog = OpenClawNativeActionServices.catalog else {
            throw OpenClawNativeActionError("Open OpenClaw to choose a connected session.")
        }
        return try await catalog.sessions(matching: query).prefix(50).map {
            try OpenClawSessionEntity(session: $0.session, title: $0.title, gatewayName: $0.gatewayName)
        }
    }
}

public struct OpenClawRunEntity: AppEntity {
    public static let typeDisplayRepresentation: TypeDisplayRepresentation = "OpenClaw Run"
    public static let defaultQuery = OpenClawRunQuery()
    public let id: String
    public let run: OpenClawNativeRunRef

    public var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(self.run.runID)",
            subtitle: "\(self.run.session.agentID) / \(self.run.session.sessionKey)",
            image: .init(systemName: "clock"))
    }

    public init(run: OpenClawNativeRunRef) throws {
        try NativeEntityIdentifier.validate(run.session)
        guard !run.runID.isEmpty else {
            throw OpenClawNativeActionError("Select a run in OpenClaw.")
        }
        self.id = try NativeEntityIdentifier.encode(run)
        self.run = run
    }
}

public struct OpenClawRunQuery: EntityStringQuery {
    public init() {}

    public func entities(for identifiers: [String]) async throws -> [OpenClawRunEntity] {
        try identifiers.prefix(50).map {
            try OpenClawRunEntity(run: NativeEntityIdentifier.decode($0, as: OpenClawNativeRunRef.self))
        }
    }

    public func suggestedEntities() async throws -> [OpenClawRunEntity] {
        try await self.choices(matching: nil)
    }

    public func entities(matching string: String) async throws -> [OpenClawRunEntity] {
        try await self.choices(matching: String(string.prefix(200)))
    }

    @MainActor
    private func choices(matching query: String?) async throws -> [OpenClawRunEntity] {
        guard let catalog = OpenClawNativeActionServices.catalog else {
            throw OpenClawNativeActionError("Open OpenClaw to choose a run.")
        }
        return try await catalog.runs(matching: query).prefix(50).map { try OpenClawRunEntity(run: $0) }
    }
}

public enum OpenClawNativeSessionOperation: String, AppEnum {
    case open
    case compose

    public static let typeDisplayRepresentation: TypeDisplayRepresentation = "Session Operation"
    public static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .open: "Open",
        .compose: "Compose",
    ]
}

/// App Intents metadata permits one OpenIntent per entity; session variants
/// share this declaration while named Shortcuts delegate to its perform method.
public struct OpenSessionIntent: OpenIntent {
    public static let title: LocalizedStringResource = "Open Session"
    public static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Session") public var target: OpenClawSessionEntity
    @Parameter(title: "Operation", default: .open) public var operation: OpenClawNativeSessionOperation?
    @Parameter(title: "Draft") public var draft: String?
    public static var parameterSummary: some ParameterSummary {
        Summary("\(\.$operation) \(\.$target)") { \.$draft }
    }

    public init() {
        self.operation = .open
    }

    public init(
        target: OpenClawSessionEntity,
        operation: OpenClawNativeSessionOperation = .open,
        draft: String? = nil)
    {
        self.target = target
        self.operation = operation
        self.draft = draft
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        let request: OpenClawNativeOpenRequest = switch self.operation ?? .open {
        case .open: .session(self.target.session)
        case .compose: .compose(self.target.session, draft: self.draft)
        }
        try await OpenClawNativeActionServices.open(request)
        return .result()
    }
}

public struct OpenComposeIntent: AppIntent {
    public static let title: LocalizedStringResource = "Compose Message"
    public static let openAppWhenRun = true
    @available(iOS 26.0, macOS 26.0, *)
    public static var supportedModes: IntentModes {
        .foreground(.immediate)
    }

    public static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Session") public var target: OpenClawSessionEntity
    @Parameter(title: "Draft") public var draft: String?
    public static var parameterSummary: some ParameterSummary {
        Summary("Compose in \(\.$target)") { \.$draft }
    }

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        try await OpenSessionIntent(target: self.target, operation: .compose, draft: self.draft).perform()
    }
}

struct OpenRunIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Run"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Run") var target: OpenClawRunEntity
    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$target)")
    }

    init() {}
    init(target: OpenClawRunEntity) {
        self.target = target
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        try await OpenClawNativeActionServices.open(.inspect(self.target.run))
        return .result()
    }
}

public struct SendMessageIntent: AppIntent {
    public static let title: LocalizedStringResource = "Send Message"
    public static let openAppWhenRun = true
    public static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Session") public var session: OpenClawSessionEntity
    @Parameter(title: "Message") public var message: String
    public static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$message) to \(\.$session)")
    }

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult & ReturnsValue<OpenClawRunEntity> & ProvidesDialog &
    OpensIntent {
        // perform has no OS invocation identifier. Each intentional execution
        // prepares one object; static intent identifiers must never deduplicate sends.
        let prepared = try await OpenClawNativeActionServices.host().prepareSend(
            to: self.session.session, message: self.message)
        try await self.requestConfirmation(
            actionName: .send,
            dialog: """
            Send to \(prepared.session.sessionKey) with \(prepared.session.agentID) \
            as \(prepared.session.owner.profileID) on \(prepared.session.owner.gatewayID)?
            """)
        let run = try await prepared.submit()
        return try .result(
            value: OpenClawRunEntity(run: run),
            opensIntent: OpenRunIntent(target: OpenClawRunEntity(run: run)),
            dialog: "Accepted. Open the selected chat to follow the run.")
    }
}

public struct InspectRunIntent: AppIntent {
    public static let title: LocalizedStringResource = "Inspect Run"
    public static let openAppWhenRun = true
    public static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Run") public var run: OpenClawRunEntity
    public static var parameterSummary: some ParameterSummary {
        Summary("Inspect \(\.$run)")
    }

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog & OpensIntent {
        let inspection = try await OpenClawNativeActionServices.host().inspect(self.run.run)
        return try .result(
            value: inspection.summary,
            opensIntent: OpenRunIntent(target: OpenClawRunEntity(run: inspection.run)),
            dialog: "\(inspection.summary)")
    }
}
#endif
