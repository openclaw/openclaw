/// What the composer's single primary button does. The phone composer never shows Stop and Send
/// side by side: one button in one place changes its glyph and action with the state.
enum ChatComposerPrimaryRole: Equatable {
    case talk
    case send
    case stop

    /// The one place that maps composer state to the primary button. A send in flight is not a
    /// state of its own: the button shows what fits the field (Send while the draft is still there,
    /// disabled; Talk or Stop once the field clears) and the message shows that it is sending.
    static func resolve(
        hasDraftToSend: Bool,
        canSendDraft: Bool,
        hasStoppableReply: Bool,
        hasReplyRunningElsewhere: Bool,
        hasBlockingRunActivity: Bool,
        isLocalVoiceCaptureActive: Bool,
        hasTalkControl: Bool) -> Self
    {
        if hasStoppableReply {
            // Decision point (F38, pending Victor): a draft that can be sent now wins over Stop, and
            // Stop returns once the field is empty. The alternative keeps Stop until the reply ends:
            // `return .stop`. A draft that cannot go out during a reply (attachments, a local
            // session command, a transport without an outbox) keeps Stop.
            return hasDraftToSend && canSendDraft ? .send : .stop
        }
        if hasTalkControl, OpenClawChatComposer.showsCompactTalkControl(
            hasDraftToSend: hasDraftToSend,
            hasBlockingRunActivity: hasBlockingRunActivity,
            isLocalVoiceCaptureActive: isLocalVoiceCaptureActive)
        {
            return .talk
        }
        // A reply this client cannot stop yet (its own send before the run registers, or another
        // client's run): Stop, inert, while the field is empty. Local capture keeps its own stop.
        if hasReplyRunningElsewhere, !hasDraftToSend, !isLocalVoiceCaptureActive {
            return .stop
        }
        return .send
    }
}
