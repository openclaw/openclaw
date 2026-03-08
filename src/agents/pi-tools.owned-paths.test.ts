import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

const tempRoots: string[] = [];

async function createCaseRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-owned-paths-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createConfig(
  root: string,
): Promise<{ cfg: OpenClawConfig; runtimeRepo: string; helmRepo: string }> {
  const runtimeRepo = path.join(root, "openclaw-sre");
  const helmRepo = path.join(root, "morpho-infra-helm");
  await fs.mkdir(path.join(runtimeRepo, "src"), { recursive: true });
  await fs.mkdir(path.join(helmRepo, "charts", "openclaw-sre"), { recursive: true });
  const ownershipPath = path.join(root, "repo-ownership.json");
  await fs.writeFile(
    ownershipPath,
    JSON.stringify(
      {
        version: "sre.repo-ownership-map.v1",
        generatedAt: "2026-03-08T00:00:00.000Z",
        repos: [
          {
            repoId: "openclaw-sre",
            localPath: runtimeRepo,
            ownedGlobs: ["src/**"],
            sourceOfTruthDomains: ["runtime"],
            dependentRepos: ["morpho-infra-helm"],
            ciChecks: ["pnpm build"],
            validationCommands: ["pnpm build"],
            rollbackHints: ["revert"],
          },
          {
            repoId: "morpho-infra-helm",
            localPath: helmRepo,
            ownedGlobs: ["charts/openclaw-sre/**"],
            sourceOfTruthDomains: ["helm"],
            dependentRepos: ["openclaw-sre"],
            ciChecks: ["helm template"],
            validationCommands: ["helm lint"],
            rollbackHints: ["revert"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return {
    cfg: {
      sre: {
        repoOwnership: { enabled: true, filePath: ownershipPath },
      },
      tools: {
        allow: ["read", "write", "exec"],
        exec: { applyPatch: { enabled: true } },
      },
      agents: {
        list: [{ id: "sre-repo-runtime", workspace: runtimeRepo }],
      },
    },
    runtimeRepo,
    helmRepo,
  };
}

describe("pi tools owned path enforcement", () => {
  it("blocks fixer writes outside owned globs", async () => {
    const root = await createCaseRoot();
    const { cfg, runtimeRepo } = await createConfig(root);
    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:sre-repo-runtime:main",
      workspaceDir: runtimeRepo,
      agentDir: path.join(root, "agent"),
      modelProvider: "openai",
      modelId: "gpt-5.2",
      exec: { host: "gateway", ask: "off", security: "full" },
    });
    const writeTool = tools.find((tool) => tool.name === "write");
    if (!writeTool?.execute) {
      throw new Error("missing write tool");
    }
    await expect(
      writeTool.execute("call-1", { path: "docs/outside.md", content: "nope" }),
    ).rejects.toThrow(/Owned-path policy blocked/);
  });

  it("blocks fixer exec when workdir is outside owned repo", async () => {
    const root = await createCaseRoot();
    const { cfg, runtimeRepo, helmRepo } = await createConfig(root);
    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:sre-repo-runtime:main",
      workspaceDir: runtimeRepo,
      agentDir: path.join(root, "agent"),
      exec: { host: "gateway", ask: "off", security: "full" },
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    if (!execTool?.execute) {
      throw new Error("missing exec tool");
    }
    await expect(
      execTool.execute("call-2", { command: "echo ok", workdir: helmRepo }),
    ).rejects.toThrow(/Owned-path policy blocked exec outside owned repo/);
  });
});
