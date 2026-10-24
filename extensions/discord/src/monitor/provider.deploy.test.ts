import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";
import { runDiscordCommandDeployInBackground } from "./provider.deploy.js";

type RestFn = (path: string, data?: unknown, query?: unknown) => Promise<unknown>;
function createRestMock() {
  return {
    options: { timeout: 15_000 },
    get: vi.fn<RestFn>(async () => undefined),
    post: vi.fn<RestFn>(async () => undefined),
    put: vi.fn<RestFn>(async () => undefined),
    patch: vi.fn<RestFn>(async () => undefined),
    delete: vi.fn<RestFn>(async () => undefined),
  };
}
type RestMock = ReturnType<typeof createRestMock>;

function runDeploy(rest: RestMock, deployCommands: (rest: RestMock) => Promise<void>) {
  const log = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
  const client = {
    rest,
    deployCommands: vi.fn(async () => deployCommands(rest)),
  };
  runDiscordCommandDeployInBackground({
    client: client as unknown as Client,
    runtime: { log, error } as unknown as RuntimeEnv,
    enabled: true,
    accountId: "default",
  });
  return { log, error, client };
}

it("passes non-command REST traffic through without deploy labels", async () => {
  const rest = createRestMock();
  rest.get.mockImplementation(async (path: string) => {
    if (path.includes("/voice-states/")) {
      throw Object.assign(new Error("Unknown Voice State"), { status: 404 });
    }
    return undefined;
  });
  let deployFinished = false;
  const { log, error } = runDeploy(rest, async (wrapped) => {
    await wrapped.get("/applications/app-1/commands");
    // Concurrent voice traffic retains caller-owned error handling.
    await expect(wrapped.get("/guilds/1/voice-states/2")).rejects.toThrow("Unknown Voice State");
    deployFinished = true;
  });

  await vi.waitFor(() => expect(deployFinished).toBe(true));
  expect(log.mock.calls.flat().join("\n")).not.toMatch(/voice-states|slash command deploy failed/);
  expect(error.mock.calls.flat().join("\n")).not.toContain("voice-states");
});

it("logs one warning per deploy failure at default verbosity", async () => {
  const rest = createRestMock();
  const deployError = Object.assign(new Error("Missing Access"), {
    status: 403,
    discordCode: 50001,
    rawBody: { message: "Missing Access", code: 50001 },
  });
  rest.post.mockRejectedValue(deployError);
  const { log, error, client } = runDeploy(rest, async (wrapped) => {
    await wrapped.post("/applications/app-1/commands", { body: [{ name: "skill" }] } as never);
  });

  await vi.waitFor(() => expect(client.deployCommands).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(log).toHaveBeenCalled());
  const warnings = log.mock.calls
    .map((call) => call[0])
    .filter((message) => message.includes("slash command deploy failed"));
  expect(warnings).toEqual([expect.stringContaining("(message send/receive unaffected)")]);
  expect(error).not.toHaveBeenCalled();
});
