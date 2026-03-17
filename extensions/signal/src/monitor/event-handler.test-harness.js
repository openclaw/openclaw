function createBaseSignalEventHandlerDeps(overrides = {}) {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { log: () => {
    }, error: () => {
    } },
    cfg: {},
    baseUrl: "http://localhost",
    accountId: "default",
    historyLimit: 5,
    groupHistories: /* @__PURE__ */ new Map(),
    textLimit: 4e3,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupAllowFrom: ["*"],
    groupPolicy: "open",
    reactionMode: "off",
    reactionAllowlist: [],
    mediaMaxBytes: 1024,
    ignoreAttachments: true,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment: async () => null,
    deliverReplies: async () => {
    },
    resolveSignalReactionTargets: () => [],
    isSignalReactionMessage: (_reaction) => false,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "reaction",
    ...overrides
  };
}
function createSignalReceiveEvent(envelopeOverrides = {}) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Alice",
        timestamp: 17e11,
        ...envelopeOverrides
      }
    })
  };
}
export {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent
};
