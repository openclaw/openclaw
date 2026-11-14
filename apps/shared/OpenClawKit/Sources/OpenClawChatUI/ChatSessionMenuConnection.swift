import Foundation
import OpenClawProtocol

@MainActor
public struct OpenClawSessionMenuConnection {
    public let hello: HelloOk
    private let methods: Set<String>
    private let scopes: Set<String>
    public let local: Bool
    public var groupDefaultsBrowser: OpenClawGroupDefaultsBrowser?
    public let selfProfileID: String?
    public let isCurrent: () -> Bool
    private let sendRequest: (OpenClawChatGatewayRequest) async throws -> Data
    public let link: (OpenClawChatSessionEntry, Bool) -> URL?
    public let openWindow: (OpenClawChatSessionEntry) -> Void

    public init(
        hello: HelloOk,
        local: Bool,
        selfProfileID: String? = nil,
        isCurrent: @escaping () -> Bool,
        request: @escaping (OpenClawChatGatewayRequest) async throws -> Data,
        link: @escaping (OpenClawChatSessionEntry, Bool) -> URL?,
        openWindow: @escaping (OpenClawChatSessionEntry) -> Void)
    {
        self.hello = hello
        self.methods = Set((hello.features["methods"]?.value as? [AnyCodable] ?? []).compactMap { $0.value as? String })
        self.scopes = Set((hello.auth["scopes"]?.value as? [AnyCodable] ?? []).compactMap { $0.value as? String })
        self.local = local
        self.selfProfileID = selfProfileID
        self.isCurrent = isCurrent
        self.sendRequest = request
        self.link = link
        self.openWindow = openWindow
    }

    public init(
        methods: Set<String>,
        scopes: Set<String>,
        isCurrent: @escaping () -> Bool,
        request: @escaping (OpenClawChatGatewayRequest) async throws -> Data)
    {
        self.hello = HelloOk(
            type: "hello-ok",
            _protocol: 3,
            server: [:],
            features: ["methods": AnyCodable(methods.sorted().map(AnyCodable.init))],
            snapshot: Snapshot(
                presence: [],
                health: [:],
                stateversion: StateVersion(presence: 0, health: 0),
                uptimems: 0),
            auth: ["scopes": AnyCodable(scopes.sorted().map(AnyCodable.init))],
            policy: [:])
        self.methods = methods
        self.scopes = scopes
        self.local = false
        self.selfProfileID = nil
        self.isCurrent = isCurrent
        self.sendRequest = request
        self.link = { _, _ in nil }
        self.openWindow = { _ in }
    }

    public func allows(_ method: String, scope: String = "operator.write") -> Bool {
        let broadRead = self.scopes.contains("operator.read") || self.scopes.contains("operator.write")
        let scopedRead = broadRead || self.scopes.contains("operator.sessions.write")
        return self.isCurrent() && self.methods.contains(method) &&
            (self.scopes.contains("operator.admin") || self.scopes.contains(scope) ||
                (scope == "operator.read" && broadRead) || (scope == "operator.sessions.read" && scopedRead))
    }

    public func read<T: Decodable>(
        _ method: String,
        _ params: [String: OpenClawProtocol.AnyCodable] = [:]) async throws -> T
    {
        try await JSONDecoder().decode(
            T.self,
            from: self.request(.init(method: method, params: params, timeoutMs: 15000)))
    }

    @discardableResult
    public func request(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        guard self.isCurrent(), !Task.isCancelled else { throw CancellationError() }
        let data = try await self.sendRequest(request)
        guard self.isCurrent(), !Task.isCancelled else { throw CancellationError() }
        return data
    }
}
