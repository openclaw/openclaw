function createSlackSystemEventTestHarness(overrides) {
  const handlers = {};
  const channelType = overrides?.channelType ?? "im";
  const app = {
    event: (name, handler) => {
      handlers[name] = handler;
    }
  };
  const ctx = {
    app,
    runtime: { error: () => {
    } },
    dmEnabled: true,
    dmPolicy: overrides?.dmPolicy ?? "open",
    defaultRequireMention: true,
    channelsConfig: overrides?.channelUsers ? {
      C1: {
        users: overrides.channelUsers,
        allow: true
      }
    } : void 0,
    groupPolicy: "open",
    allowFrom: overrides?.allowFrom ?? [],
    allowNameMatching: false,
    shouldDropMismatchedSlackEvent: () => false,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({
      name: channelType === "im" ? "direct" : "general",
      type: channelType
    }),
    resolveUserName: async () => ({ name: "alice" }),
    resolveSlackSystemEventSessionKey: () => "agent:main:main"
  };
  return {
    ctx,
    getHandler(name) {
      return handlers[name] ?? null;
    }
  };
}
export {
  createSlackSystemEventTestHarness
};
