// Verifies the secret-assignment broker plugin: model semantics, the
// secret_env_authorize handler, gateway RPC behavior, and identity isolation.
// All entries are synthetic names; no secret value ever enters these tests.
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  allowedNamesForCandidate,
  applyAssignmentEdit,
  EMPTY_ASSIGNMENT,
  normalizeAssignment,
  type CandidateEntry,
} from "./src/assignments.js";
import { createMemoryAssignmentStore } from "./src/store.js";

const CANDIDATES: CandidateEntry[] = [
  { name: "ENV_A", kind: "env" },
  { name: "ENV_B", kind: "env" },
  { name: "SEC_C", kind: "secret" },
];

describe("assignment model", () => {
  it("empty/absent selection is never global", () => {
    expect(
      allowedNamesForCandidate({ assignment: EMPTY_ASSIGNMENT, candidates: CANDIDATES }),
    ).toEqual([]);
    expect(
      allowedNamesForCandidate({
        assignment: normalizeAssignment({ mode: "selected", names: [] }),
        candidates: CANDIDATES,
      }),
    ).toEqual([]);
  });

  it("all vs selected", () => {
    expect(
      allowedNamesForCandidate({
        assignment: { mode: "all", names: [] },
        candidates: CANDIDATES,
      }),
    ).toEqual(["ENV_A", "ENV_B", "SEC_C"]);
    expect(
      allowedNamesForCandidate({
        assignment: { mode: "selected", names: ["ENV_B"] },
        candidates: CANDIDATES,
      }),
    ).toEqual(["ENV_B"]);
  });

  it("selected ignores names not present in the projection", () => {
    expect(
      allowedNamesForCandidate({
        assignment: { mode: "selected", names: ["ENV_A", "UNKNOWN"] },
        candidates: CANDIDATES,
      }),
    ).toEqual(["ENV_A"]);
  });

  it("edits produce the next record and normalize junk", () => {
    expect(
      applyAssignmentEdit({ mode: "selected", names: ["ENV_A", "ENV_A", 3 as never] }),
    ).toEqual({
      mode: "selected",
      names: ["ENV_A"],
    });
    expect(applyAssignmentEdit({ mode: "none" })).toEqual({ mode: "none", names: [] });
    expect(normalizeAssignment("garbage")).toEqual(EMPTY_ASSIGNMENT);
  });
});

/** Captured plugin registration with an in-memory keyed store. */
function capturePlugin() {
  const keyed = new Map<string, unknown>();
  const stateStore = {
    lookup: async (key: string) => keyed.get(key),
    register: async (key: string, value: unknown) => {
      keyed.set(key, value);
    },
    entries: async () => [...keyed.entries()].map(([key, value]) => ({ key, value })),
  };
  const hooks: Array<{ handler: (event: unknown, ctx: unknown) => Promise<unknown> }> = [];
  const methods = new Map<string, { handler: (opts: unknown) => unknown; options: unknown }>();
  const api = {
    runtime: { state: { openKeyedStore: () => stateStore } },
    on: (_name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      hooks.push({ handler });
    },
    registerGatewayMethod: (
      method: string,
      handler: (opts: unknown) => unknown,
      options: unknown,
    ) => {
      methods.set(method, { handler, options });
    },
  };
  plugin.register(api as never);
  return { hooks, methods, keyed };
}

/** Invokes a captured gateway handler and captures its respond() call. */
async function callMethod(
  methods: Map<string, { handler: (opts: unknown) => unknown }>,
  method: string,
  params: unknown,
  agentId?: string,
) {
  const entry = methods.get(method);
  if (!entry) {
    throw new Error(`method not registered: ${method}`);
  }
  let responded: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await entry.handler({
    params,
    client: agentId ? { internal: { agentRuntimeIdentity: { agentId } } } : null,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      responded = { ok, payload, error };
    },
  });
  return responded!;
}

describe("secret_env_authorize handler", () => {
  it("denies everything when no identity is present", async () => {
    const { hooks } = capturePlugin();
    const result = await hooks[0]!.handler(
      { toolName: "exec", host: "gateway", candidates: CANDIDATES },
      {},
    );
    expect(result).toEqual({ allowedNames: [] });
  });

  it("authorizes exactly the agent's selected names", async () => {
    const { hooks, methods } = capturePlugin();
    await callMethod(methods, "secrets.assignments.broker.set", {
      agentId: "agent-1",
      mode: "selected",
      names: ["ENV_A"],
    });
    const result = (await hooks[0]!.handler(
      { toolName: "exec", host: "gateway", candidates: CANDIDATES },
      { agentId: "agent-1" },
    )) as { allowedNames: string[] };
    expect(result.allowedNames).toEqual(["ENV_A"]);
  });

  it("all mode authorizes every resolved candidate", async () => {
    const { hooks, methods } = capturePlugin();
    await callMethod(methods, "secrets.assignments.broker.set", {
      agentId: "agent-1",
      mode: "all",
    });
    const result = (await hooks[0]!.handler(
      { toolName: "exec", host: "gateway", candidates: CANDIDATES },
      { agentId: "agent-1" },
    )) as { allowedNames: string[] };
    expect(result.allowedNames).toEqual(["ENV_A", "ENV_B", "SEC_C"]);
  });

  it("cross-agent isolation: one agent's assignment never authorizes another", async () => {
    const { hooks, methods } = capturePlugin();
    await callMethod(methods, "secrets.assignments.broker.set", {
      agentId: "agent-1",
      mode: "all",
    });
    const result = (await hooks[0]!.handler(
      { toolName: "exec", host: "gateway", candidates: CANDIDATES },
      { agentId: "agent-2" },
    )) as { allowedNames: string[] };
    expect(result.allowedNames).toEqual([]);
  });

  it("never discloses values: the handler only sees candidate names and kinds", async () => {
    const { hooks } = capturePlugin();
    const event = { toolName: "exec", host: "gateway", candidates: CANDIDATES };
    await hooks[0]!.handler(event, { agentId: "agent-1" });
    expect(JSON.stringify(event)).not.toMatch(/synthetic|SENTINEL|value/i);
  });
});

