import { setImmediate as immediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  adoptedEntry,
  catalogThreadItem,
  CODEX_LOCAL_SESSION_HOST_ID,
  config,
  createCodexTestBindingStore,
  createEligibleControl,
  createGatewayApi,
  createRuntime,
  idleThread,
  registerCodexSessionCatalog,
  seedSupervisionBinding,
  supervisionSessionKey,
} from "./session-catalog.test-helpers.js";

it("returns the upstream seed to every joined catalog Continue request", async () => {
  const sessionKey = supervisionSessionKey("thread-1");
  const entry = adoptedEntry({ sourceThreadId: "thread-1" });
  const { runtime } = createRuntime({ entries: [{ sessionKey, entry }] });
  const bindingStore = createCodexTestBindingStore();
  await seedSupervisionBinding({
    bindingStore,
    sessionId: entry.sessionId,
    sessionKey,
    sourceThreadId: "thread-1",
  });
  const reading = Promise.withResolvers<void>();
  const readGate = Promise.withResolvers<void>();
  const readThread = vi.fn(async (id: string) => {
    reading.resolve();
    await readGate.promise;
    return idleThread({
      id,
      turns: [
        {
          id: "native-turn",
          status: "completed",
          items: [catalogThreadItem("user-1", { type: "userMessage", text: "native input" })],
        },
      ],
    });
  });
  const control = createEligibleControl({ readThread });
  const forRequest = vi.fn(() => control);
  const { api, getProvider } = createGatewayApi(runtime);
  registerCodexSessionCatalog({
    api,
    bindingStore,
    control: { forRequest },
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => config,
  });
  const provider = getProvider();
  if (!provider?.continueSession) {
    throw new Error("Codex catalog did not register Continue");
  }
  const request = {
    hostId: CODEX_LOCAL_SESSION_HOST_ID,
    threadId: "thread-1",
    clientScopes: ["operator.admin"],
  };
  const first = provider.continueSession(request);
  const pending: Promise<unknown>[] = [first];
  try {
    await Promise.race([
      reading.promise,
      first.then(() => {
        throw new Error("Continue did not reach the held native read");
      }),
    ]);
    const second = provider.continueSession(request);
    pending.push(second);
    await vi.waitFor(() => expect(forRequest).toHaveBeenCalledTimes(2));
    // Both requests have bound their source; drain the cached module-import continuation.
    await immediate();
    readGate.resolve();
    const expected = {
      sessionKey,
      upstream: {
        kind: "codex-app-server",
        ref: { connectionFingerprint: "catalog-connection", threadId: "thread-1" },
        marker: { turnId: "native-turn", userMessageCount: 1 },
      },
    };
    expect(await Promise.all([first, second])).toEqual([expected, expected]);
    expect(readThread).toHaveBeenCalledOnce();
  } finally {
    readGate.resolve();
    await Promise.allSettled(pending);
  }
});
