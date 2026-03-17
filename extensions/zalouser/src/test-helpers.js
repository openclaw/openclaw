function createZalouserRuntimeEnv() {
  return {
    log: () => {
    },
    error: () => {
    },
    exit: ((code) => {
      throw new Error(`exit ${code}`);
    })
  };
}
function createDefaultResolvedZalouserAccount(overrides = {}) {
  return {
    accountId: "default",
    profile: "default",
    name: "test",
    enabled: true,
    authenticated: true,
    config: {},
    ...overrides
  };
}
export {
  createDefaultResolvedZalouserAccount,
  createZalouserRuntimeEnv
};