describe("gateway RPCs", () => {
  it("self RPC derives identity from the client, never from params", async () => {
    const { methods } = capturePlugin();
    await callMethod(methods, "secrets.assignments.broker.set", {
      agentId: "agent-1",
      mode: "selected",
      names: ["SEC_C"],
    });
    // Params try to impersonate agent-1, but identity comes from the client.
    const spoof = await callMethod(
      methods,
      "secrets.assignments.broker.self",
      { agentId: "agent-1" },
      "agent-2",
    );
    expect(spoof.ok).toBe(true);
    expect(spoof.payload).toEqual({ agentId: "agent-2", assignment: { mode: "none", names: [] } });
  });

  it("self RPC returns none when unauthenticated", async () => {
    const { methods } = capturePlugin();
    const result = await callMethod(methods, "secrets.assignments.broker.self", {});
    expect(result.payload).toEqual({ agentId: null, assignment: { mode: "none", names: [] } });
  });

  it("operator list/set require admin scope and enumerate assignments", async () => {
    const { methods } = capturePlugin();
    expect(methods.get("secrets.assignments.broker.list")?.options).toEqual({
      scope: "operator.admin",
    });
    expect(methods.get("secrets.assignments.broker.set")?.options).toEqual({
      scope: "operator.admin",
    });
    await callMethod(methods, "secrets.assignments.broker.set", {
      agentId: "agent-1",
      mode: "selected",
      names: ["ENV_A"],
    });
    const list = await callMethod(methods, "secrets.assignments.broker.list", {});
    expect(list.payload).toEqual({
      entries: [{ agentId: "agent-1", assignment: { mode: "selected", names: ["ENV_A"] } }],
    });
  });

  it("set rejects an invalid mode", async () => {
    const { methods } = capturePlugin();
    const result = await callMethod(methods, "secrets.assignments.broker.set", {
      agentId: "agent-1",
      mode: "bogus",
    });
    expect(result.ok).toBe(false);
  });
});

describe("store", () => {
  it("memory store normalizes seeded and written values", async () => {
    const store = createMemoryAssignmentStore({ "agent-1": { mode: "all", names: [] } });
    expect(await store.get("agent-1")).toEqual({ mode: "all", names: [] });
    await store.set("agent-2", { mode: "selected", names: ["X"] });
    expect(await store.get("agent-2")).toEqual({ mode: "selected", names: ["X"] });
    expect(await store.get("missing")).toEqual(EMPTY_ASSIGNMENT);
  });
});

/**
 * Rollout/activation semantics. These protect the compatibility contract the
 * plugin documents: default-disabled, fail-closed on a fresh enable with no
 * assignments, and an unchanged projection while the plugin is disabled.
 */
describe("rollout and activation", () => {
  it("is disabled by default so existing installs are unaffected after upgrade", () => {
    expect(manifest.enabledByDefault).toBe(false);
  });

  it("fresh enable with no assignments denies every resolved entry (fail closed)", async () => {
    const { hooks } = capturePlugin();
    for (const ctx of [{}, { agentId: "fresh-agent" }]) {
      const result = (await hooks[0]!.handler(
        { toolName: "exec", host: "gateway", candidates: CANDIDATES },
        ctx,
      )) as { allowedNames: string[] };
      expect(result.allowedNames).toEqual([]);
    }
  });

  it("an empty selected assignment is never global", async () => {
    const { hooks, methods } = capturePlugin();
    await callMethod(methods, "secrets.assignments.broker.set", {
      agentId: "agent-1",
      mode: "selected",
      names: [],
    });
    const result = (await hooks[0]!.handler(
      { toolName: "exec", host: "gateway", candidates: CANDIDATES },
      { agentId: "agent-1" },
    )) as { allowedNames: string[] };
    expect(result.allowedNames).toEqual([]);
  });

  it("keeps the public API surface minimal (one hook, three RPCs)", () => {
    const { hooks, methods } = capturePlugin();
    expect(hooks).toHaveLength(1);
    expect([...methods.keys()].toSorted()).toEqual([
      "secrets.assignments.broker.list",
      "secrets.assignments.broker.self",
      "secrets.assignments.broker.set",
    ]);
  });
});
