import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import * as diagnostics from "../logging/code-mode-diagnostic.js";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import { bindCodeModeSessionStore } from "./code-mode-session-store.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import { controlledTool } from "./code-mode.controlled-tool.test-support.js";
import {
  applyCodeModeCatalog,
  buildCodeModeCatalogPrompt,
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
  createHeadlessCodeModeHarness,
  codeModeRunner,
  expectCompleted,
  expectToolCalls,
  expectFailure,
  createCatalogCodeModeHarness,
  jsonTool,
} from "./code-mode.test-support.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";
import { createReadTool } from "./sessions/index.js";
import { SessionManager } from "./sessions/session-manager.js";
import { readToolInputSchema } from "./sessions/tools/tool-schemas.js";
import { filterToolsByPolicy } from "./tool-policy-match.js";
import { addClientToolsToToolCatalog, restrictToolSearchCatalog } from "./tool-search-catalog.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { createToolSurfacePresentationForTest } from "./tool-surface-plan.test-support.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

afterEach(async () => {
  vi.useRealTimers();
  consumeRunSkillUsage("run-code-mode");
  vi.restoreAllMocks();
  for (const ctx of catalogs.splice(0)) {
    clearToolSearchCatalog(ctx);
  }
  await resetCodeModeTestState();
});

function catalog(targets: AnyAgentTool[], directToolNames?: string[]) {
  const harness = createCodeModeHarness();
  const compacted = applyCodeModeCatalog({
    ...harness.ctx,
    tools: [...harness.tools, ...targets],
    directToolNames,
  });
  return {
    ...harness,
    ...compacted,
    exec: compacted.tools[0]!,
    catalogPrompt: () =>
      buildCodeModeCatalogPrompt(harness.ctx, harness.catalogRef.current?.entries ?? []),
  };
}

function complete(tools: AnyAgentTool[], code: string) {
  return runUntilCompleted({
    execTool: tools.find((tool) => tool.name === "exec")!,
    waitTool: tools.find((tool) => tool.name === "wait")!,
    code,
  });
}

function markReplaySafe(tool: AnyAgentTool) {
  setPluginToolMeta(tool, { ...getPluginToolMeta(tool)!, replaySafe: true });
  return tool;
}

function contractedTool(name: string, pluginId?: string) {
  return Object.assign(pluginTool(name, "Deferred", pluginId), {
    outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
  });
}

function skillBody(location: string, content: string) {
  return `Skill location: ${location}\nResolve relative resource paths from the directory containing this SKILL.md.\n\n${content}`;
}

