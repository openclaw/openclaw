import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { describe, expect, it, vi } from "vitest";
import { describeCodexSpawnError } from "./app-server/spawn-error.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
} from "./session-catalog.test-helpers.js";

describe("Codex catalog launch failures", () => {
  it.each(
    ["EBADARCH", "ENOENT", "EACCES"].flatMap((code) =>
      ["cold", "refresh"].map((phase) => ({ code, phase })),
    ),
  )(
    "stops background and foreground retries after $code during $phase",
    async ({ code, phase }) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const factory = createCodexSessionCatalogControlFactory({
        getPluginConfig: () => ({
          appServer: {
            transport: "websocket",
            url: "wss://failed-catalog.example.test/codex",
            authToken: "synthetic-catalog-token",
          },
        }),
        getRuntimeConfig: () => undefined,
      });
      const control = factory.forRequest("main");
      const failure = describeCodexSpawnError(
        Object.assign(new Error("spawn failed"), { code, syscall: "spawn" }),
        `/installed/${code}/${phase}/codex`,
      );
      try {
        if (phase === "refresh") {
          commandRpcMocks.codexControlRequest.mockResolvedValueOnce({ data: [] });
          await control.initialize();
        }
        commandRpcMocks.codexControlRequest.mockRejectedValue(failure);
        if (phase === "cold") {
          await expect(control.initialize()).rejects.toBe(failure);
        } else {
          await vi.advanceTimersByTimeAsync(15 * 60_000);
        }
        await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
        await expect(control.initialize()).rejects.toBe(failure);
        expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(phase === "cold" ? 1 : 2);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("Codex catalog updater cannot run"),
        );
      } finally {
        await factory.stop();
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("selects the recorded package for passive catalogs even with a user home", async () => {
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ appServer: { homeScope: "user" } }),
      getRuntimeConfig: () => undefined,
    });
    try {
      const home = (await factory.homesForAgent("main"))[0]!;
      expect(home.appServer.start).toMatchObject({
        commandSource: "managed",
        managedCommandOrder: "package-only",
      });
    } finally {
      await factory.stop();
    }
  });
});
