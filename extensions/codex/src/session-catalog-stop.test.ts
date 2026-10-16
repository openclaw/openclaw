import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { describeCodexSpawnError } from "./app-server/spawn-error.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
} from "./session-catalog.test-helpers.js";

function createFactory() {
  return createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      appServer: {
        transport: "websocket",
        url: "wss://retired-catalog.example.test/codex",
        authToken: "synthetic-catalog-token",
      },
    }),
    getRuntimeConfig: () => undefined,
  });
}

it("leaves explicit homes cold until a catalog request admits them", async () => {
  commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
  const factory = createFactory();
  await factory.start();
  expect(factory.hasActiveWork()).toBe(false);
  expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();

  const source = (await factory.homesForAgent("main"))[0]!;
  await factory.forRequest("main", source).initialize();
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
  await factory.stop();
  expect(factory.hasActiveWork()).toBe(false);
});

it("retires the resident refresh loop when its catalog owner stops", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
  const factory = createFactory();
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  try {
    await control.initialize();
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    await control.listPage({ limit: 1 });
    await vi.waitFor(() => expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2));

    await factory.stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    await expect(control.initialize()).rejects.toThrow("Codex resident catalog is closed");
    expect(factory.hasActiveWork()).toBe(false);
  } finally {
    await factory.stop();
    vi.useRealTimers();
  }
});

it("does not publish a late launch advisory after its catalog owner stops", async () => {
  const started = createDeferred<void>();
  const pending = createDeferred<unknown>();
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
  const factory = createFactory();
  const failure = describeCodexSpawnError(
    Object.assign(new Error("spawn failed"), {
      errno: -86,
      syscall: "spawn",
    }),
    "/retired/codex",
  );
  commandRpcMocks.codexControlRequest.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  try {
    const initialized = expect(factory.forRequest("main").initialize()).rejects.toBe(failure);
    await started.promise;
    const stopped = factory.stop();
    pending.reject(failure);
    await Promise.all([initialized, stopped]);
    expect(warn).not.toHaveBeenCalled();
    expect(factory.hasActiveWork()).toBe(false);
  } finally {
    pending.resolve({ data: [] });
    await factory.stop();
    warn.mockRestore();
  }
});