describe("Code Mode catalog and model-visible surface", () => {
  it("refreshes guest metadata after catalog replacement and restriction", async () => {
    const { ctx, tools, exec } = catalog([fakeTool("lookup", "Original metadata")]);
    const read = () => exec.execute("metadata", { code: "return catalog.all();" });
    for (let i = 0; i < 2; i++) {
      expect(resultDetails(await read()).value).toEqual([
        expect.objectContaining({ callableName: "lookup", description: "Original metadata" }),
      ]);
    }
    applyCodeModeCatalog({ ...ctx, tools: [...tools, fakeTool("lookup", "Updated metadata")] });
    expect(resultDetails(await read()).value).toEqual([
      expect.objectContaining({ callableName: "lookup", description: "Updated metadata" }),
    ]);
    restrictToolSearchCatalog({ ...ctx, allowedToolNames: new Set() });
    expect(resultDetails(await read()).value).toEqual([]);
  });

  it("removes shell-computation guidance when a client shadows the shell tool", () => {
    const { ctx, exec, catalogPrompt } = catalog([fakeTool("exec", "Run shell command")]);
    const description = exec.description;
    expect(catalogPrompt()).toContain("Use the shell tool `exec` for heavier computation");
    addClientToolsToToolCatalog({
      enabled: true,
      ...ctx,
      tools: [
        {
          ...fakeTool("exec", "Handle a client request"),
          parameters: Type.Object({ request: Type.String() }),
          execute: async () => jsonResult({ accepted: true }),
        },
      ],
    });
    expect(catalogPrompt()).toContain("- exec unknown -> ?");
    expect(catalogPrompt()).not.toContain("heavier computation");
    expect(exec.description).toBe(description);
    expect(exec.description).toContain("10000 ms wall-clock budget");
  });

  it.each([
    { kind: "direct-only", visible: ["computer"], indexed: ["fake_create_ticket"] },
    { kind: "required native", visible: ["message"], indexed: ["message", "fake_create_ticket"] },
    { kind: "MCP lookalike", visible: [], indexed: ["message"] },
  ])("keeps $kind visibility separate from guest discovery", ({ kind, visible, indexed }) => {
    const targets =
      kind === "MCP lookalike"
        ? [mcpTool({ name: "message", serverName: "spoofed", toolName: "message" })]
        : [
            kind === "direct-only"
              ? {
                  ...fakeTool("computer", "Control a desktop"),
                  catalogMode: "direct-only" as const,
                }
              : fakeTool("message", "Deliver the visible response"),
            pluginTool("fake_create_ticket", "Create a ticket"),
          ];
    const { tools, catalogRef } = catalog(
      targets,
      kind === "direct-only" ? undefined : ["message"],
    );
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait", ...visible]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(indexed);
  });

  it("includes resolvable callable contracts in the catalog prompt", async () => {
    const alpha = pluginTool("alpha_tool", "Another deferred description.");
    alpha.outputSchema = Type.Array(
      Type.Object({ id: Type.String(), score: Type.Number() }, { additionalProperties: false }),
    );
    const incomplete = pluginTool("incomplete_tool", "Use schedule to start the source.");
    incomplete.parameters = Type.Object({
      job: Type.Object({
        ...Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [
            `metadata_${String(index).padStart(2, "0")}`,
            Type.Optional(Type.String()),
          ]),
        ),
        schedule: Type.Optional(Type.Object({ kind: Type.Literal("stream") })),
      }),
    });
    const { catalogPrompt, ctx } = catalog([
      incomplete,
      pluginTool("zeta_tool", "Description stays deferred."),
      alpha,
      { ...fakeTool("read", "Read file"), parameters: readToolInputSchema },
    ]);
    const prompt = catalogPrompt();
    for (const fragment of [
      "- alpha_tool { value?: string } -> Array<{ id: string; score: number }>",
      "- zeta_tool { value?: string } -> ?",
      "- read { path: string; cursor?: number /* integer, >= 0 */; limit?: number; offset?: number /* integer, >= 1 */; optional?: true } -> ?",
    ]) {
      expect(prompt).toContain(fragment);
    }
    for (const fragment of [
      "Description stays deferred.",
      "openclaw:fake-code-mode",
      "paired Gateway nodes",
      "MCP tools use the `MCP` namespace",
    ]) {
      expect(prompt).not.toContain(fragment);
    }
    expect(prompt.indexOf("alpha_tool")).toBeLessThan(prompt.indexOf("zeta_tool"));
    const incompleteLine = prompt.split("\n").find((line) => line.startsWith("- incomplete_tool "));
    expect(incompleteLine).toContain("...");
    expect(incompleteLine).not.toContain("schedule");
    expect(prompt).toContain(
      "If an input hint leaves needed arguments unclear (`...` or `unknown`), read `await callableName.describe()`",
    );
    expect(prompt).toContain("Call globals directly when their input contract is clear");
    const described = await runCodeModeScriptHeadless({
      ctx,
      code: "return await incomplete_tool.describe();",
    });
    expect(described).toMatchObject({
      status: "completed",
      value: {
        description: "Use schedule to start the source.",
        parameters: {
          properties: {
            job: { properties: { schedule: { properties: { kind: { const: "stream" } } } } },
          },
        },
      },
    });
    expect(incomplete.execute).not.toHaveBeenCalled();
  });

  function catalogIndex(targets: AnyAgentTool[]) {
    const prompt = catalog(targets).catalogPrompt();
    const index = prompt.slice(prompt.indexOf("Enabled async tool globals"));
    expect(index.length).toBeLessThanOrEqual(8_000);
    return index;
  }

  it("keeps declared-output tools indexed when truncation drops unknown-output lines", () => {
    const pluginId = `fake-${"x".repeat(120)}`;
    const index = catalogIndex([
      ...Array.from({ length: 500 }, (_, position) =>
        pluginTool(`fake_${position.toString().padStart(3, "0")}`, "Deferred", pluginId),
      ),
      contractedTool("zzz_contracted_tool", pluginId),
    ]);
    for (const fragment of [
      "additional tools omitted",
      "zzz_contracted_tool",
      "-> { ok: boolean }",
    ]) {
      expect(index).toContain(fragment);
    }
  });

  it("skips a single oversized entry instead of blanking the whole index", () => {
    const shortNames = Array.from({ length: 4 }, (_, index) => `b_short_${index}`);
    const index = catalogIndex(
      [`a_${"z".repeat(9_000)}`, ...shortNames].map((name) => contractedTool(name)),
    );
    expect(index).not.toContain("z".repeat(9_000));
    for (const name of shortNames) {
      expect(index).toContain(name);
    }
  });
});

