import OpenClawChatUI

enum ChatPreferences {
    static let showAssistantTraceKey = IOSChatPreferences.showsAssistantTraceKey
    static let wrapCodeLinesKey = "openclaw.chat.wrapCodeLines"
    static let followUpModeKey = "openclaw.chat.followUpMode"
    /// The desktop's View switches, one each (web settings-contract.ts `chatShowThinking`,
    /// `chatShowToolCalls`, `chatPersistCommentary`; all on by default). The Gateway's
    /// `ui.prefs` holds the synced value; these keys keep the phone's copy.
    static let showsReasoningKey = "openclaw.webchat.showAssistantReasoning"
    static let showsToolCallsKey = "openclaw.webchat.showAssistantToolActivity"
    static let keepsCommentaryKey = "openclaw.chat.keepCommentary"

    /// The desktop's `ui.prefs` key for each switch.
    static let syncedPrefKeys = [
        Self.showsReasoningKey: "chatShowThinking",
        Self.showsToolCallsKey: "chatShowToolCalls",
        Self.keepsCommentaryKey: "chatPersistCommentary",
    ]

    /// The transcript's display options from the three switches. Before they existed one switch
    /// covered reasoning and tool calls; an unset switch keeps that choice.
    static func displayOptions(
        reasoning: Bool?, toolCalls: Bool?, commentary: Bool, legacyTrace: Bool, reasoningVisible: Bool)
        -> OpenClawChatDisplayOptions
    {
        var options: OpenClawChatDisplayOptions = []
        if reasoning ?? legacyTrace, reasoningVisible { options.insert(.reasoning) }
        if toolCalls ?? legacyTrace { options.insert(.toolActivity) }
        if !commentary { options.insert(.hidesFinishedCommentary) }
        return options
    }
}
