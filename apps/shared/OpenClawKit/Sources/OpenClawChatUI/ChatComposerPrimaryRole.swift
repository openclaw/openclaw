/// What the composer's single primary button does. The phone composer never shows Stop and Send
/// side by side: one button in one place changes its glyph and action with the state.
enum ChatComposerPrimaryRole: Equatable {
    case talk
    case send
    case stop

    /// The one place that maps composer state to the primary button. Sending a message that asks
    /// for a reply goes straight from Send to Stop; the message itself shows that it is sending.
    static func resolve(
        hasDraftToSend: Bool,
        canSendDraft: Bool,
        // A reply this client started: running and stoppable, or sent just now and not yet registered.
        hasOwnReply: Bool,
        hasReplyRunningElsewhere: Bool,
        hasBlockingRunActivity: Bool,
        isLocalVoiceCaptureActive: Bool,
        hasTalkControl: Bool) -> Self
    {
        if hasOwnReply {
            // Decision point (F38, pending Victor): a draft that can be sent now wins over Stop, and
            // Stop returns once the field is empty. The alternative keeps Stop until the reply ends:
            // `return .stop`. A draft that cannot go out during a reply (attachments, a local
            // session command, a transport without an outbox) keeps Stop.
            // Sent just now: the same rule from the tap on, so Send goes straight to Stop.
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
