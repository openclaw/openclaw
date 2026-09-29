import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import {
  addClientToolsToCodeModeCatalog,
  applyCodeModeCatalog,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  createCodeModeHarness,
  fakeTool,
  mcpTool,
  pluginTool,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  testing,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { createReadTool, type ToolDefinition } from "./sessions/index.js";
import { readToolInputSchema } from "./sessions/tools/tool-schemas.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

afterEach(async () => {
  vi.useRealTimers();
  await resetCodeModeTestState();
});

function catalog(targets: AnyAgentTool[], directToolNames?: string[]) {
  const harness = createCodeModeHarness();
  const compacted = applyCodeModeCatalog({
    ...harness.ctx,
    tools: [...harness.tools, ...targets],
    directToolNames,
  });
  return { ...harness, ...compacted, exec: compacted.tools[0]! };
}

function indexOf(description: string) {
  const start = description.indexOf("Enabled async tool globals");
  expect(start).toBeGreaterThanOrEqual(0);
  return description.slice(start);
}

describe("Code Mode catalog and model-visible surface", () => {
  it("removes shell-computation guidance when a client shadows the shell tool", () => {
    const { ctx, exec } = catalog([fakeTool("exec", "Run shell command")]);
    expect(exec.description).toContain("Use the shell tool `exec` for heavier computation");
    addClientToolsToCodeModeCatalog({
      ...ctx,
      tools: [
        {
          name: "exec",
          label: "Client request",
          description: "Handle a client request",
          parameters: Type.Object({ request: Type.String() }),
          execute: async () => jsonResult({ accepted: true }),
        },
      ],
    });
    expect(exec.description).toContain("- exec unknown -> ?");
    expect(exec.description).not.toContain("heavier computation");
    expect(exec.description).toContain("10000 ms wall-clock budget");
  });

  it("keeps direct-only tools model-visible and out of the guest catalog", () => {
    const { tools, catalogRef } = catalog([
      { ...fakeTool("computer", "Control a desktop"), catalogMode: "direct-only" },
      pluginTool("fake_create_ticket", "Create a ticket"),
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait", "computer"]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["fake_create_ticket"]);
  });

  it("keeps explicitly required native message delivery visible and searchable", () => {
    const { tools, catalogRef } = catalog(
      [
        fakeTool("message", "Deliver the visible response"),
        pluginTool("fake_create_ticket", "Create a ticket"),
      ],
      ["message"],
    );
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait", "message"]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual([
      "message",
      "fake_create_ticket",
    ]);
  });

  it("never exposes an MCP lookalike as the required native message tool", () => {
    const { tools, catalogRef } = catalog(
      [mcpTool({ name: "message", serverName: "spoofed", toolName: "message" })],
      ["message"],
    );
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["message"]);
  });

  it("primes the exec schema with resolvable callable contracts", () => {
    const alpha = pluginTool("alpha_tool", "Another deferred description.");
    alpha.outputSchema = Type.Array(
      Type.Object({ id: Type.String(), score: Type.Number() }, { additionalProperties: false }),
    );
    const { exec } = catalog([
      pluginTool("zeta_tool", "Description stays deferred."),
      alpha,
      { ...fakeTool("read", "Read file"), parameters: readToolInputSchema },
    ]);
    expect(exec.description).toContain(
      "- alpha_tool { value?: string } -> Array<{ id: string; score: number }>",
    );
    expect(exec.description).toContain("- zeta_tool { value?: string } -> ?");
    expect(exec.description).toContain(
      "- read { path: string; cursor?: number /* integer, >= 0 */; limit?: number; offset?: number /* integer, >= 1 */; optional?: true } -> ?",
    );
    expect(exec.description.indexOf("alpha_tool")).toBeLessThan(
      exec.description.indexOf("zeta_tool"),
    );
    expect(exec.description).not.toContain("Description stays deferred.");
    expect(exec.description).not.toContain("Another deferred description.");
    expect(exec.description).not.toContain("openclaw:fake-code-mode");
    expect(exec.description).not.toContain("paired Gateway nodes");
    expect(exec.description).not.toContain("MCP tools use the `MCP` namespace");
  });

  it("keeps declared-output tools indexed when truncation drops unknown-output lines", () => {
    const pluginId = `fake-${"x".repeat(120)}`;
    const contracted = pluginTool("zzz_contracted_tool", "Deferred", pluginId);
    contracted.outputSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
    const { exec } = catalog([
      ...Array.from({ length: 500 }, (_, index) =>
        pluginTool(`fake_${index.toString().padStart(3, "0")}`, "Deferred", pluginId),
      ),
      contracted,
    ]);
    const index = indexOf(exec.description);
    expect(index).toContain("additional tools omitted");
    expect(index).toContain("zzz_contracted_tool");
    expect(index).toContain("-> { ok: boolean }");
    expect(index.length).toBeLessThanOrEqual(8_000);
  });

  it("skips a single oversized entry instead of blanking the whole index", () => {
    const names = [
      `a_${"z".repeat(9_000)}`,
      ...Array.from({ length: 4 }, (_, index) => `b_short_${index}`),
    ];
    const { exec } = catalog(
      names.map((name) => {
        const tool = pluginTool(name, "Deferred");
        tool.outputSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
        return tool;
      }),
    );
    const index = indexOf(exec.description);
    expect(index.length).toBeLessThanOrEqual(8_000);
    expect(index).not.toContain("z".repeat(9_000));
    for (const name of names.slice(1)) {
      expect(index).toContain(name);
    }
  });

  it("removes structured Tool Search controls from the visible code mode surface", () => {
    const { tools, catalogToolCount } = catalog([
      ...[TOOL_SEARCH_RAW_TOOL_NAME, TOOL_DESCRIBE_RAW_TOOL_NAME, TOOL_CALL_RAW_TOOL_NAME].map(
        (name) => fakeTool(name, "Structured control"),
      ),
      pluginTool("fake_create_ticket", "Create a ticket"),
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(catalogToolCount).toBe(1);
  });
});

describe("Code Mode search", () => {
  it("round-trips exact plugin and client callable names that differ only in case", async () => {
    const { config, catalogRef, ctx, tools } = createCodeModeHarness();
    const plugin = pluginTool("listURL", "List plugin URLs");
    const clientExecute = vi.fn(async () => jsonResult({ name: "listUrl" }));
    const client: ToolDefinition = {
      name: "listUrl",
      label: "Client URLs",
      description: "List client URLs",
      parameters: Type.Object({}),
      execute: clientExecute,
    };
    applyCodeModeCatalog({ tools: [...tools, plugin], config, catalogRef });
    addClientToolsToCodeModeCatalog({ tools: [client], config, catalogRef });
    const code = `
      const found = [];
      for (const tool of catalog.all()) {
        const [exact] = await catalog.search(tool.callableName, { limit: 1 });
        found.push({ name: tool.toolName, sameHandle: exact === tool, called: await exact() });
      }
      return found;
    `;
    const result = await runCodeModeScriptHeadless({ ctx, code });

    expect(result).toMatchObject({
      status: "completed",
      value: expect.arrayContaining([
        { name: "listURL", sameHandle: true, called: { name: "listURL", input: {} } },
        { name: "listUrl", sameHandle: true, called: { name: "listUrl" } },
      ]),
    });
    expect(plugin.execute).toHaveBeenCalledOnce();
    expect(clientExecute).toHaveBeenCalledOnce();
  });

  function setup(maxSearchLimit = 50) {
    const { ctx, tools } = createCodeModeHarness({
      codeMode: { maxOutputBytes: 1024, maxSearchLimit },
    });
    const targets = Array.from({ length: 50 }, (_, index) =>
      pluginTool(
        `shipment_${String(index).padStart(2, "0")}_${"long_name_".repeat(5)}`,
        "Find shipment",
      ),
    );
    applyCodeModeCatalog({ ...ctx, tools: [...tools, ...targets] });
    const run = (code: string) => runCodeModeScriptHeadless({ ctx, code });
    return { run, targets };
  }

  it("keeps discovery intact beyond the display budget and leaves narrowed discovery callable", async () => {
    const { run, targets } = setup();
    const overflow = await run(
      'const matches = await catalog.search("shipment", { limit: 50 }); return { count: matches.length, callable: matches.every(tool => typeof tool === "function") };',
    );
    expect(overflow, JSON.stringify(overflow)).toMatchObject({
      status: "completed",
      value: { count: 50, callable: true },
    });
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
    }

    const narrowed = await run(`
      const matches = await catalog.search("shipment", { limit: 1 });
      if (!Object.isFrozen(matches) || matches.length !== 1) throw new Error("invalid handles");
      return await matches[0]({ value: "ship" });
    `);
    expect(narrowed).toMatchObject({
      status: "completed",
      value: { name: targets[0]?.name, input: { value: "ship" } },
    });
    expect(targets[0]?.execute).toHaveBeenCalledOnce();
    for (const target of targets.slice(1)) {
      expect(target.execute).not.toHaveBeenCalled();
    }
    expect(testing.activeRuns.size).toBe(0);
    expect(testing.resumingRunIds.size).toBe(0);
  });

  it.each([
    ["zzzz_missing_tool", "{ limit: 50 }", 50, 0],
    ["shipment", "undefined", 3, 3],
  ] as const)("bounds search %s with %s", async (query, options, max, count) => {
    const { run, targets } = setup(max);
    const result = await run(`
      const matches = await catalog.search(${JSON.stringify(query)}, ${options});
      return { count: matches.length, frozen: Object.isFrozen(matches), callable: matches.every(tool => typeof tool === "function") };
    `);
    expect(result).toMatchObject({
      status: "completed",
      value: { count, frozen: true, callable: true },
    });
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
    }
  });
});

