import fs from "node:fs/promises";
import path from "node:path";
import { validateAgentProfile } from "agentprofiles";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveOpenClawAgentProfileExtension } from "./openclaw-extension.js";
import { resolveAgentProfile } from "./resolve.js";
import type { ResolvedAgentProfile } from "./resolve.js";
import { prepareAgentProfileWorkspaceContext } from "./workspace-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resolvedProfile(extension?: unknown): ResolvedAgentProfile {
  const resource = validateAgentProfile({
    apiVersion: "agentprofiles.io/v1",
    kind: "AgentProfile",
    metadata: { namespace: "test", name: "profile" },
    spec: {
      common: {},
      ...(extension === undefined ? {} : { "openclaw.ai": extension }),
    },
  });
  return {
    profile: {
      id: "openclaw/base",
      ancestry: ["openclaw/base"],
      spec: {
        common: resource.spec.common,
        "openclaw.ai": resolveOpenClawAgentProfileExtension([{ id: "test/profile", resource }]),
      },
    },
    selectionSource: "fallback",
  };
}

async function workspace() {
  return await fs.realpath(tempDirs.make("profile-context-"));
}

function source(
  dir: string,
  name: "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md",
  content: string,
) {
  return { name, path: path.join(dir, name), content, missing: false } as const;
}

