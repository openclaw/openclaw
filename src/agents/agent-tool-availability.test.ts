import { assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  bindAgentToolAvailability,
  finalizeAgentToolAvailability as finalize,
  markAgentToolExecutionUnavailable as denyExecution,
} from "./agent-tool-availability.js";
import { copyAgentToolMetadata as copyMetadata } from "./agent-tool-metadata.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  rewrapToolWithBeforeToolCallHook as rewrapHook,
  wrapToolWithBeforeToolCallHook as wrapHook,
} from "./agent-tools.before-tool-call.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { SWARM_CODE_MODE_IDEMPOTENCY_KEY } from "./subagents/swarm/swarm-code-mode.js";
import {
  applyToolSearchCatalog as applyCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  restrictToolSearchCatalog as restrictCatalog,
} from "./tool-search.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("./subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: spawn,
}));
const config = { agents: { entries: { main: {} } } };
function spawnTool(signal?: AbortSignal) {
  return createSessionsSpawnTool({
    config,
    agentSessionKey: "agent:main:main",
    requesterRunId: "parent",
    signal,
  });
}
function reader() {
  return createAgentsWaitTool({ config, agentSessionKey: "agent:main:main", agentId: "main" });
}
function deniedCopy<T extends ReturnType<typeof reader>>(tool: T, message: string) {
  return copyMetadata(tool, {
    ...tool,
    execute: vi.fn(tool.execute).mockRejectedValue(new Error(message)),
  });
}
function collect(tool: ReturnType<typeof spawnTool>, id: string) {
  return tool.execute(id, { task: "inspect", collect: true });
}
function catalogFixture(wait = reader(), toolExecutionAllow?: string[]) {
  const catalogConfig = {
    ...config,
    tools: { toolSearch: { enabled: true, mode: "tools" as const } },
  };
  const catalogRef = createToolSearchCatalogRef();
  const controls = createToolSearchTools({ config: catalogConfig, catalogRef });
  const tool = spawnTool();
  const params = {
    tools: [...controls, tool, wait],
    config: catalogConfig,
    catalogRef,
    toolExecutionAllow,
  };
  onTestFinished(() => clearToolSearchCatalog({ catalogRef }));
  const apply = (currentReader?: typeof wait) => {
    if (currentReader) {
      params.tools = [...controls, tool, currentReader];
    }
    return applyCatalog(params);
  };
  return { tool, params, catalogRef, apply, wait };
}
// An offered reader keeps the collector definition (prompt-cache stability); execution
// denial of the reader is enforced by the spawn guard, not by hiding the fields.
function expectCollection(tool: { parameters: unknown; description: unknown }, offered: boolean) {
  const assertion = <T>(value: T) => (offered ? expect(value) : expect(value).not);
  for (const field of ["collect", "outputSchema", "groupId"]) {
    assertion(tool.parameters).toHaveProperty(`properties.${field}`);
  }
  assertion(tool.description).toContain("collect=true");
  if (!offered) {
    expect(tool.parameters).toHaveProperty("properties.fastMode");
  }
}
async function expectCollectionDenied(
  tool: ReturnType<typeof spawnTool>,
  id = "denied",
  extra = {},
) {
  await expect(tool.execute(id, { task: "inspect", collect: true, ...extra })).rejects.toThrow(
    "Collector results are unavailable",
  );
  expect(spawn).not.toHaveBeenCalled();
}
function expectNormalizedCollector(tool: { parameters: unknown }) {
  expect(tool.parameters).toHaveProperty("properties.outputSchema.type", "object");
  expect(tool.parameters).not.toHaveProperty("properties.outputSchema.patternProperties");
}
function expectSpawned(details: Record<string, unknown>) {
  expect(spawn).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining(details),
    expect.anything(),
  );
}

beforeEach(() => {
  spawn.mockReset().mockResolvedValue({
    status: "accepted",
    childSessionKey: "agent:main:subagent:child",
    runId: "child",
    context: "isolated",
  });
});

