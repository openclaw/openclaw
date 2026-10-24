import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMatrixQaHttp } from "../substrate/http.test-support.js";

const runMatrixQaCanary = vi.hoisted(() => vi.fn(async () => ({})));

// mock-isolation: A synthetic Matrix account keeps scenario observations off operator config.
vi.mock("../substrate/config.js", () => ({
  buildMatrixQaConfig: () => ({ channels: { matrix: { execApprovals: { enabled: true } } } }),
}));
vi.mock("./scenario-runtime-room.js", () => ({ runMatrixQaCanary }));

import { createMatrixQaScenarioEnvironment } from "./scenario-environment.js";
import { createMatrixQaScenarioClient } from "./scenario-runtime-shared.js";
import { matrixMessage, matrixSyncResponse } from "./scenario-runtime.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("matrix scenario observation", () => {
  it("resets passive observers without acknowledging encrypted-device messages", async () => {
    const configSnapshots = [
      { config: {} },
      { hash: "config-hash" },
      { appliedConfigHash: "config-hash", configRevisionHash: "config-hash", hash: "config-hash" },
    ];
    const account = { accountId: "sut", connected: true, running: true };
    let configReadCount = 0;
    const gateway = {
      baseUrl: "http://127.0.0.1:12345",
      runtimeEnv: {},
      tempRoot: "/tmp/matrix-qa",
      workspaceDir: "/tmp/matrix-qa/workspace",
      call: vi.fn(async (method: string) => {
        if (method === "config.get") {
          return configSnapshots[configReadCount++ % configSnapshots.length];
        }
        if (method === "config.patch") {
          return { hash: "config-hash", changedPaths: [], noop: true, ok: true };
        }
        if (method === "channels.status") {
          return { channelAccounts: { matrix: [account] } };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };
    const environment = createMatrixQaScenarioEnvironment({
      accountId: "sut",
      harness: { baseUrl: "http://127.0.0.1:8008", recording: {} } as never,
      observedEvents: [],
      provisioning: {
        driver: { accessToken: "driver-primary", userId: "@driver:test" },
        observer: { accessToken: "observer-primary", userId: "@observer:test" },
        observationAccounts: {
          driver: { accessToken: "driver-room-observation" },
          observer: { accessToken: "observer-room-observation" },
        },
        roomId: "!room:test",
        sut: { accessToken: "fixture", userId: "@sut:test" },
        topology: { rooms: [] },
      } as never,
    });
    const input = {
      config: { matrixRequireCanary: true },
      gateway,
      outputDir: "/tmp/matrix-qa/output",
      scenarioId: "matrix-observer-reset",
      scenarioTitle: "Matrix observer reset",
      timeoutMs: 8_000,
      waitForConfigRestartSettle: vi.fn(),
    };
    const first = await environment.prepareFlow(input);
    const staleObserver = { prime: vi.fn() } as never;
    first.scenarioContext.syncStreams.driver = staleObserver;
    first.scenarioContext.syncStreams.observer = staleObserver;

    const second = await environment.prepareFlow(input);

    expect(second.scenarioContext.timeoutMs).toBe(8_000);
    expect(input.waitForConfigRestartSettle).not.toHaveBeenCalled();
    expect(runMatrixQaCanary).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));

    // Matrix acknowledges device messages when the next /sync uses next_batch.
    // Room observation must not consume the encrypted client's verification event.
    const done = { type: "m.key.verification.done", content: { transaction_id: "qr-fixture" } };
    const pending = new Map([
      ["driver-primary", [done]],
      ["observer-primary", [done]],
    ]);
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : request);
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (url.searchParams.get("since") === `${token}-delivered`) {
        pending.delete(token);
      }
      return matrixSyncResponse(
        "!room:test",
        [matrixMessage("$reply", "reply", "@sut:test", "m.text")],
        `${token}-delivered`,
        { to_device: { events: pending.get(token) ?? [] } },
      );
    };
    mockMatrixQaHttp(fetchImpl);
    for (const actorId of ["driver", "observer"] as const) {
      expect(second.scenarioContext.syncStreams[actorId]).not.toBe(staleObserver);
      const accessToken = second.scenarioContext[`${actorId}AccessToken`];
      const client = createMatrixQaScenarioClient({
        ...second.scenarioContext,
        accessToken,
        actorId,
      });
      await client.primeRoom();
      await client.waitForRoomEvent({
        observedEvents: [],
        predicate: (event) => event.eventId === "$reply",
        roomId: "!room:test",
        timeoutMs: 1_000,
      });
      const sdkSync = await fetchImpl(
        "http://127.0.0.1:8008/_matrix/client/v3/sync?since=sdk-before",
        {
          headers: { authorization: `Bearer ${accessToken}` },
        },
      );
      expect((await sdkSync.json()).to_device.events).toEqual([done]);
    }
  });
});
