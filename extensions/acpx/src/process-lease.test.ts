import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAcpxProcessLeaseStore,
  openAcpxProcessLeaseStateStore,
  OPENCLAW_ACPX_LEASE_ID_ARG as LEASE_ARG,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG as GATEWAY_ARG,
  readAcpxProcessLeaseIdentity,
  withAcpxLeaseArgs,
  type AcpxProcessLease,
} from "./process-lease.js";
import { ACPX_PROCESS_LEASE_MAX_ENTRIES as MAX_LEASES } from "./state.js";

const makeLease = (index: number): AcpxProcessLease => ({
  leaseId: `lease-${index}`,
  gatewayInstanceId: "gateway-test",
  sessionKey: `agent:codex:acp:${index}`,
  wrapperRoot: "/tmp/openclaw/acpx",
  wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
  rootPid: 1000 + index,
  commandHash: `hash-${index}`,
  startedAt: index,
  state: "open",
});

describe("createAcpxProcessLeaseStore", () => {
  let stateDir = "";
  let store: ReturnType<typeof createAcpxProcessLeaseStore>;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-acpx-leases-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    store = createAcpxProcessLeaseStore({
      store: openAcpxProcessLeaseStateStore((options) =>
        createPluginStateKeyedStoreForTests("acpx", { ...options, env }),
      ),
    });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("removes terminal leases from the live lease namespace", async () => {
    const openLease = makeLease(1);
    const closedLease = makeLease(2);
    await store.save(openLease);
    await store.save(closedLease);

    await store.markState(closedLease.leaseId, "closed");

    await expect(store.load(closedLease.leaseId)).resolves.toBeUndefined();
    await expect(store.listOpen("gateway-test")).resolves.toEqual([openLease]);
  });

  it("rejects capacity overflow without evicting existing process ownership", async () => {
    await Promise.all(
      Array.from({ length: MAX_LEASES }, (_, index) => store.save(makeLease(index))),
    );

    await expect(store.save(makeLease(MAX_LEASES))).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    await expect(store.load("lease-0")).resolves.toEqual(makeLease(0));
    await expect(store.listOpen("gateway-test")).resolves.toHaveLength(MAX_LEASES);
  });
});

it("preserves portable lease wrapper args", () => {
  const argv = ["node", "C:/openclaw/acpx/codex-acp-wrapper.mjs", ""];
  const expected = [...argv, LEASE_ARG, "lease test", GATEWAY_ARG, "gateway-test"];
  expect(
    withAcpxLeaseArgs({
      command: argv,
      leaseId: "lease test",
      gatewayInstanceId: "gateway-test",
    }),
  ).toEqual(expected);
});

it.each([
  [
    `node /tmp/openclaw/acpx/codex-acp-wrapper.mjs --label owner's-choice ${LEASE_ARG} 'lease test' ${GATEWAY_ARG} "gateway test"`,
    { leaseId: "lease test", gatewayInstanceId: "gateway test" },
  ],
  [`node wrapper.mjs ${LEASE_ARG} lease-test`, undefined],
  [undefined, undefined],
] as const)("parses lease identity from %s", (command, expected) => {
  expect(readAcpxProcessLeaseIdentity(command)).toEqual(expected);
});
