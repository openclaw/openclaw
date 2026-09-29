/**
 * Memory write provenance through the coding-tools turn-taint wiring: a
 * result-only network tool outcome must mark subsequent memory writes
 * untrusted, while unmarked local outcomes keep agent-origin classification.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createAgentTurnTaintState } from "./embedded-agent-runner/run/turn-taint-state.js";
import { createOpenClawTools } from "./openclaw-tools.js";

type CodingTool = ReturnType<typeof createOpenClawCodingTools>[number];

function requireTool(tools: CodingTool[], name: string): CodingTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`expected tool ${name}`);
  }
  return tool;
}

function requireToolExecute(tool: CodingTool): NonNullable<CodingTool["execute"]> {
  if (!tool.execute) {
    throw new Error(`expected executable tool ${tool.name}`);
  }
  return tool.execute;
}

describe("createOpenClawCodingTools memory taint", () => {
  it("marks memory writes untrusted after a result-only network tool outcome", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-result-taint-"));
    const taintState = createAgentTurnTaintState();
    const remotePdfTool = {
      name: "pdf",
      label: "PDF",
      description: "Read a PDF.",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text" as const, text: "remote PDF text" }],
        details: {},
        resultContentSource: "network" as const,
      }),
    };
    vi.mocked(createOpenClawTools).mockReturnValueOnce([remotePdfTool as never]);

    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        senderIsOwner: true,
        sessionId: "result-taint-session",
        isTurnTainted: () => taintState.isTainted(),
        onToolOutcome: (obs) => taintState.observe(obs),
      });
      await requireToolExecute(requireTool(tools, "pdf"))("remote-pdf", {});
      await requireToolExecute(requireTool(tools, "write"))("memory-write", {
        path: "memory/2026-07-31.md",
        content: "remote-derived note\n",
      });

      expect(taintState.isTainted()).toBe(true);
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/2026-07-31.md" }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
      await expect(
        fs.readFile(path.join(workspaceDir, "memory/2026-07-31.md"), "utf8"),
      ).resolves.toBe("remote-derived note\n");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps memory writes agent-originated after an unmarked local tool outcome", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-local-result-"));
    const taintState = createAgentTurnTaintState();
    const localPdfTool = {
      name: "pdf",
      label: "PDF",
      description: "Read a PDF.",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text" as const, text: "local PDF text" }],
        details: {},
      }),
    };
    vi.mocked(createOpenClawTools).mockReturnValueOnce([localPdfTool as never]);

    try {
      const tools = createOpenClawCodingTools({
        workspaceDir,
        senderIsOwner: true,
        sessionId: "local-result-session",
        isTurnTainted: () => taintState.isTainted(),
        onToolOutcome: (obs) => taintState.observe(obs),
      });
      await requireToolExecute(requireTool(tools, "pdf"))("local-pdf", {});
      await requireToolExecute(requireTool(tools, "write"))("memory-write", {
        path: "memory/2026-07-31.md",
        content: "local-derived note\n",
      });

      expect(taintState.isTainted()).toBe(false);
      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/2026-07-31.md" }),
      ).resolves.toMatchObject({ originClass: "agent" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