describe("execution allowlist availability", () => {
  const sparseAllow: string[] = [];
  sparseAllow.length = 1;
  it.each<[string, string[], string[]]>([
    ["aliases", [" BASH ", "apply-PATCH", " CRON "], ["exec", "apply_patch", "automations"]],
    ["blank names", [" \t "], ["", "   "]],
    ["literal names", ["write", "web_*", "*", "group:fs"], ["WRITE", "web_*", "*", "group:fs"]],
    ["empty list", [], []],
    ["sparse list", sparseAllow, []],
  ])("prepares callable tools from frozen %s", (_label, allow, expected) => {
    const tools = [
      ..."exec,apply_patch,automations,WRITE,read,web_fetch,web_*,*,group:fs".split(","),
      "",
      "   ",
    ].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));
    let callableNames: string[] = [];
    bindAgentToolAvailability(tools[0]!, {
      prepare: (_tool, callableTools) => {
        callableNames = [...callableTools.keys()];
      },
    });

    finalize(tools, { toolExecutionAllow: Object.freeze(allow) });

    expect(callableNames).toEqual(expected);
  });
});

describe("collector tool availability", () => {
  it("rechecks execution caps on catalog restriction and rebuild", async () => {
    const allow = ["sessions_spawn", "agents_wait"];
    const { tool, params, catalogRef, apply } = catalogFixture(reader(), allow);
    const expectUnavailable = async () => {
      await expectCollectionDenied(tool);
      expect(tool.parameters).toHaveProperty("properties.collect");
    };
    apply();
    expect(tool.parameters).toHaveProperty("properties.collect");

    allow[1] = "read";
    restrictCatalog({
      catalogRef,
      allowedToolNames: new Set(["sessions_spawn", "agents_wait"]),
    });
    await expectUnavailable();

    allow[1] = "agents_wait";
    apply();
    expect(tool.parameters).toHaveProperty("properties.collect");

    params.toolExecutionAllow = ["sessions_spawn", "read"];
    apply();
    await expectUnavailable();
  });
  it("reuses immutable schema variants without sharing collector authority", async () => {
    const first = spawnTool();
    const second = spawnTool();
    expect(second.parameters).toBe(first.parameters);

    finalize([first, reader()]);
    finalize([second, reader()]);
    expect(second.parameters).toBe(first.parameters);
    expect(first.parameters).toHaveProperty("properties.collect");

    finalize([first]);
    expect(first.parameters).not.toHaveProperty("properties.collect");
    await expectCollectionDenied(first);
    await collect(second, "allowed");
    expectSpawned({ collect: true });
  });

  it("preserves normalized collector fields across availability changes", () => {
    const source = spawnTool();
    const wait = reader();
    finalize([source, wait]);
    const [normalized] = finalizeAgentTools({
      tools: [source, wait],
      modelProvider: "google",
      hookContext: {},
      wrapBeforeToolCallHook: false,
    });
    assert.ok(normalized);

    finalize([normalized, wait]);
    expectNormalizedCollector(normalized);

    finalize([normalized]);
    expect(normalized.parameters).not.toHaveProperty("properties.outputSchema");
    const wrapped = wrapHook(normalized);
    finalize([wrapped, wait]);
    expectNormalizedCollector(wrapped);
  });

  it.each(["missing", "lookalike", "quarantined", "denied", "execution-denied"] as const)(
    "refuses a %s reader but preserves ordinary spawning and fastMode",
    async (kind) => {
      const tool = spawnTool();
      const wait = reader();
      const candidate = kind === "lookalike" ? { ...wait } : wait;
      if (kind === "quarantined") {
        candidate.parameters = { type: "array", items: { type: "string" } };
      }
      if (kind === "execution-denied") {
        denyExecution(candidate);
      }
      finalize(
        [tool, ...(kind === "missing" ? [] : [candidate])],
        kind === "denied" ? { toolExecutionAllow: ["sessions_spawn"] } : undefined,
      );
      expectCollection(tool, kind === "denied" || kind === "execution-denied");
      await expectCollectionDenied(tool, "collect", {
        [SWARM_CODE_MODE_IDEMPOTENCY_KEY]: "copied",
      });
      await tool.execute("ordinary", { task: "inspect", fastMode: "auto" });
      expectSpawned({ collect: undefined, fastMode: "auto", expectsCompletionMessage: true });
    },
  );

  it.each([
    { boundary: "reuse", readerState: "same-object-denied" },
    { boundary: "reuse", readerState: "denied-wrapper" },
    { boundary: "reuse", readerState: "lookalike" },
    { boundary: "restriction", readerState: "same-object-denied" },
  ] as const)(
    "revokes collection after $boundary with $readerState despite unchanged descriptors",
    async ({ boundary, readerState }) => {
      const { tool, catalogRef, apply: compact, wait } = catalogFixture(wrapHook(reader()));
      compact(wait);
      const firstCatalog = catalogRef.current!;
      const firstEntries = firstCatalog.entries;
      const allowedToolNames = new Set(firstEntries.map((entry) => entry.name));
      expect(tool.parameters).toHaveProperty("properties.collect");
      if (boundary === "reuse") {
        expect(compact(wait).catalogReused).toBe(true);
      } else {
        expect(restrictCatalog({ catalogRef, allowedToolNames })).toBe(2);
      }

      const currentReader =
        readerState === "lookalike"
          ? { ...wait }
          : readerState === "denied-wrapper"
            ? denyExecution(deniedCopy(wait, "executor denied"))
            : denyExecution(wait);
      if (boundary === "reuse") {
        compact(currentReader);
      } else {
        restrictCatalog({ catalogRef, allowedToolNames });
      }

      // Exercise the real spawn guard before schema assertions can hide an admitted child.
      await expectCollectionDenied(tool, "collect-after-revocation");
      expect(
        firstEntries.find((item) => item.name === "sessions_spawn")?.parameters,
      ).toHaveProperty("properties.collect");
      const entry = catalogRef.current?.entries.find((item) => item.name === "sessions_spawn");
      const offered = readerState !== "lookalike";
      expectCollection(tool, offered);
      expectCollection({ parameters: entry?.parameters, description: entry?.description }, offered);
    },
  );

  it("preserves binding and later denial across hook rebuilds and metadata copies", async () => {
    const wrapped = rewrapHook(wrapHook(spawnTool()));
    const wait = rewrapHook(wrapHook(reader()));
    const denied = deniedCopy(wrapped, "later executor policy");
    const executor = denied.execute;
    finalize([denied, wait]);
    expect(denied.parameters).toHaveProperty("properties.collect");
    expect(denied.execute).toBe(executor);
    await expect(collect(denied, "denied")).rejects.toThrow("later executor policy");
    expect(spawn).not.toHaveBeenCalled();
    await collect(wrapped, "allowed");
    expect(spawn).toHaveBeenCalledOnce();
    finalize([denied]);
    await expect(collect(wrapped, "narrowed")).rejects.toThrow("Collector results are unavailable");
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("cannot reactivate a closed generation through copied definitions", async () => {
    const controller = new AbortController();
    const old = wrapToolWithAbortSignal(spawnTool(controller.signal), controller.signal);
    const retained = copyMetadata(old, { ...old });
    finalize([retained, reader()]);
    controller.abort(new Error("generation closed"));
    finalize([retained, reader()]);
    await expect(collect(retained, "stale")).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    const current = spawnTool();
    finalize([current, reader()]);
    await collect(current, "current");
    expect(spawn).toHaveBeenCalledOnce();
  });
  it("does not override an explicit Swarm opt-out when a native reader is supplied", async () => {
    const tool = createSessionsSpawnTool({ config: { ...config, tools: { swarm: false } } });
    finalize([tool, reader()]);
    for (const field of ["collect", "fastMode"]) {
      expect(tool.parameters).not.toHaveProperty(`properties.${field}`);
    }
    await expect(collect(tool, "disabled")).rejects.toThrow("tools.swarm.enabled=true");
    expect(spawn).not.toHaveBeenCalled();
  });
});