describe("Code Mode search", () => {
  it("round-trips exact plugin and client callable names that differ only in case", async () => {
    const plugin = pluginTool("listURL", "List plugin URLs");
    const client = { ...jsonTool("listUrl", { name: "listUrl" }), parameters: Type.Object({}) };
    const { ctx, catalogRef } = createCatalogCodeModeHarness([plugin]);
    addClientToolsToToolCatalog({ tools: [client], enabled: true, catalogRef });
    const code = `
      const found = [];
      for (const tool of catalog.all()) {
        const [exact] = await catalog.search(tool.callableName, { limit: 1 });
        found.push({ name: tool.toolName, sameHandle: exact === tool, called: await exact() });
      }
      return found;
    `;
    const result = await runCodeModeScriptHeadless({ ctx, code });

    expectCompleted(
      result,
      expect.arrayContaining([
        { name: "listURL", sameHandle: true, called: { name: "listURL", input: {} } },
        { name: "listUrl", sameHandle: true, called: { name: "listUrl" } },
      ]),
    );
    expectToolCalls(1, plugin, client);
  });

  function setup(maxSearchLimit = 50) {
    const targets = Array.from({ length: 50 }, (_, index) =>
      pluginTool(
        `shipment_${String(index).padStart(2, "0")}_${"long_name_".repeat(5)}`,
        "Find shipment",
      ),
    );
    const { ctx } = createCatalogCodeModeHarness(targets, {
      codeMode: { maxOutputBytes: 1024, maxSearchLimit },
    });
    const run = (code: string) => runCodeModeScriptHeadless({ ctx, code });
    return { run, targets };
  }

  it("keeps discovery intact beyond the display budget and leaves narrowed discovery callable", async () => {
    const { run, targets } = setup();
    const overflow = await run(
      'const matches = await catalog.search("shipment", { limit: 50 }); return { count: matches.length, callable: matches.every(tool => typeof tool === "function") };',
    );
    expectCompleted(overflow, { count: 50, callable: true });
    expectToolCalls(0, ...targets);

    const narrowed = await run(`
      const matches = await catalog.search("shipment", { limit: 1 });
      if (!Object.isFrozen(matches) || matches.length !== 1) throw new Error("invalid handles");
      return await matches[0]({ value: "ship" });
    `);
    expectCompleted(narrowed, { name: targets[0]?.name, input: { value: "ship" } });
    expect(targets[0]?.execute).toHaveBeenCalledOnce();
    expectToolCalls(0, ...targets.slice(1));
    expect(testing.activeRuns.size).toBe(0);
    expect(testing.resumingRunIds.size).toBe(0);
  });

  it("returns no callable matches for an unknown tool", async () => {
    const { run, targets } = setup();
    const result = await run(`
      const matches = await catalog.search("zzzz_missing_tool", { limit: 50 });
      return { count: matches.length, frozen: Object.isFrozen(matches), callable: matches.every(tool => typeof tool === "function") };
    `);
    expectCompleted(result, { count: 0, frozen: true, callable: true });
    expectToolCalls(0, ...targets);
  });
});

