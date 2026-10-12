import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search-catalog.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps core shell and file signatures visible when the real catalog overflows", () => {
  const workspaceDir = tempDirs.make("code-mode-catalog-index-");
  const config: OpenClawConfig = {
    agents: {
      entries: { main: {} },
      defaults: {
        imageModel: "openai/gpt-5.6-sol",
        pdfModel: "openai/gpt-5.6-sol",
        mediaModels: {
          image: "openai/gpt-image-1",
          video: "google/veo",
          music: "google/lyria",
        },
      },
    },
    tools: {
      exec: { mode: "full" },
      codeMode: true,
      swarm: true,
      web: { search: { provider: "brave" } },
    },
  };
  const targets = createOpenClawCodingTools({
    config,
    agentId: "main",
    cwd: workspaceDir,
    workspaceDir,
    agentDir: workspaceDir,
    sessionKey: "agent:main:main",
    senderIsOwner: true,
    modelHasVision: true,
    clientCaps: ["ui-commands", "inline-widgets"],
    taskSuggestionDeliveryMode: "gateway",
    githubPublicationAvailable: true,
    authProfileStore: { version: 1, profiles: {} },
    wrapBeforeToolCallHook: false,
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
  const catalogRef = createToolSearchCatalogRef();
  const ctx = { config, agentId: "main", catalogRef };
  const render = (tools: typeof targets) => {
    const compacted = applyCodeModeCatalog({
      ...ctx,
      tools: [...createCodeModeTools(ctx), ...tools],
    });
    return compacted.tools.find((tool) => tool.name === "exec")!.description;
  };
  try {
    const description = render(targets);
    expect(catalogRef.current!.entries.length).toBeGreaterThanOrEqual(45);
    const index = description.slice(description.indexOf("Enabled async tool globals"));
    expect(index).toContain("additional tools omitted");
    expect(index.length).toBeLessThanOrEqual(8_000);
    const lines = index.split("\n");
    const shell = lines.find((line) => line.startsWith("- exec "));
    expect(shell, "shell signature must survive catalog overflow").toBeDefined();
    expect(shell).toContain("command: string");
    expect(shell).toContain("workdir?: string");
    expect(shell).toContain("timeoutSeconds?: number");
    expect(shell).not.toMatch(/\b(cwd|timeout)\??:/);
    const process = lines.find((line) => line.startsWith("- process "));
    expect(process, "process signature must survive catalog overflow").toBeDefined();
    expect(process).toContain("sessionId?: string");
    expect(process).toContain("timeout?: number");
    expect(process).not.toContain("timeoutMs");
    for (const name of ["apply_patch", "edit", "ls", "read", "write"]) {
      expect(lines.some((line) => line.startsWith(`- ${name} `))).toBe(true);
    }
    expect(render(targets.toReversed())).toBe(description);
  } finally {
    clearToolSearchCatalog(ctx);
  }
});