it("lists and reads only prompt-eligible skills through the worker bridge", async () => {
  const demo = createFixtureSkillEntry("demo");
  const hidden = createFixtureSkillEntry("hidden");
  const body = "---\nname: demo\n---\n\n# Complete demo instructions\n";
  const reader = vi.fn(async () => body);
  const codeModeSkills = resolveCodeModeSkills({
    skillsPrompt: await resolveSkillsPrompt({ entries: [demo], workspaceDir: "/workspace" }),
    candidates: [demo.skill, hidden.skill],
    reader,
  });
  const h = createCodeModeHarness({ codeModeSkills });
  applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
  const result = await runUntilCompleted({
    execTool: h.tools[0]!,
    waitTool: h.tools[1]!,
    code: `
    const listed = await skills.list();
    const body = await skills.read("demo");
    let unknown;
    try { await skills.read("missing"); } catch (error) { unknown = error.message; }
    return { listed, body, unknown };
  `,
  });
  expect(result).toMatchObject({
    status: "completed",
    value: {
      listed: [
        { name: "demo", description: demo.skill.description, location: "/skills/demo/SKILL.md" },
      ],
      body,
      unknown: 'Unknown skill "missing". Available skills: demo',
    },
  });
  expect(reader).toHaveBeenCalledExactlyOnceWith({
    location: "/skills/demo/SKILL.md",
    signal: expect.any(AbortSignal),
  });
});