it("records Code Mode skills.read of a workshop skill as run usage and skill.used", async () => {
  const learned = createFixtureSkillEntry("learned", { source: "openclaw-workshop" });
  const codeModeSkills = resolveCodeModeSkills({
    skillsPrompt: await resolveSkillsPrompt({ entries: [learned], workspaceDir: "/workspace" }),
    candidates: [learned.skill],
    reader: async () => "# Learned instructions\n",
  });
  const used: Array<{ event: DiagnosticEventPayload; skillFile?: string }> = [];
  const stop = onTrustedInternalDiagnosticEvent(
    (event, _metadata, privateData) => {
      used.push({ event, skillFile: privateData.skillUsage?.skillFile });
    },
    { include: ["skill.used"] },
  );
  try {
    // Production catalogs hold hook-wrapped tools; the wrapper owns skill usage recording.
    const hookCtx = {
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "learned" }],
        resolvedSkills: [learned.skill],
      },
    };
    const h = createCatalogCodeModeHarness(
      createInstalledSkillTools(codeModeSkills).map((tool) =>
        wrapToolWithBeforeToolCallHook(tool, hookCtx),
      ),
      { agentId: "main", codeModeSkills },
    );
    const result = await h.complete('return await skills.read("learned");');
    expectCompleted(result, skillBody("/skills/learned/SKILL.md", "# Learned instructions\n"));
    expect(consumeRunSkillUsage("run-code-mode")).toEqual([
      {
        name: "learned",
        source: "workspace",
        activation: "read",
        skillFile: "/skills/learned/SKILL.md",
      },
    ]);
    await vi.waitFor(() => expect(used).toHaveLength(1));
    expect(used[0]).toEqual({
      event: expect.objectContaining({
        type: "skill.used",
        runId: "run-code-mode",
        sessionKey: "agent:main:main",
        agentId: "main",
        skillName: "learned",
        skillSource: "workspace",
        activation: "read",
      }),
      skillFile: "/skills/learned/SKILL.md",
    });
  } finally {
    stop();
  }
});
it.for(["transported", "skills_read", "skills_search", "shadowed", "revoked"] as const)(
  "keeps disk-backed skill discovery within the harness read authority: %s",
  async (scenario, { signal: testSignal }) =>
    withTempDir("code-mode-skill-authority-", async (dir) => {
      const denied = scenario === "transported" ? undefined : scenario;
      const filePath = path.join(dir, "SKILL.md");
      const identity = { name: "guide", description: "Guide", location: filePath };
      await writeFile(filePath, "Private instructions");
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      let reads = 0;
      const skills = [
        {
          ...identity,
          source: { filePath },
          readSearchContent: async (maxBytes: number) => {
            reads += 1;
            const content = (await readLocalFileSafely({ filePath, maxBytes })).buffer.toString(
              "utf8",
            );
            readStarted.resolve();
            if (denied === "revoked") {
              await releaseRead.promise;
            }
            return content;
          },
        },
      ];
      const skillTools = createInstalledSkillTools(skills);
      let effectiveTools = skillTools.filter((tool) => tool.name !== denied);
      if (denied === "shadowed") {
        effectiveTools = effectiveTools.map((tool) =>
          tool.name === "skills_read"
            ? {
                ...tool,
                execute: async () => {
                  throw new Error("Shadowed reader");
                },
              }
            : tool,
        );
      }
      const runtime = createAgentHarnessToolSurfaceRuntimeCore({
        config: {
          agents: { defaults: { experimental: { localModelLean: false } } },
          tools: { codeMode: true, toolSearch: false },
        },
        presentation:
          scenario === "transported"
            ? {
                ...createToolSurfacePresentationForTest({
                  tools: { codeMode: true, toolSearch: false },
                }),
                skills: [identity],
              }
            : undefined,
        modelToolsEnabled: true,
        executeTool: async ({ toolName, toolCallId, input, signal, onUpdate }) => {
          const tool = effectiveTools.find((candidate) => candidate.name === toolName);
          if (!tool) {
            throw new Error(`Unknown native skill tool: ${toolName}`);
          }
          return tool.execute(toolCallId, input, signal, onUpdate);
        },
      });
      try {
        const compact = (transported = false) =>
          runtime.compactTools(effectiveTools, {
            prepared: {
              codeModeSkills: transported ? undefined : skills,
              preserveToolNames: [],
            },
          });
        const surface = compact(scenario === "transported");
        const catalogPrompt = buildCodeModeCatalogPrompt(
          { config: runtime.config },
          runtime.toolSearchCatalogRef?.current?.entries ?? [],
        );
        expect(catalogPrompt.includes("skills.search(")).toBe(denied !== "skills_search");
        expect(catalogPrompt.includes("skills.list(")).toBe(denied !== "skills_search");
        expect(catalogPrompt.includes("skills.read(")).toBe(denied !== "skills_read");
        const pending = complete(
          surface.tools,
          `
        async function outcome(call) {
          try { return await call(); } catch (error) { return error.message; }
        }
        return {
          listed: await outcome(() => skills.list()),
          bodyMatch: await outcome(() => skills.search("private")),
          found: await outcome(() => skills.search("guide")),
          body: await outcome(() => skills.read("guide")),
        };
      `,
        );
        if (denied === "revoked") {
          await withinTest(
            awaitGateBeforeSettlement(
              readStarted.promise,
              pending,
              "Skill search completed before reading its instruction file",
            ),
            testSignal,
          );
          effectiveTools = skillTools.filter((tool) => tool.name !== "skills_read");
          compact();
          releaseRead.resolve();
        }
        const result = await pending;
        const unavailable = `${denied} is not available in this run.`;
        expectCompleted(result, {
          listed: denied === "skills_search" ? unavailable : [identity],
          found: denied === "skills_search" ? unavailable : { skills: [{ name: "guide" }] },
          bodyMatch:
            denied === "skills_search"
              ? unavailable
              : denied === "revoked"
                ? expect.stringContaining("permission changed")
                : { skills: denied === undefined ? [{ name: "guide" }] : [] },
          body:
            denied === "skills_read"
              ? unavailable
              : denied === "revoked"
                ? expect.stringContaining("Unknown tool id: skills_read.")
                : denied === "shadowed"
                  ? expect.stringContaining("Shadowed reader")
                  : skillBody(filePath, "Private instructions"),
        });
        expect(reads).toBe(denied === undefined || denied === "revoked" ? 1 : 0);
        if (denied === undefined) {
          effectiveTools = skillTools.filter((tool) => tool.name !== "skills_read");
          expectCompleted(
            await complete(compact().tools, 'return await skills.search("private");'),
            { skills: [] },
          );
          expect(reads).toBe(1);
        }
      } finally {
        releaseRead.resolve();
        runtime.cleanup();
      }
    }),
);

