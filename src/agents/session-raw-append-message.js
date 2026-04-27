const RAW_APPEND_MESSAGE = Symbol("openclaw.session.rawAppendMessage");
/**
 * Return the unguarded appendMessage implementation for a session manager.
 */
export function getRawSessionAppendMessage(sessionManager) {
    const rawAppend = sessionManager[RAW_APPEND_MESSAGE];
    return rawAppend ?? sessionManager.appendMessage.bind(sessionManager);
}
export function setRawSessionAppendMessage(sessionManager, appendMessage) {
    sessionManager[RAW_APPEND_MESSAGE] = appendMessage;
}
