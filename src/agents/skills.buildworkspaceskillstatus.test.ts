import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import type { SkillEntry } from "./skills/types.js";

function makeEntry(params: {
  name: string;
  source?: string;
  os?: string[];
  requires?: { bins?: string[]; env?: string[]; config?: string[] };
  install?: Array<{
    id: string;
    kind: "brew" | "download";
    bins?: string[];
    formula?: string;
    os?: string[];
    url?: string;
    label?: string;
  }>;
}): SkillEntry {
  return {
    skill: {
      name: params.name,
      description: `desc:${params.name}`,
      source: params.source ?? "openclaw-workspace",
      filePath: `/tmp/${params.name}/SKILL.md`,
      baseDir: `/tmp/${params.name}`,
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata: {
      ...(params.os ? { os: params.os } : {}),
      ...(params.requires ? { requires: params.requires } : {}),
      ...(params.install ? { install: params.install } : {}),
      ...(params.requires?.env?.[0] ? { primaryEnv: params.requires.env[0] } : {}),
    },
  };
}

describe("buildWorkspaceSkillStatus", () => {
  it("reports missing requirements and install options", async () => {
    const entry = makeEntry({
      name: "status-skill",
      requires: {
        bins: ["fakebin"],
        env: ["ENV_KEY"],
        config: ["browser.enabled"],
      },
      install: [
        {
          id: "brew",
          kind: "brew",
          formula: "fakebin",
          bins: ["fakebin"],
          label: "Install fakebin",
        },
      ],
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
        config: { browser: { enabled: false } },
      }),
    );
    const skill = report.skills.find((entry) => entry.name === "status-skill");

    expect(skill).toBeDefined();
    expect(skill?.eligible).toBe(false);
    expect(skill?.missing.bins).toContain("fakebin");
    expect(skill?.missing.env).toContain("ENV_KEY");
    expect(skill?.missing.config).toContain("browser.enabled");
    expect(skill?.install[0]?.id).toBe("brew");
  });
  it("respects OS-gated skills", async () => {
    const entry = makeEntry({
      name: "os-skill",
      os: ["darwin"],
    });

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills.find((entry) => entry.name === "os-skill");

    expect(skill).toBeDefined();
    if (process.platform === "darwin") {
      expect(skill?.eligible).toBe(true);
      expect(skill?.missing.os).toEqual([]);
    } else {
      expect(skill?.eligible).toBe(false);
      expect(skill?.missing.os).toEqual(["darwin"]);
    }
  });
  it("marks bundled skills blocked by allowlist", async () => {
    const entry = makeEntry({
      name: "peekaboo",
      source: "openclaw-bundled",
    });

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [entry],
      config: { skills: { allowBundled: ["other-skill"] } },
    });
    const skill = report.skills.find((reportEntry) => reportEntry.name === "peekaboo");

    expect(skill).toBeDefined();
    expect(skill?.blockedByAllowlist).toBe(true);
    expect(skill?.eligible).toBe(false);
    expect(skill?.bundled).toBe(true);
  });

  it("filters install options by OS", async () => {
    const entry = makeEntry({
      name: "install-skill",
      requires: {
        bins: ["missing-bin"],
      },
      install: [
        {
          id: "mac",
          kind: "download",
          os: ["darwin"],
          url: "https://example.com/mac.tar.bz2",
        },
        {
          id: "linux",
          kind: "download",
          os: ["linux"],
          url: "https://example.com/linux.tar.bz2",
        },
        {
          id: "win",
          kind: "download",
          os: ["win32"],
          url: "https://example.com/win.tar.bz2",
        },
      ],
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
      }),
    );
    const skill = report.skills.find((reportEntry) => reportEntry.name === "install-skill");

    expect(skill).toBeDefined();
    if (process.platform === "darwin") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["mac"]);
    } else if (process.platform === "linux") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["linux"]);
    } else if (process.platform === "win32") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["win"]);
    } else {
      expect(skill?.install).toEqual([]);
    }
  });
});
