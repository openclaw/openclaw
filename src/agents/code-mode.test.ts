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
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import { bindCodeModeSessionStore } from "./code-mode-session-store.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
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
  pluginToolWithExecute,
} from "./code-mode.test-support.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";
import { createReadTool, type ToolDefinition } from "./sessions/index.js";
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
  return { ...harness, ...compacted, exec: compacted.tools[0]! };
}

function indexOf(description: string) {
  const start = description.indexOf("Enabled async tool globals");
  expect(start).toBeGreaterThanOrEqual(0);
  return description.slice(start);
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
    const { ctx, exec } = catalog([fakeTool("exec", "Run shell command")]);
    expect(exec.description).toContain("Use the shell tool `exec` for heavier computation");
    addClientToolsToToolCatalog({
      enabled: true,
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

  it("returns no callable matches for an unknown tool", async () => {
    const { run, targets } = setup();
    const result = await run(`
      const matches = await catalog.search("zzzz_missing_tool", { limit: 50 });
      return { count: matches.length, frozen: Object.isFrozen(matches), callable: matches.every(tool => typeof tool === "function") };
    `);
    expect(result).toMatchObject({
      status: "completed",
      value: { count: 0, frozen: true, callable: true },
    });
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
    }
  });
});

it("searches and reads eligible skills through the worker bridge and normal tool dispatch", async () => {
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
  applyCodeModeCatalog({
    ...h.ctx,
    tools: [...h.tools, ...createInstalledSkillTools(codeModeSkills)],
  });
  const result = await runUntilCompleted({
    execTool: h.tools[0]!,
    waitTool: h.tools[1]!,
    code: `
    const listed = await skills.list();
    const found = await skills.search("demo");
    const body = await skills.read("demo");
    let unknown;
    try { await skills.read("missing"); } catch (error) { unknown = error.message; }
    return { listed, found, body, unknown };
  `,
  });
  expect(result).toMatchObject({
    status: "completed",
    value: {
      listed: [
        { name: "demo", description: demo.skill.description, location: "/skills/demo/SKILL.md" },
      ],
      found: {
        skills: [
          { name: "demo", description: demo.skill.description, location: "/skills/demo/SKILL.md" },
        ],
        hasMore: false,
        coverage: { bodyIndexed: 0, metadataOnly: 1, truncatedBodies: 0 },
      },
      body,
      unknown:
        'Skill "missing" is not available to this agent. Search the available skills instead.',
    },
  });
  expect(reader).toHaveBeenCalledExactlyOnceWith({
    location: "/skills/demo/SKILL.md",
    signal: expect.any(AbortSignal),
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
    const h = createCodeModeHarness({ agentId: "main", codeModeSkills });
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
    applyCodeModeCatalog({
      ...h.ctx,
      tools: [
        ...h.tools,
        ...createInstalledSkillTools(codeModeSkills).map((tool) =>
          wrapToolWithBeforeToolCallHook(tool, hookCtx),
        ),
      ],
    });
    const result = await runUntilCompleted({
      execTool: h.tools[0]!,
      waitTool: h.tools[1]!,
      code: 'return await skills.read("learned");',
    });
    expect(result).toMatchObject({ status: "completed", value: "# Learned instructions\n" });
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
      await writeFile(filePath, "Private instructions");
      const readStarted = createDeferred();
      const releaseRead = createDeferred();
      let reads = 0;
      const skills = [
        {
          name: "guide",
          description: "Guide",
          location: filePath,
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
                skills: skills.map(({ name, description, location }) => ({
                  name,
                  description,
                  location,
                })),
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
        const surface = runtime.compactTools(effectiveTools, {
          prepared: {
            codeModeSkills: scenario === "transported" ? undefined : skills,
            preserveToolNames: [],
          },
        });
        const exec = surface.tools.find((tool) => tool.name === "exec")!;
        const wait = surface.tools.find((tool) => tool.name === "wait")!;
        expect(exec.description.includes("skills.search(")).toBe(denied !== "skills_search");
        expect(exec.description.includes("skills.list(")).toBe(denied !== "skills_search");
        expect(exec.description.includes("skills.read(")).toBe(denied !== "skills_read");
        const pending = runUntilCompleted({
          execTool: exec,
          waitTool: wait,
          code: `
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
        });
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
          runtime.compactTools(effectiveTools, {
            prepared: { codeModeSkills: skills, preserveToolNames: [] },
          });
          releaseRead.resolve();
        }
        const result = await pending;
        const unavailable = `${denied} is not available in this run.`;
        expect(result).toMatchObject({
          status: "completed",
          value: {
            listed:
              denied === "skills_search"
                ? unavailable
                : [{ name: "guide", description: "Guide", location: filePath }],
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
                    : "Private instructions",
          },
        });
        expect(reads).toBe(denied === undefined || denied === "revoked" ? 1 : 0);
        if (denied === undefined) {
          effectiveTools = skillTools.filter((tool) => tool.name !== "skills_read");
          const revoked = runtime.compactTools(effectiveTools, {
            prepared: { codeModeSkills: skills, preserveToolNames: [] },
          });
          expect(
            await runUntilCompleted({
              execTool: revoked.tools.find((tool) => tool.name === "exec")!,
              waitTool: revoked.tools.find((tool) => tool.name === "wait")!,
              code: 'return await skills.search("private");',
            }),
          ).toMatchObject({ status: "completed", value: { skills: [] } });
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
    const h = createCodeModeHarness({ codeModeSkills: skills });
    applyCodeModeCatalog({
      ...h.ctx,
      tools: [
        ...h.tools,
        ...filterToolsByPolicy(createInstalledSkillTools(skills), {
          allow: ["read", "exec"],
          deny: denied ? [denied] : [],
        }),
      ],
    });
    const result = await runUntilCompleted({
      execTool: h.tools[0]!,
      waitTool: h.tools[1]!,
      code: `
        let body;
        let hidden;
        try {
          const content = await skills.read("guide");
          body = { length: content.length, tail: content.slice(-13) };
        } catch (error) { body = error.message; }
        try { await skills.read("hidden"); } catch (error) { hidden = error.message; }
        return { body, hidden };
      `,
    });
    expect(result).toMatchObject({
      status: "completed",
      value: {
        body: denied
          ? "skills_read is not available in this run."
          : { length: body.length, tail: "complete tail" },
        hidden: denied
          ? "skills_read is not available in this run."
          : 'Skill "hidden" exceeds the 262144-byte instruction limit.',
      },
    });
  },
);

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
  return {
    ...h,
    manager,
    exec: async (code: string, restartSafe = false) =>
      h.tools[0]!.execute("store-cell", { code, restartSafe }),
    wait: async (runId: unknown) => h.tools[1]!.execute("store-wait", { runId }),
  };
}

describe.each(["node", "quickjs"] as const)("%s session store bridge", (executor) => {
  it("keeps detached JSON across cells, deletes keys, and rejects invalid keys", async () => {
    const h = sessionStoreHarness(executor);
    const saved = resultDetails(
      await h.exec(`
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
    `),
    );
    expect(saved, JSON.stringify(saved)).toMatchObject({
      status: "completed",
      value: {
        saved: true,
        missing: true,
        value: JSON.parse('{"nested":[1],"__proto__":"data"}'),
        nullable: null,
        errors: Array(10).fill(true),
      },
    });
    expect(
      resultDetails(
        await h.exec(`
      const value = await load("key");
      await store("key", undefined);
      return { value, deleted: (await load("key")) === undefined };
    `),
      ),
    ).toMatchObject({
      status: "completed",
      value: {
        value: JSON.parse('{"nested":[1],"__proto__":"data"}'),
        deleted: true,
      },
    });
    expect(resultDetails(await h.exec('return (await load("key")) === undefined;'))).toMatchObject({
      status: "completed",
      value: true,
    });
  });
});

describe("session store bridge", () => {
  const executor = "node";

  it("enforces encoded value and total limits atomically with guest RangeErrors", async () => {
    const h = sessionStoreHarness(executor);
    const result = resultDetails(
      await h.exec(`
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
    `),
    );
    expect(result).toMatchObject({
      status: "completed",
      value: {
        errors: [true, true, true],
        unchanged: 256 * 1024 - 2,
        deleted: true,
        added: 1,
      },
    });
  });

  it("keeps bridge provenance for uncaught typed store errors", async () => {
    const h = sessionStoreHarness(executor);
    const result = resultDetails(await h.exec('await store("a", "x".repeat(256 * 1024));'));
    expect(result).toMatchObject({
      status: "failed",
      code: "internal_error",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(String(result.error)).toMatch(/^RangeError/);
  });

  it("retains writes across wait, hides them from sibling cells, and commits once", async () => {
    const h = sessionStoreHarness(executor);
    const first = resultDetails(
      await h.exec(`
      await store("key", 7); await yield_control();
      const before = await load("key"); await store("key", before + 1); return before;
    `),
    );
    expect(first.status).toBe("waiting");
    expect(h.manager.getBranch()).toEqual([]);
    expect(resultDetails(await h.exec('return (await load("key")) === undefined;'))).toMatchObject({
      status: "completed",
      value: true,
    });
    expect(resultDetails(await h.wait(first.runId))).toMatchObject({
      status: "completed",
      value: 7,
    });
    expect(h.manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
    expect(resultDetails(await h.exec('return await load("key");'))).toMatchObject({
      status: "completed",
      value: 8,
    });
  });

  it("carries network provenance through a persisted key into a later reply", async () => {
    const network = pluginToolWithExecute("network_fixture", "Read network fixture", async () =>
      jsonResult({ text: "untrusted fixture" }),
    );
    network.resultContentSource = "network";
    const h = sessionStoreHarness(executor, undefined, [network]);
    expect(
      resultDetails(
        await h.exec('await store("network", await network_fixture({})); return true;'),
      ),
    ).toMatchObject({ status: "completed", value: true });
    clearToolSearchCatalog(h.ctx);
    const next = sessionStoreHarness(executor, h.manager);
    const loaded = await next.exec('return (await load("network")).text;');
    expect(resultDetails(loaded)).toMatchObject({
      status: "completed",
      value: "untrusted fixture",
    });
    expect(loaded.content[0]).toMatchObject({
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
  });

  it("preserves the completed value and warns when transcript append fails", async () => {
    const h = sessionStoreHarness(executor);
    vi.spyOn(h.manager, "appendCustomEntryAsync").mockRejectedValueOnce(
      new Error("fixture disk failure"),
    );
    expect(
      resultDetails(await h.exec('await store("key", 1); return { done: true };')),
    ).toMatchObject({
      status: "completed",
      value: { done: true },
      warnings: [expect.stringContaining("persistence could not be confirmed")],
    });
    expect(h.manager.getBranch()).toEqual([]);
    expect(resultDetails(await h.exec('return (await load("key")) === undefined;'))).toMatchObject({
      status: "completed",
      value: true,
    });
  });

  it("rejects unbound, restartSafe, and headless session-store access", async () => {
    const h = sessionStoreHarness(executor);
    const safe = resultDetails(await h.exec('return await load("key");', true));
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
    const parked = resultDetails(
      await h.exec('await store("key", 1); await yield_control(); return true;'),
    );
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
      expect(resultDetails(await h.wait(parked.runId))).toMatchObject({
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
    expect(
      resultDetails(await next.exec('return (await load("key")) === undefined;')),
    ).toMatchObject({ status: "completed", value: true });
  },
);