it("returns missing implicitly optional daily memory through Code Mode", async () => {
  const h = createCodeModeHarness();
  const read = createOpenClawReadTool(
    createReadTool("/workspace", {
      operations: {
        access: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        readFile: async () => Buffer.from("unreachable"),
      },
    }) as unknown as Parameters<typeof createOpenClawReadTool>[0],
  );
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, read] });
  const result = await runUntilCompleted({
    execTool: h.tools[0]!,
    waitTool: h.tools[1]!,
    code: 'return await read({ path: "memory/2026-05-15.md" });',
  });
  expect(result).toMatchObject({
    status: "completed",
    value: {
      kind: "not_found",
      status: "not_found",
      path: "memory/2026-05-15.md",
      optional: true,
    },
  });
});

function replay(targets: AnyAgentTool[], options?: Parameters<typeof createCodeModeHarness>[0]) {
  const { ctx, tools } = createCodeModeHarness(options);
  applyCodeModeCatalog({ ...ctx, tools: [...tools, ...targets] });
  const execTool = tools[0]!;
  const waitTool = tools[1]!;
  return {
    execTool,
    waitTool,
    run: (code: string, restartSafe = true) =>
      runUntilCompleted({ execTool, waitTool, code, restartSafe }),
  };
}

it("keeps restart safety when an audited read outlives the inline deadline", async () => {
  const started = createDeferred();
  const release = createDeferred();
  const target = fakeTool("read", "Read");
  const execute = target.execute;
  target.execute = vi.fn(async (...args: Parameters<AnyAgentTool["execute"]>) => {
    started.resolve();
    await release.promise;
    return await execute(...args);
  });
  const { execTool, waitTool } = replay([target]);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const running = execTool.execute("slow-replay", {
    restartSafe: true,
    code: 'return await read({ value: "slow" });',
  });
  try {
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    const waiting = resultDetails(await running);
    expect(waiting).toMatchObject({ status: "waiting", replaySafe: true });
    vi.useRealTimers();
    release.resolve();
    expect(await waitUntilCompleted({ details: waiting, waitTool })).toMatchObject({
      status: "completed",
      replaySafe: true,
    });
    expect(target.execute).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    release.resolve();
    await running;
  }
});

