export type ProviderRequestErrorCode = "provider_conversation_state_error";
export type ProviderRequestErrorClassification = {
    code: ProviderRequestErrorCode;
    userMessage: string;
    technicalMessage: string;
};
export declare const PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE = "\u26A0\uFE0F The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.";
export declare function classifyProviderRequestError(err: unknown): ProviderRequestErrorClassification | undefined;
export declare function isProviderConversationStateErrorMessage(message: string): boolean;
