import Foundation

public struct OpenClawNativeActionError: LocalizedError, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? {
        self.message
    }
}

public struct OpenClawNativeSessionChoice: Sendable {
    public let session: OpenClawNativeSessionRef
    public let title: String
    public let gatewayName: String

    public init(session: OpenClawNativeSessionRef, title: String, gatewayName: String) {
        self.session = session
        self.title = String(title.prefix(120))
        self.gatewayName = String(gatewayName.prefix(80))
    }
}

public struct OpenClawNativeRunInspection: Equatable, Sendable {
    public enum Association: String, Sendable {
        case observed, notObserved
    }

    public enum Activity: String, Sendable {
        case active, unknown
    }

    public enum Outcome: String, Sendable {
        case done, failed, killed, timeout
    }

    public let run: OpenClawNativeRunRef
    public let association: Association
    public let activity: Activity
    public let outcome: Outcome?
    public let reply: String?
    public let error: String?

    public init(
        run: OpenClawNativeRunRef,
        association: Association,
        activity: Activity,
        outcome: Outcome?,
        reply: String?,
        error: String?)
    {
        self.run = run
        self.association = association
        self.activity = activity
        self.outcome = outcome
        self.reply = reply.map { String($0.prefix(2000)) }
        self.error = error.map { String($0.prefix(500)) }
    }

    public var summary: String {
        let status = if let outcome {
            switch outcome {
            case .done: "Completed."
            case .failed: "Failed."
            case .killed: "Cancelled."
            case .timeout: "Timed out."
            }
        } else if self.activity == .active {
            "Active."
        } else if self.association == .observed {
            "Input observed. Current run status is unknown."
        } else {
            "Not observed in this bounded history read. Do not resend without checking the chat."
        }
        return [status, self.error, self.reply].compactMap(\.self).joined(separator: "\n")
    }
}

public struct OpenClawNativeRunReply: Equatable, Sendable {
    public enum Outcome: Equatable, Sendable {
        case answer(String)
        case silent
        case empty
        case pending
        case failed(String)
        case unavailable
    }

    public let run: OpenClawNativeRunRef
    public let outcome: Outcome

    public init(run: OpenClawNativeRunRef, outcome: Outcome) {
        self.run = run
        self.outcome = outcome
    }

    public var text: String {
        switch self.outcome {
        case let .answer(text): text
        case .silent: "The run completed with an intentional silent response."
        case .empty: "The run completed without a recorded text reply. Open its chat for details."
        case .pending: "No completed reply yet. Open the accepted run's chat to follow it."
        case let .failed(message): "The run failed: \(String(message.prefix(500))). Open its chat for details."
        case .unavailable: "The message was accepted, but its reply is unavailable. Open its chat before sending again."
        }
    }

    public var dialog: String {
        let text = self.text
        return text.count > 800 ? "\(text.prefix(800))… Open the chat for the rest." : text
    }
}

/// Prepared by the app before system confirmation. The closure retains one
/// invocation object and one physical connection; it must not reacquire either.
@MainActor
public struct OpenClawNativePreparedSend {
    public let session: OpenClawNativeSessionRef
    public let message: String
    public let submit: @MainActor () async throws -> OpenClawNativeRunRef
    public let submitAndWaitForReply: @MainActor () async throws -> OpenClawNativeRunReply

    public init(
        session: OpenClawNativeSessionRef,
        message: String,
        submit: @escaping @MainActor () async throws -> OpenClawNativeRunRef,
        submitAndWaitForReply: @escaping @MainActor () async throws -> OpenClawNativeRunReply)
    {
        self.session = session
        self.message = message
        self.submit = submit
        self.submitAndWaitForReply = submitAndWaitForReply
    }
}

/// Extensions can supply their bounded, nonsecret catalog without installing a
/// sender. All actions still execute in the app through its authenticated host.
@MainActor
public protocol OpenClawNativeActionCatalog {
    func sessions(matching query: String?) async throws -> [OpenClawNativeSessionChoice]
    func runs(matching query: String?) async throws -> [OpenClawNativeRunRef]
}

@MainActor
public protocol OpenClawNativeActionHost: OpenClawNativeActionCatalog, OpenClawNativeActionOpenRouter {
    func prepareSend(
        to session: OpenClawNativeSessionRef,
        message: String) async throws -> (send: OpenClawNativePreparedSend, presentationContinuationID: UUID)
    func inspect(_ run: OpenClawNativeRunRef) async throws
        -> (inspection: OpenClawNativeRunInspection, presentationContinuationID: UUID)
    func openRun(_ run: OpenClawNativeRunRef, continuing id: UUID) async throws -> OpenClawNativeRunOpenOutcome
}

public enum OpenClawNativeRunOpenOutcome: Equatable, Sendable {
    case opened
    case skipped
}

@MainActor
public enum OpenClawNativeActionServices {
    public static var catalog: (any OpenClawNativeActionCatalog)?
    private static var installedHost: (any OpenClawNativeActionHost)?

    public static func install(host: any OpenClawNativeActionHost) {
        self.installedHost = host
        self.catalog = host
    }

    public static func host() throws -> any OpenClawNativeActionHost {
        guard let installedHost else {
            throw OpenClawNativeActionError("Open OpenClaw and connect your Gateway, then try this action again.")
        }
        return installedHost
    }

    public static func open(_ request: OpenClawNativeOpenRequest) async throws {
        switch try await (self.host()).open(request) {
        case .opened:
            return
        case .cancelled:
            throw CancellationError()
        case let .unavailable(reason):
            throw OpenClawNativeActionError(reason)
        }
    }
}