it.each([undefined, "read", "skills_read"])(
  "preserves prompt-listed whole reads under read grants with explicit denial=%s",
  async (denied) => {
    const guide = createFixtureSkillEntry("guide");
    const hidden = createFixtureSkillEntry("hidden");
    const body = `${"x".repeat(256 * 1024)}complete tail`;
    guide.skill.readContent = body;
    hidden.skill.readContent = body;
    const skills = prepareInstalledSkillCatalog({
      workspaceDir: "/workspace",
      snapshot: {
        prompt: await resolveSkillsPrompt({ entries: [guide], workspaceDir: "/workspace" }),
        skills: [{ name: "guide" }, { name: "hidden" }],
        discoverySkills: [guide.skill, hidden.skill],
      },
    });
    const h = createCatalogCodeModeHarness(
      filterToolsByPolicy(createInstalledSkillTools(skills), {
        allow: ["read", "exec"],
        deny: denied ? [denied] : [],
      }),
      { codeModeSkills: skills },
    );
    const result = await h.complete(`
        let body;
        let hidden;
        try {
          const content = await skills.read("guide");
          body = { length: content.length, tail: content.slice(-13) };
        } catch (error) { body = error.message; }
        try { await skills.read("hidden"); } catch (error) { hidden = error.message; }
        return { body, hidden };
      `);
    expectCompleted(result, {
      body: denied
        ? "skills_read is not available in this run."
        : { length: skillBody("/skills/guide/SKILL.md", body).length, tail: "complete tail" },
      hidden: denied
        ? "skills_read is not available in this run."
        : 'Skill "hidden" exceeds the 262144-byte instruction limit.',
    });
  },
);

