export const isAssistantMessage = (message) => {
    return message?.role === 'assistant';
};
export const isToolMessage = (message) => {
    return message?.role === 'tool';
};
export function isPresent(obj) {
    return obj != null;
}
//# sourceMappingURL=chatCompletionUtils.mjs.map