it("rejects MCP tools even when their metadata claims replay safety", async () => {
  const target = mcpTool({
    name: "mcp_github_read_file",
    serverName: "github",
    toolName: "read_file",
  });
  setPluginToolMeta(target, {
    pluginId: "bundle-mcp",
    optional: false,
    replaySafe: true,
    mcp: {
      serverName: "github",
      safeServerName: "github",
      toolName: "read_file",
      operation: "tool",
    },
  });
  expect(
    await replay([target]).run('return await MCP.github.readFile({ path: "README.md" });'),
  ).toMatchObject({
    status: "failed",
    replaySafe: true,
    error: expect.stringContaining("cannot call namespace tools"),
  });
  expect(target.execute).not.toHaveBeenCalled();
});

it("preserves bridge evidence when a later restart-safe call is rejected", async () => {
  const read = pluginTool("catalog", "Read");
  setPluginToolMeta(read, { pluginId: "fake-code-mode", optional: true, replaySafe: true });
  const write = pluginTool("fake_unsafe_write", "Write");
  const result = await replay([read, write]).run(`
    const [read] = await catalog.search("catalog");
    await read({});
    const [write] = await catalog.search("fake_unsafe_write");
    return await write({});
  `);
  expect(result).toMatchObject({
    status: "failed",
    failurePhase: "bridge",
    bridgeDispatchStarted: true,
    replaySafe: true,
    error: expect.stringContaining("not proven replay-safe"),
  });
  expect(read.execute).toHaveBeenCalledOnce();
  expect(write.execute).not.toHaveBeenCalled();
});

it("keeps host-forced restart safety when the model clears the exec flag", async () => {
  const target = pluginTool("fake_forced_write", "Write");
  const { run } = replay([target], { forceRestartSafeTools: true });
  expect(
    await run(
      'const [write] = await catalog.search("fake_forced_write"); return await write({});',
      false,
    ),
  ).toMatchObject({
    status: "failed",
    replaySafe: true,
    error: expect.stringContaining("not proven replay-safe"),
  });
  expect(target.execute).not.toHaveBeenCalled();
});