it("returns missing implicitly optional daily memory through Code Mode", async () => {
  const read = createOpenClawReadTool(
    createReadTool("/workspace", {
      operations: {
        access: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        readFile: async () => Buffer.from("unreachable"),
      },
    }),
  );
  const result = await createCatalogCodeModeHarness([read]).complete(
    'return await read({ path: "memory/2026-05-15.md" });',
  );
  expectCompleted(result, {
    kind: "not_found",
    status: "not_found",
    path: "memory/2026-05-15.md",
    optional: true,
  });
});

function replay(targets: AnyAgentTool[], options?: Parameters<typeof createCodeModeHarness>[0]) {
  const { tools } = createCatalogCodeModeHarness(targets, options);
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
  const { tool: target, started, release } = controlledTool(fakeTool("read", "Read"));
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

it.each([
  { kind: "MCP replay-safe metadata", forced: false, error: "cannot call namespace tools" },
  { kind: "model-cleared exec flag", forced: true, error: "not proven replay-safe" },
])("enforces restart safety despite $kind", async ({ forced, error }) => {
  const target = forced
    ? pluginTool("fake_forced_write", "Write")
    : markReplaySafe(
        mcpTool({
          name: "mcp_github_read_file",
          serverName: "github",
          toolName: "read_file",
        }),
      );
  const { run } = replay([target], { forceRestartSafeTools: forced });
  const code = forced
    ? 'const [write] = await catalog.search("fake_forced_write"); return await write({});'
    : 'return await MCP.github.readFile({ path: "README.md" });';
  expect(await run(code, !forced)).toMatchObject({
    status: "failed",
    replaySafe: true,
    error: expect.stringContaining(error),
  });
  expect(target.execute).not.toHaveBeenCalled();
});

it("preserves bridge evidence when a later restart-safe call is rejected", async () => {
  const read = markReplaySafe(pluginTool("catalog", "Read"));
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

const catalogs: Array<ReturnType<typeof createCodeModeHarness>["ctx"]> = [];

function sessionStoreHarness(
  executor: "node" | "quickjs" = "node",
  manager = SessionManager.inMemory(),
  targets: AnyAgentTool[] = [],
) {
  const h = createCodeModeHarness({ codeMode: { executor } });
  h.ctx.sessionId = manager.getSessionId();
  catalogs.push(h.ctx);
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...targets] });
  bindCodeModeSessionStore(h.catalogRef, manager);
  const runner = codeModeRunner(h.tools);
  const exec = (code: string, restartSafe = false) =>
    runner.run(code, "store-cell", { restartSafe });
  return {
    ...h,
    manager,
    execute: runner.execute,
    exec,
    check: async (code: string, value: unknown) => expectCompleted(await exec(code), value),
    wait: (runId: unknown) => runner.resume({ runId }, "store-wait"),
  };
}

