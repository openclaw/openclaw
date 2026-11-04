export type InboundDecisionParams = Parameters<
  typeof import("./inbound-processing.js").resolveIMessageInboundDecision
>[0];
type Overrides = Omit<Partial<InboundDecisionParams>, "message"> & {
  message?: Partial<InboundDecisionParams["message"]>;
};

export function createInboundDecisionParams(overrides: Overrides = {}): InboundDecisionParams {
  const { message: suppliedMessage, ...rest } = overrides;
  const message = {
    id: 42,
    sender: "+15555550123",
    text: "ok",
    is_from_me: false,
    is_group: false,
    ...suppliedMessage,
  };
  const messageText = rest.messageText ?? message.text ?? "";
  return {
    cfg: {},
    accountId: "default",
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    readStoreAllowFrom: async () => [],
    historyLimit: 0,
    groupHistories: new Map(),
    ...rest,
    message,
    messageText,
    bodyText: rest.bodyText ?? messageText,
  };
}
