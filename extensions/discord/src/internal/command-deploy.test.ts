/* oxlint-disable typescript/unbound-method -- vitest mocks of RequestClient methods (createRest) intentionally expose vi.fn refs via `restA.get`/`.post`; not unbound class methods. */
import { describe, expect, test, vi } from "vitest";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import type { RequestClient } from "./rest.js";
import {
  attachRestMock,
  createInternalTestClient,
  createTestCommand,
  createTestHashStore,
} from "./test-builders.test-support.js";

// #77359: identical command sets must not suppress another application’s deploy.
describe("Client.deployCommands cache", () => {
  function createRest(): RequestClient {
    const client = createInternalTestClient();
    attachRestMock(client, { get: vi.fn(async () => []) });
    return client.rest;
  }

  function deployer(
    rest: RequestClient,
    hashStore: DiscordCommandDeployHashStore,
    clientId = "app-default",
  ) {
    const client = createInternalTestClient(
      [createTestCommand("ping", undefined, { description: "ping the bot" })],
      { clientId, commandDeployHashStore: hashStore },
    );
    client.rest = rest;
    return client;
  }

  test("two applications with identical command sets each reconcile their own application", async () => {
    const { store, rows } = createTestHashStore();
    const restA = createRest();
    const restB = createRest();

    await Promise.all([
      deployer(restA, store).deployCommands(),
      deployer(restB, store, "app-secondary").deployCommands(),
    ]);

    expect(restA.get).toHaveBeenCalledTimes(1);
    expect(restA.post).toHaveBeenCalledTimes(1);
    expect(restB.get).toHaveBeenCalledTimes(1);
    expect(restB.post).toHaveBeenCalledTimes(1);
    expect([...rows.keys()].toSorted()).toEqual([
      "app:app-default:global:reconcile",
      "app:app-secondary:global:reconcile",
    ]);
  });

  test.each([
    { failure: "lookup", deployments: 1 },
    { failure: "register", deployments: 2 },
  ] as const)(
    "keeps deployments working after SQLite $failure fails",
    async ({ failure, deployments }) => {
      const store = {
        lookup: vi.fn(async () => undefined),
        register: vi.fn(async () => undefined),
      };
      store[failure].mockRejectedValue(new Error("database unavailable"));
      const rest = createRest();
      const cached = deployer(rest, store);
      for (let index = 0; index < deployments; index += 1) {
        await cached.deployCommands();
      }
      expect(rest.get).toHaveBeenCalledTimes(1);
      expect(rest.post).toHaveBeenCalledTimes(1);
      expect(store.register).toHaveBeenCalledOnce();
    },
  );
});
