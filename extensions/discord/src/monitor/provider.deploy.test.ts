import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import type { Client } from "../internal/discord.js";
import {
  createInternalTestClient,
  createTestCommand,
} from "../internal/test-builders.test-support.js";
import { runDiscordCommandDeployInBackground } from "./provider.deploy.js";

afterEach(() => vi.restoreAllMocks());

function runDeploy(client: Client) {
  const runtime = createRuntimeSpies();
  const logged = Promise.withResolvers<void>();
  runtime.log.mockImplementation(() => logged.resolve());
  // Observe settlement without replacing the real command deployment path.
  const deploy = vi.spyOn(client, "deployCommands");
  runDiscordCommandDeployInBackground({
    client,
    runtime,
    enabled: true,
    accountId: "default",
  });
  return { runtime, logged: logged.promise, deployment: deploy.mock.results[0]?.value };
}

it("passes non-command REST traffic through without deploy labels", async () => {
  const listing = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const voiceError = Object.assign(new Error("Unknown Voice State"), { status: 404 });
  const client = createInternalTestClient([], {
    requestOptions: {
      queueRequests: false,
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes("/voice-states/")) {
          throw voiceError;
        }
        started.resolve();
        return await listing.promise;
      },
    },
  });
  const { runtime, deployment } = runDeploy(client);
  await started.promise;

  // Unrelated traffic overlaps the pending command request on the same REST client.
  await expect(client.rest.get("/guilds/1/voice-states/2")).rejects.toBe(voiceError);
  expect(voiceError).not.toHaveProperty("deployRestMethod");
  expect(voiceError).not.toHaveProperty("deployRestPath");
  listing.resolve(Response.json([]));
  await deployment;

  expect(runtime.log.mock.calls.flat().join("\n")).not.toMatch(
    /voice-states|slash command deploy failed/,
  );
  expect(runtime.error.mock.calls.flat().join("\n")).not.toContain("voice-states");
});

it("logs one warning per deploy failure at default verbosity", async () => {
  const client = createInternalTestClient([createTestCommand("skill")], {
    requestOptions: {
      queueRequests: false,
      fetch: async (_input, init) =>
        init?.method === "GET"
          ? Response.json([])
          : Response.json({ message: "Missing Access", code: 50001 }, { status: 403 }),
    },
  });
  const { runtime, logged } = runDeploy(client);
  await logged;

  const warnings = runtime.log.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes("slash command deploy failed"));
  expect(warnings).toEqual([expect.stringContaining("(message send/receive unaffected)")]);
  expect(warnings[0]).toContain("Missing Access (status=403, code=50001)");
  expect(runtime.error).not.toHaveBeenCalled();
});

it.each(["GET", "PATCH", "POST", "PUT", "DELETE"] as const)(
  "logs the failed %s deployment request's diagnostic context without replacing its error",
  async (method) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const failure = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const client = createInternalTestClient(
      [createTestCommand("ping", undefined, { description: "ping the bot" })],
      {
        requestOptions: {
          queueRequests: false,
          timeout: 15_000,
          fetch: async (_input, init) => {
            if (init?.method === method) {
              clock.mockReturnValue(26_000);
              throw failure;
            }
            if (init?.method === "GET") {
              return Response.json(
                method === "PATCH" || method === "DELETE"
                  ? [
                      {
                        id: "cmd1",
                        type: 1,
                        name: method === "DELETE" ? "stale" : "ping",
                        description: "old description",
                      },
                    ]
                  : [],
              );
            }
            return method === "PUT" && init?.method === "POST"
              ? Response.json(
                  { code: 30032, message: "Maximum number of application commands reached" },
                  { status: 400 },
                )
              : Response.json({});
          },
        },
      },
    );
    const { runtime, logged, deployment } = runDeploy(client);
    await logged;
    await expect(deployment).rejects.toBe(failure);

    const path = `/applications/app1/commands${method === "PATCH" || method === "DELETE" ? "/cmd1" : ""}`;
    expect(String(runtime.log.mock.calls[0]?.[0])).toContain(
      `Discord REST ${method} ${path} timed out (timeout=15s, observed=25s)`,
    );
    if (method === "GET" || method === "DELETE") {
      expect(failure).not.toHaveProperty("deployRequestBody");
    } else {
      const command = expect.objectContaining({ name: "ping", description: "ping the bot" });
      expect(failure).toHaveProperty("deployRequestBody", method === "PUT" ? [command] : command);
    }
  },
);
