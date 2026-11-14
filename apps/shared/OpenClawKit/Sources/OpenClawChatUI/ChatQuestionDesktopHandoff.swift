import OpenClawProtocol
import SwiftUI

/// A presentation projection of a canonical question, not another request or completion owner.
public struct OpenClawQuestionDesktopHandoff: Identifiable, Hashable, Sendable {
    public let requestID: String
    public let questionID: String
    public let sessionKey: String
    public let runID: String?
    public let environmentID: String

    public var id: String { self.requestID + "/" + self.questionID }

    init?(record: QuestionRecord, question: Question) {
        // Inline schema objects are dictionaries in the generated Swift protocol. Decode once here.
        guard let desktop = question.desktop,
              let source = desktop["source"]?.value as? [String: AnyCodable],
              source["kind"]?.value as? String == "environment",
              let environmentID = source["environmentId"]?.value as? String,
              let sessionKey = record.sessionkey
        else { return nil }
        self.requestID = record.id
        self.questionID = question.questionid
        self.sessionKey = sessionKey
        self.runID = record.runid
        self.environmentID = environmentID
    }
}

extension EnvironmentValues {
    @Entry public var openClawOpenQuestionDesktop: (@MainActor (OpenClawQuestionDesktopHandoff) -> Void)? = nil
}

extension OpenClawQuestionCardModel {
    public var desktopHandoffs: [OpenClawQuestionDesktopHandoff] {
        let status = self.status()
        guard status == .pending || status == .submitting else { return [] }
        return self.record.questions.compactMap { OpenClawQuestionDesktopHandoff(record: self.record, question: $0) }
    }
}

extension OpenClawChatViewModel {
    public var activeDesktopHandoffs: [OpenClawQuestionDesktopHandoff] {
        self.visibleQuestionCards.flatMap(\.desktopHandoffs)
    }

    public var pendingDesktopHandoffs: [OpenClawQuestionDesktopHandoff] {
        self.visibleQuestionCards.filter { $0.status() == .pending }.flatMap(\.desktopHandoffs)
    }
}
