import { describe, expect, it } from "vitest";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import {
  applyCodeModeCatalog,
  buildCodeModeCatalogPrompt,
  createCodeModeTools,
} from "./code-mode.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";

const sandbox = {
  containerName: "test-exec-sandbox",
  workspaceDir: "/workspace",
  containerWorkdir: "/workspace",
};

it("reuses host and continuation schemas across interleaved sessions", () => {
  const schemas = ["first", "second", "first"].map((sessionId) =>
    [false, true].flatMap((hasProcess) =>
      [undefined, sandbox].map((sessionSandbox) => {
        const tool = createLazyExecTool({ sessionId, sandbox: sessionSandbox });
        finalizeAgentToolAvailability([
          tool,
          ...(hasProcess
            ? [{ name: "process", description: "Process control", parameters: {} }]
            : []),
        ]);
        expect(tool.parameters).toMatchObject({
          properties: {
            host: { enum: sessionSandbox ? ["auto", "sandbox"] : ["auto", "gateway", "node"] },
          },
        });
        for (const field of ["background", "yieldMs"]) {
          const assertion = expect(tool.parameters);
          (hasProcess ? assertion : assertion.not).toHaveProperty(`properties.${field}`);
        }
        return tool.parameters;
      }),
    ),
  );
  expect(new Set(schemas.flat()).size).toBe(4);
});

it("preserves the runtime rejection for an explicit unavailable sandbox through input validation", async () => {
  for (const createTool of [createExecTool, createLazyExecTool]) {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [createTool({ mode: "full" })] });
    const runtime = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(), {
      validateInput: true,
    });
    await expect(runtime.call("exec", { command: "exit 99", host: "sandbox" })).rejects.toThrow(
      "exec host=sandbox requires a sandbox runtime for this session.",
    );
  }
});

describe.each(["agent:main:main", "agent:main:subagent:child"])(
  "exec host contract for %s",
  (sessionKey) => {
    it.each([
      { defaults: {}, hosts: ["auto", "gateway", "node"] },
      { defaults: { sandbox }, hosts: ["auto", "sandbox"] },
      { defaults: { host: "gateway" }, hosts: ["auto", "gateway"] },
      { defaults: { host: "node", sandbox }, hosts: ["auto", "node"] },
      { defaults: { host: "sandbox" }, hosts: ["auto"] },
      {
        defaults: { host: "node", sandbox, sandboxRequired: true },
        hosts: ["auto", "sandbox"],
      },
    ] satisfies { defaults: ExecToolDefaults; hosts: string[] }[])(
      "offers $hosts through direct and code-mode surfaces",
      async ({ defaults, hosts }) => {
        for (const createTool of [createExecTool, createLazyExecTool]) {
          const [direct] = finalizeAgentTools({
            tools: [createTool({ ...defaults, sessionKey, mode: "full" })],
            hookContext: {},
            wrapBeforeToolCallHook: false,
          });
          const expectedSchema = { properties: { host: { enum: hosts } } };
          expect(direct!.parameters).toMatchObject(expectedSchema);
          const catalogRef = createToolSearchCatalogRef();
          const ctx = { catalogRef, sessionKey, config: { tools: { codeMode: true } } };
          applyCodeModeCatalog({
            ...ctx,
            tools: [...createCodeModeTools(ctx), direct!],
          });
          const signature = `host?: ${hosts.map((host) => JSON.stringify(host)).join(" | ")}`;
          expect(buildCodeModeCatalogPrompt(ctx, catalogRef.current!.entries)).toContain(signature);
          const runtime = new ToolSearchRuntime(ctx, resolveToolSearchConfig(ctx.config));
          const described = await runtime.describe("exec");
          expect(described.parameters).toMatchObject(expectedSchema);
          expect(described.input).toContain(signature);
        }
      },
    );
  },
);
