import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { describeCodexSpawnError } from "./app-server/spawn-error.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
} from "./session-catalog.test-helpers.js";

it("retires the resident refresh loop when its catalog owner stops", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      appServer: {
        transport: "websocket",
        url: "wss://retired-catalog.example.test/codex",
        authToken: "synthetic-catalog-token",
      },
    }),
    getRuntimeConfig: () => undefined,
  });
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  try {
    await control.initialize();
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);

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
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      appServer: {
        transport: "websocket",
        url: "wss://retired-catalog.example.test/codex",
        authToken: "synthetic-catalog-token",
      },
    }),
    getRuntimeConfig: () => undefined,
  });
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