it.each(["node", "quickjs"] as const)(
  "%s store keeps detached JSON across cells, deletes keys, and rejects invalid keys",
  async (executor) => {
    const h = sessionStoreHarness(executor);
    const detached = JSON.parse('{"nested":[1],"__proto__":"data"}');
    await h.check(
      `
      const original = { nested: [1], ["__proto__"]: "data" };
      const saved = await store("key", original);
      original.nested.push(2);
      const loaded = await load("key"); loaded.nested.push(3);
      await store("nullable", null);
      const errors = [];
      for (const key of ["", 2, null, "x".repeat(257), { toJSON() { return "coerced"; } }]) {
        try { await store(key, true); } catch (error) { errors.push(error instanceof TypeError); }
        try { await load(key); } catch (error) { errors.push(error instanceof TypeError); }
      }
      return { saved: saved === undefined, missing: (await load("missing")) === undefined,
        value: await load("key"), nullable: await load("nullable"), errors };
    `,
      {
        saved: true,
        missing: true,
        value: detached,
        nullable: null,
        errors: Array(10).fill(true),
      },
    );
    await h.check(
      `
      const value = await load("key");
      await store("key", undefined);
      return { value, deleted: (await load("key")) === undefined };
    `,
      { value: detached, deleted: true },
    );
    await h.check('return (await load("key")) === undefined;', true);
  },
);

