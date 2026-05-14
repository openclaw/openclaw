import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyDocumentHash } from "./policy-state.js";
import { evaluatePolicyTrustedToolCall } from "./runtime-tool-policy.js";

let workspaceDir: string;

function cfg(settings: Record<string, unknown> = {}, entryEnabled = true) {
  return {
    plugins: {
      entries: {
        policy: {
          enabled: entryEnabled,
          config: { runtimeToolPolicy: true, ...settings },
        },
      },
    },
  };
}

async function evaluate(
  toolName: string,
  settings: Record<string, unknown> = {},
  entryEnabled = true,
) {
  return evaluatePolicyTrustedToolCall(
    { toolName, params: {} },
    { toolName },
    {
      cwd: workspaceDir,
      readConfig: () => cfg(settings, entryEnabled),
    },
  );
}

describe("policy trusted tool runtime", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-runtime-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does nothing until runtime tool policy is enabled", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk"] } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy", { runtimeToolPolicy: false })).resolves.toBeUndefined();
  });

  it("honors plugin entry enablement without requiring config.enabled", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk"] } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy requires risk metadata for 'deploy', but TOOLS.md does not declare it.",
    });
  });

  it("honors explicit policy disablement", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk"] } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy", { enabled: false })).resolves.toBeUndefined();
  });

  it("blocks when the enabled runtime policy file is missing", async () => {
    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy tool runtime is enabled, but policy.jsonc is missing.",
    });
  });

  it("blocks when the enabled runtime policy file is malformed", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{ tools: ", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:low\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy tool runtime is enabled, but policy.jsonc could not be parsed.",
    });
  });

  it("blocks when the enabled runtime policy file has invalid containers", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { entries: {} } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:low\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason:
        "Policy tool runtime is enabled, but policy.jsonc has an invalid tools.entries section.",
    });
  });

  it("blocks when requireMetadata contains unsupported entries", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk", "unsupported"] } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:low\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason:
        "Policy tool runtime is enabled, but policy.jsonc has unsupported tools.requireMetadata 'unsupported'.",
    });
  });

  it("blocks tool calls whose required metadata is missing", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { requireMetadata: ["risk"] },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy requires risk metadata for 'deploy', but TOOLS.md does not declare it.",
    });
  });

  it("blocks tool calls whose required owner metadata is missing", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["owner"] } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:low sensitivity:internal\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy requires owner metadata for 'deploy', but TOOLS.md does not declare it.",
    });
  });

  it("blocks tool calls whose risk metadata is unknown", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { requireMetadata: ["risk"] },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critcal\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason:
        "Policy requires known risk metadata for 'deploy', but TOOLS.md declares 'critcal'.",
    });
  });

  it("requires approval for critical or irreversible tools", async () => {
    const policy = {
      tools: { requireMetadata: ["risk"] },
    };
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critical sensitivity:internal IRREVERSIBLE_EXTERNAL\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toMatchObject({
      requireApproval: {
        title: "Review policy-governed tool",
        severity: "critical",
        metadata: {
          source: "policy",
          policy: {
            path: "policy.jsonc",
            hash: policyDocumentHash(policy),
          },
          workspace: {
            scope: "policy",
            hash: expect.stringMatching(/^sha256:/),
          },
          target: "oc://TOOLS.md/tools/deploy",
        },
      },
    });
  });

  it("includes policy metadata when undeclared tools need approval", async () => {
    const policy = {
      tools: { requireMetadata: ["risk"] },
    };
    const expectedHash = policyDocumentHash(policy);
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n", "utf-8");

    await expect(evaluate("deploy", { expectedHash })).resolves.toMatchObject({
      requireApproval: {
        title: "Review undeclared tool",
        metadata: {
          source: "policy",
          policy: {
            path: "policy.jsonc",
            hash: expectedHash,
            expectedHash,
          },
          workspace: {
            scope: "policy",
            hash: expect.stringMatching(/^sha256:/),
          },
          target: "oc://TOOLS.md/tools/deploy",
        },
      },
    });
  });

  it("allows declared low-risk tools without a runtime decision", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { requireMetadata: ["risk"] },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### inspect risk:low sensitivity:public\n",
      "utf-8",
    );

    await expect(evaluate("inspect")).resolves.toBeUndefined();
  });
});
