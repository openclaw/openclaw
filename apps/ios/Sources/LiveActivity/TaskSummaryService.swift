import Foundation
import os

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Generates short task titles using Apple's on-device Foundation Models (iOS 26+).
/// Falls back to first-sentence extraction when unavailable.
@available(iOS 26.0, *)
actor TaskSummaryService {
    static let shared = TaskSummaryService()

    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "TaskSummary")

    private init() {}

    /// Whether on-device Foundation Models are available.
    var isAvailable: Bool {
        #if canImport(FoundationModels)
        SystemLanguageModel.default.availability == .available
        #else
        false
        #endif
    }

    /// Generate a 2-4 word title for the task from recent user messages.
    func generateTitle(for messages: [String]) async -> String? {
        #if canImport(FoundationModels)
        guard !messages.isEmpty else { return nil }
        guard isAvailable else {
            logger.info("Foundation Models not available")
            return nil
        }

        let session = LanguageModelSession(
            model: .init(useCase: .general, guardrails: .permissiveContentTransformations))

        let numbered = messages.enumerated().map { i, msg in
            "\(i + 1). \"\(msg)\""
        }.joined(separator: "\n")

        let prompt = """
        Analyze these user messages from a conversation with an AI assistant \
        and identify the overall task being worked on. \
        It should read like the task that the assistant will perform. \
        It should sound like an imperative command. Like "Verb Noun".

        Messages (oldest to newest):
        \(numbered)

        The latest message may just be a follow-up. \
        Look at all messages to understand what the user is ultimately trying to accomplish.

        Give a short 2-4 word title for the overall task. \
        Make the title specific to the details in the message. \
        Prioritise proper nouns and details that the user has sent.

        Only output the title, nothing else.
        """

        do {
            let response = try await session.respond(to: prompt)
            let result = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
            logger.info("Generated title: \(result, privacy: .public)")
            return result.isEmpty ? nil : result
        } catch {
            logger.error("Title generation failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        #else
        return nil
        #endif
    }

    /// Generate a completion message from a task title (e.g. "Book flights" → "Your flights have been booked").
    func generateCompletionMessage(for taskTitle: String) async -> String? {
        #if canImport(FoundationModels)
        guard !taskTitle.isEmpty, isAvailable else { return nil }

        let session = LanguageModelSession(
            model: .init(useCase: .general, guardrails: .permissiveContentTransformations))

        let prompt = """
        Transform this task title into a short completion message.

        Task title: "\(taskTitle)"

        Rules:
        - Convert to past tense
        - Keep it concise (under 8 words)
        - Make it sound like a friendly notification
        - Do not use exclamation marks

        Examples:
        - "Book train tickets" → "Your tickets have been booked"
        - "Find restaurants" → "Restaurants found"
        - "Send email to John" → "Email sent to John"

        Only output the completion message, nothing else.
        """

        do {
            let response = try await session.respond(to: prompt)
            return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }
}