describe("session store bridge", () => {
  const executor = "node";

  it("enforces encoded value and total limits atomically with guest RangeErrors", async () => {
    const h = sessionStoreHarness(executor);
    await h.check(
      `
      const max = "x".repeat(256 * 1024 - 2);
      for (const key of ["a", "b", "c", "d"]) await store(key, max);
      const errors = [];
      for (const [key, value] of [["a", max + "x"], ["a", "é".repeat(128 * 1024)], ["e", 1]]) {
        try { await store(key, value); } catch (error) { errors.push(error instanceof RangeError); }
      }
      const unchanged = (await load("a")).length;
      await store("b", undefined);
      await store("e", 1);
      return { errors, unchanged, deleted: (await load("b")) === undefined, added: await load("e") };
    `,
      {
        errors: [true, true, true],
        unchanged: 256 * 1024 - 2,
        deleted: true,
        added: 1,
      },
    );
  });

  it.each([
    { name: "invalid key", set: { "": true }, cause: TypeError },
    { name: "oversized value", set: { key: "x".repeat(256 * 1024) }, cause: RangeError },
    {
      name: "oversized store",
      set: Object.fromEntries(
        ["a", "b", "c", "d", "e"].map((key) => [key, "x".repeat(256 * 1024 - 2)]),
      ),
      cause: RangeError,
    },
    { name: "uncaught guest RangeError", set: undefined, cause: RangeError },
  ])("keeps bridge provenance for $name", async ({ set, cause }) => {
    const log = vi.spyOn(diagnostics, "logCodeModeFailure").mockImplementation(() => {});
    const h = sessionStoreHarness(executor);
    if (set) {
      await h.manager.appendCustomEntryAsync("openclaw.code-mode-store", {
        set,
        delete: [],
        networkContent: Object.fromEntries(Object.keys(set).map((key) => [key, false])),
      });
    }
    const result = await h.exec(
      set ? 'return await load("key");' : 'await store("a", "x".repeat(256 * 1024));',
    );
    expectFailure(
      result,
      "bridge",
      "internal_error",
      set
        ? { error: expect.stringContaining("repair the session") }
        : { bridgeDispatchStarted: true, error: expect.stringMatching(/^RangeError/) },
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      set ? expect.objectContaining({ cause: expect.any(cause) }) : expect.any(cause),
      expect.objectContaining({
        failurePhase: "bridge",
        failureCode: set ? "tool_error" : "store_range",
      }),
    );
  });

  it("retains writes across wait, hides them from sibling cells, and commits once", async () => {
    const h = sessionStoreHarness(executor);
    const first = await h.exec(`
      await store("key", 7); await yield_control();
      const before = await load("key"); await store("key", before + 1); return before;
    `);
    expect(first.status).toBe("waiting");
    expect(h.manager.getBranch()).toEqual([]);
    await h.check('return (await load("key")) === undefined;', true);
    expectCompleted(await h.wait(first.runId), 7);
    expect(h.manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
    await h.check('return await load("key");', 8);
  });

  it("carries network provenance through a persisted key into a later reply", async () => {
    const network = jsonTool("network_fixture", { text: "untrusted fixture" });
    network.resultContentSource = "network";
    const h = sessionStoreHarness(executor, undefined, [network]);
    await h.check('await store("network", await network_fixture({})); return true;', true);
    clearToolSearchCatalog(h.ctx);
    const next = sessionStoreHarness(executor, h.manager);
    const loaded = await next.execute('return (await load("network")).text;', "store-cell", {
      restartSafe: false,
    });
    expectCompleted(resultDetails(loaded), "untrusted fixture");
    expect(loaded.content[0]).toMatchObject({
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
  });

  it("preserves the completed value and warns when transcript append fails", async () => {
    const h = sessionStoreHarness(executor);
    vi.spyOn(h.manager, "appendCustomEntryAsync").mockRejectedValueOnce(
      new Error("fixture disk failure"),
    );
    expect(await h.exec('await store("key", 1); return { done: true };')).toMatchObject({
      status: "completed",
      value: { done: true },
      warnings: [expect.stringContaining("persistence could not be confirmed")],
    });
    expect(h.manager.getBranch()).toEqual([]);
    await h.check('return (await load("key")) === undefined;', true);
  });

  it("rejects unbound, restartSafe, and headless session-store access", async () => {
    const h = sessionStoreHarness(executor);
    const safe = await h.exec('return await load("key");', true);
    expect(safe).toMatchObject({
      status: "failed",
      error: expect.stringContaining("restart-safe"),
    });
    const unbound = createCodeModeHarness({ codeMode: { executor } });
    catalogs.push(unbound.ctx);
    applyCodeModeCatalog({ ...unbound.ctx, tools: unbound.tools });
    expect(
      resultDetails(
        await unbound.tools[0]!.execute("unbound", { code: 'return await load("key");' }),
      ),
    ).toMatchObject({ status: "failed", error: expect.stringContaining("session") });
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness([], { codeMode: { executor } }),
      code: 'await store("key", 1);',
    });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("headless") });
  });
});

it.each(["aborted", "timeout"] as const)(
  "discards a parked cell's writes when %s",
  async (outcome) => {
    const h = sessionStoreHarness("node");
    const parked = await h.exec('await store("key", 1); await yield_control(); return true;');
    expect(parked.status).toBe("waiting");
    const state = testing.activeRuns.get(String(parked.runId))!;
    if (outcome === "timeout") {
      vi.spyOn(state.continuation, "resume").mockResolvedValueOnce({
        status: "failed",
        code: "timeout",
        error: "fixture execution timeout",
        failurePhase: "host",
        bridgeDispatchStarted: false,
        output: EMPTY_CODE_MODE_OUTPUT,
      });
      expect(await h.wait(parked.runId)).toMatchObject({
        status: "failed",
        code: "timeout",
      });
    } else {
      const controller = new AbortController();
      controller.abort();
      expect(
        resultDetails(
          await h.tools[1]!.execute("abort", { runId: parked.runId }, controller.signal),
        ),
      ).toMatchObject({ status: "failed", code: "aborted" });
    }
    await resetCodeModeTestState();
    expect(h.manager.getBranch()).toEqual([]);
    const next = sessionStoreHarness("node", h.manager);
    await next.check('return (await load("key")) === undefined;', true);
  },
);
