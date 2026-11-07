type ApprovalReactionRuntime = typeof import("openclaw/plugin-sdk/approval-reaction-runtime");

export function createWhatsAppReactionStores() {
  const stores = new Set<{ clearForTest(): void }>();
  return Object.assign(stores, {
    mockRuntime: async (importOriginal: <T>() => Promise<T>): Promise<ApprovalReactionRuntime> => {
      const actual = await importOriginal<ApprovalReactionRuntime>();
      return {
        ...actual,
        createApprovalReactionTargetStore: <TTarget>(
          params: Parameters<typeof actual.createApprovalReactionTargetStore<TTarget>>[0],
        ) => {
          const store = actual.createApprovalReactionTargetStore<TTarget>(params);
          if (params.namespace === "whatsapp.approval-reactions") {
            stores.add(store);
          }
          return store;
        },
      };
    },
  });
}