describe("Agent Profile workspace context", () => {
  it("does nothing when the profile has no workspace context policy", async () => {
    expect(
      await prepareAgentProfileWorkspaceContext({
        resolvedProfile: resolvedProfile(),
        bootstrapFiles: [],
      }),
    ).toBeUndefined();
  });

  it("scales sections deterministically under the aggregate limit", async () => {
    const dir = await workspace();
    const result = await prepareAgentProfileWorkspaceContext({
      resolvedProfile: resolvedProfile({
        prompt: {
          workspaceContext: {
            totalMaxChars: 110,
            sections: {
              identity: { maxChars: 10 },
              agents: { maxChars: 100 },
              soul: { maxChars: 200 },
            },
          },
        },
      }),
      bootstrapFiles: [
        source(dir, "AGENTS.md", "a".repeat(100)),
        source(dir, "SOUL.md", "s".repeat(200)),
        source(dir, "IDENTITY.md", "Bob"),
      ],
    });

    expect(result?.report.injectedChars).toBeLessThanOrEqual(110);
    expect(result?.report.entries.map((entry) => entry.section)).toEqual([
      "agents",
      "soul",
      "identity",
    ]);
    expect(result?.report.entries.every((entry) => entry.causes.includes("aggregate-limit"))).toBe(
      true,
    );
  });

  describe("personal USER.md", () => {
    const personal = (dir: string, chars: number) => ({
      ...source(dir, "USER.md", "u".repeat(chars)),
      personalUser: true as const,
    });
    const policy = (totalMaxChars: number) =>
      resolvedProfile({
        prompt: {
          workspaceContext: {
            totalMaxChars,
            sections: { user: { maxChars: 2_000 }, agents: { maxChars: 5_000 } },
          },
        },
      });

    it("keeps the personal marker on a file that fits", async () => {
      const dir = await workspace();
      const result = await prepareAgentProfileWorkspaceContext({
        resolvedProfile: policy(5_000),
        bootstrapFiles: [personal(dir, 500)],
      });

      expect(result?.contextFiles).toEqual([
        { path: path.join(dir, "USER.md"), content: "u".repeat(500), personalUser: true },
      ]);
    });

    it("drops a personal file above its section limit instead of cutting it", async () => {
      const dir = await workspace();
      const warnings: string[] = [];
      const result = await prepareAgentProfileWorkspaceContext({
        resolvedProfile: policy(5_000),
        bootstrapFiles: [personal(dir, 2_500)],
        warn: (message) => warnings.push(message),
      });

      expect(result?.contextFiles).toEqual([]);
      expect(warnings.join("\n")).toContain("user is 2500 chars; injecting 0 chars");
    });

    it("keeps a personal file whole and trims the shared files around it", async () => {
      const dir = await workspace();
      const result = await prepareAgentProfileWorkspaceContext({
        resolvedProfile: policy(600),
        bootstrapFiles: [source(dir, "AGENTS.md", "a".repeat(1_000)), personal(dir, 500)],
      });

      const user = result?.contextFiles.find((file) => file.path.endsWith("USER.md"));
      expect(user).toMatchObject({ content: "u".repeat(500), personalUser: true });
      expect(result?.report.injectedChars).toBeLessThanOrEqual(600);
    });

    it("falls back to shared defaults when the personal file cannot fit the aggregate", async () => {
      const dir = await workspace();
      const result = await prepareAgentProfileWorkspaceContext({
        resolvedProfile: policy(300),
        bootstrapFiles: [personal(dir, 500)],
      });

      expect(result?.contextFiles).toEqual([]);
    });
  });

  it("bounds only the four managed files and leaves memory on the operator limits", async () => {
    const dir = await workspace();
    const memory = {
      name: "MEMORY.md",
      path: path.join(dir, "MEMORY.md"),
      content: "m".repeat(5_000),
      missing: false,
    } as const;
    const result = await prepareAgentProfileWorkspaceContext({
      resolvedProfile: resolvedProfile({ prompt: { workspaceContext: { totalMaxChars: 1_000 } } }),
      bootstrapFiles: [source(dir, "AGENTS.md", "a".repeat(5_000)), memory],
      config: {
        agents: { defaults: { bootstrapMaxChars: 20_000, bootstrapTotalMaxChars: 60_000 } },
      },
    });

    expect(result?.report.totalMaxChars).toBe(1_000);
    expect(result?.report.entries.map((entry) => entry.section)).toEqual(["agents"]);
    expect(result?.report.injectedChars).toBeLessThanOrEqual(1_000);
    const memoryFile = result?.contextFiles.find((file) => file.path === memory.path);
    expect(memoryFile?.content).toBe(memory.content);
  });

  it("uses operator limits as upper ceilings", async () => {
    const dir = await workspace();
    const result = await prepareAgentProfileWorkspaceContext({
      resolvedProfile: resolvedProfile({
        prompt: {
          workspaceContext: {
            totalMaxChars: 10_000,
            sections: { soul: { maxChars: 5_000 } },
          },
        },
      }),
      bootstrapFiles: [source(dir, "SOUL.md", "s".repeat(1_000))],
      config: {
        agents: { defaults: { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 400 } },
      },
    });

    expect(result?.report.totalMaxChars).toBe(400);
    expect(result?.report.entries[0]).toMatchObject({
      effectiveMaxChars: 300,
      injectedChars: 299,
      causes: ["section-limit"],
    });
  });

  it("truncates the stock IDENTITY.md template under openclaw/small instead of failing the turn", async () => {
    const dir = await workspace();
    const stockIdentity = [
      "# IDENTITY.md - Who Am I?",
      "",
      "_Fill this in during your first conversation. Make it yours._",
      "",
      "- **Name:**",
      "  _(pick something you like)_",
      "- **Creature:**",
      "  _(AI? robot? familiar? ghost in the machine? something weirder?)_",
      "- **Vibe:**",
      "  _(how do you come across? sharp? warm? chaotic? calm?)_",
      "- **Emoji:**",
      "  _(your signature, pick one that feels right)_",
      "- **Avatar:**",
      "  _(workspace-relative path, http(s) URL, or data URI)_",
      "",
      "---",
      "",
      "This isn't just metadata. It's the start of figuring out who you are.",
      "",
      "Notes:",
      "",
      "- Save this file at the workspace root as `IDENTITY.md`.",
      "- For avatars, use a workspace-relative path like `avatars/openclaw.png`, an `http(s)` URL, or a data URI.",
      "- Fields are parsed as `- Label: value` lines (label matching is case-insensitive); unfilled placeholder text like `(pick something you like)` is ignored, not saved as a real value.",
      "- The form above has no `Theme` line, and you do not need to add one. Gateway identity updates may add `Theme` to this file when they sync.",
      "- `Theme`, `Creature`, and `Vibe` all feed the same effective identity value when `openclaw agents set-identity` reads this file into agent config, preferred in that order (`Theme` wins if set, then `Creature`, then `Vibe`).",
    ].join("\n");
    expect(stockIdentity.length).toBeGreaterThan(1_024);

    const result = await prepareAgentProfileWorkspaceContext({
      resolvedProfile: resolveAgentProfile({
        config: { agents: { defaults: { agentProfileId: "openclaw/small" } } },
      }),
      bootstrapFiles: [
        source(dir, "AGENTS.md", "agent instructions"),
        source(dir, "IDENTITY.md", stockIdentity),
      ],
    });

    const identity = result?.contextFiles.find((file) => file.path.endsWith("IDENTITY.md"));
    expect(identity?.content.length).toBeLessThanOrEqual(1_024);
    expect(identity?.content).toContain("# IDENTITY.md - Who Am I?");
    expect(identity?.content).toContain("[...truncated, read IDENTITY.md for full content...]");
    expect(result?.report.entries.find((entry) => entry.section === "identity")?.causes).toContain(
      "section-limit",
    );
  });

  it("injects a 7,203-char AGENTS.md whole under openclaw/small, sentinel at 55% included", async () => {
    const dir = await workspace();
    const sentinel = "LAB-GREETING-SENTINEL: TANGERINE WAVE";
    const total = 7_203;
    const at = Math.floor(total * 0.55);
    const head = "x".repeat(at - 1) + "\n";
    const agents = head + sentinel + "\n" + "y".repeat(total - head.length - sentinel.length - 1);
    expect(agents.length).toBe(total);
    expect(agents.indexOf(sentinel)).toBeGreaterThan(total * 0.5);

    const result = await prepareAgentProfileWorkspaceContext({
      resolvedProfile: resolveAgentProfile({
        config: { agents: { defaults: { agentProfileId: "openclaw/small" } } },
      }),
      bootstrapFiles: [source(dir, "AGENTS.md", agents)],
    });

    const file = result?.contextFiles.find((entry) => entry.path.endsWith("AGENTS.md"));
    expect(file?.content).toBe(agents);
    expect(file?.content).toContain(sentinel);
  });
});
