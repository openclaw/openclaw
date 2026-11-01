import { vi } from "vitest";

const reactionStores = new Set<{ clearForTest(): void }>();

vi.mock("openclaw/plugin-sdk/approval-reaction-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/approval-reaction-runtime")>();
  return {
    ...actual,
    createApprovalReactionTargetStore: <TTarget>(
      params: Parameters<typeof actual.createApprovalReactionTargetStore<TTarget>>[0],
    ) => {
      const store = actual.createApprovalReactionTargetStore<TTarget>(params);
      if (params.namespace === "signal.approval-reactions.v2") {
        reactionStores.add(store);
      }
      return store;
    },
  };
});

export function clearSignalApprovalReactionStoresForTest(): void {
  // Module reloads create new owners; retain every captured store for later resets.
  reactionStores.forEach((store) => store.clearForTest());
}
