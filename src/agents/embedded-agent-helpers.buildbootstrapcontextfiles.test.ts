import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { extractFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./embedded-agent-helpers/bootstrap.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});

const QUOTED_HEARTBEAT_EXAMPLE =
  "`Check STATUS.md if it exists. Follow it strictly. Do not repeat old tasks from prior chats. If nothing needs attention, reply STATUS_OK.`";

function renderFile(
  file: Partial<WorkspaceBootstrapFile>,
  opts?: Parameters<typeof buildBootstrapContextFiles>[1],
) {
  return buildBootstrapContextFiles([makeFile(file)], opts)[0]?.content;
}

function renderMiddle(lines: string[], maxChars: number) {
  return renderFile(
    {
      content: `# AGENTS.md\n\n${"A".repeat(9000)}\n\n${lines.join("\n")}\n\n${"B".repeat(7000)}\ntail marker`,
    },
    { maxChars },
  );
}

describe("buildBootstrapContextFiles", () => {
  it.each([1500, 3000])("keeps seeded workspace safety guidance within %i chars", (maxChars) => {
    const template = fs.readFileSync(
      new URL("../../docs/reference/templates/AGENTS.md", import.meta.url),
      "utf-8",
    );
    const content = extractFrontmatterBlock(template)?.body.trimStart() ?? template;
    const injected = renderFile({ content }, { maxChars });
    expect(injected?.length).toBeLessThanOrEqual(maxChars);
    for (const instruction of [
      "Don't share private data with people or services the user didn't ask for.",
      "Confirm destructive or irreversible actions the user didn't ask for.",
      "Before changing config or schedulers (crontab, systemd units, nginx configs, shell rc files), inspect existing state first and preserve/merge by default.",
      "Prefer `trash` over `rm` - recoverable beats gone forever.",
      ...(maxChars === 3000
        ? [
            "**Do freely:** anything the user asked for, including sending messages, emails, or posts on their behalf; read files, explore, organize, learn; search the web, check calendars; work within this workspace.",
            "**Ask first:** public or outbound actions the user did not request.",
            "Recommend paid services only with explicit spend approval.",
          ]
        : []),
    ]) {
      expect(injected).toContain(instruction);
    }
  });

  it("skips empty or whitespace-only content", () => {
    expect(buildBootstrapContextFiles([makeFile({ content: "   \n  " })])).toStrictEqual([]);
  });
  it("truncates large bootstrap content with a warning and bounded head/tail", () => {
    const content = `HEAD-${"a".repeat(600)}${"b".repeat(300)}-TAIL`;
    const warn = vi.fn();
    const result = renderFile({ name: "SOUL.md", content }, { maxChars: 200, warn });
    expect(result).toHaveLength(199);
    expect(result).toContain("[...truncated, read SOUL.md for full content...]");
    expect(result).toContain("kept 75+25 chars");
    expect(result?.startsWith(content.slice(0, 75))).toBe(true);
    expect(result?.endsWith(content.slice(-25))).toBe(true);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(/SOUL\.md.*limit 200/),
    ]);
  });
  it("warns once per path, content revision, and effective limit across context builds", () => {
    const file = makeFile({ path: "/warning-revisions/AGENTS.md", content: "a".repeat(1000) });
    const warn = vi.fn();
    const build = (overrides: Partial<WorkspaceBootstrapFile> = {}, maxChars = 200) =>
      buildBootstrapContextFiles([{ ...file, ...overrides }], { maxChars, warn });

    // A diagnostics build without a logger must not consume the warning.
    buildBootstrapContextFiles([file], { maxChars: 200 });
    const first = build();
    expect(build()).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);

    const edited = build({ content: "b".repeat(1000) });
    expect(edited).not.toEqual(first);
    expect(build({ content: "b".repeat(1000) })).toEqual(edited);
    expect(warn).toHaveBeenCalledTimes(2);
    build({}, 300);
    build({ path: "/other-workspace/AGENTS.md" });
    expect(warn).toHaveBeenCalledTimes(4);
    expect(build()).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(4);

    buildBootstrapContextFiles([file], { maxChars: 200, totalMaxChars: 150, warn });
    buildBootstrapContextFiles([file], { maxChars: 200, totalMaxChars: 150, warn });
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it.each([
    { name: "SOUL.md", maxChars: 200, head: 73, middle: 200, tail: 23 },
    { name: "AGENTS.md", maxChars: 600, head: 269, middle: 638, tail: 89 },
  ] as const)(
    "keeps $name truncation valid at UTF-16 boundaries",
    ({ name, maxChars, head, middle, tail }) => {
      const content = `${"h".repeat(head)}😀${"m".repeat(middle)}😀${"t".repeat(tail)}`;
      const result = renderFile({ name, content }, { maxChars });
      expect(result?.startsWith("h".repeat(head))).toBe(true);
      expect(result?.endsWith("t".repeat(tail))).toBe(true);
      expect(result).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    },
  );
  it.each([
    { padding: 51, fits: true },
    { padding: 52, fits: false },
  ])("selects the whole framed unit when fits=$fits", ({ padding, fits }) => {
    const frame = "Example " + "x".repeat(padding);
    const content = renderMiddle([frame, QUOTED_HEARTBEAT_EXAMPLE], 600);

    if (fits) {
      expect(content).toContain([frame, QUOTED_HEARTBEAT_EXAMPLE].join("\n"));
      expect(content).not.toContain("more policy lines omitted");
    } else {
      expect(content).not.toContain(frame);
      expect(content).not.toContain(QUOTED_HEARTBEAT_EXAMPLE);
      expect(content).toContain("[...1 more policy lines omitted...]");
    }
    expect(content?.length).toBeLessThanOrEqual(600);
  });

  it("clears framing at a backtick closing boundary", () => {
    const candidate = "Never commit secrets without validation.";
    const content = renderMiddle(["```", "Example policy:", "```", candidate], 2000);
    expect(content).toContain(candidate);
    expect(content).not.toContain("Example policy:");
    expect(content).not.toContain("```");
    expect(content).not.toContain("~~~");
    expect(content?.length).toBeLessThanOrEqual(2000);
  });

  it("keeps repeated frames local and ordered", () => {
    const first = "Never commit secrets without validation.";
    const middle = "Must read scoped AGENTS.md before subtree work.";
    const frame = "Example policy:";
    const result = renderMiddle([frame, first, "", middle, "", frame, first], 2000);
    expect(result).toContain([frame, first, middle, frame, first].join("\n"));
    expect(result?.split(frame)).toHaveLength(3);
    expect(result?.length).toBeLessThanOrEqual(2000);
  });

  it("prioritizes Traditional Chinese mandatory bullets", () => {
    const earlyShort = "- Early normal ".padEnd(20, "a");
    const earlyLong = "- Normal payload ".padEnd(70, "b");
    const urgent = "- 嚴禁共用登入帳號 ".padEnd(140, "字");
    const lateShort = "- Late normal ".padEnd(20, "d");
    const content = renderMiddle([earlyShort, "", earlyLong, "", urgent, "", lateShort], 600);

    expect(content).toContain([earlyShort, urgent, lateShort].join("\n"));
    expect(content).not.toContain(earlyLong);
    expect(content).toContain("[...1 more policy lines omitted...]");
    expect(content?.length).toBeLessThanOrEqual(600);
  });
  it("keeps source bytes with compact markers at budget 22", () => {
    const result = renderFile(
      { name: "USER.md", content: `HEAD-${"a".repeat(1_000)}-TAIL` },
      { maxChars: 22 },
    );
    expect(result?.startsWith("H")).toBe(true);
    expect(result).toContain("truncated");
    expect(result?.length).toBeLessThanOrEqual(22);
  });

  it("enforces strict total cap even when truncation markers are present", () => {
    const result = buildBootstrapContextFiles(
      [
        makeFile({ name: "AGENTS.md", content: "a".repeat(1_000) }),
        makeFile({ name: "SOUL.md", path: "/tmp/SOUL.md", content: "b".repeat(1_000) }),
      ],
      { maxChars: 100, totalMaxChars: 150 },
    );
    expect(result.reduce((sum, entry) => sum + entry.content.length, 0)).toBeLessThanOrEqual(150);
    expect(result).toHaveLength(1);
  });

  it("keeps missing markers under small total budgets", () => {
    const result = buildBootstrapContextFiles([makeFile({ missing: true, content: undefined })], {
      totalMaxChars: 20,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.content.length).toBeLessThanOrEqual(20);
    expect(result[0]?.content.startsWith("[MISSING]")).toBe(true);
  });

  it("skips files with missing or invalid paths and emits warnings", () => {
    const warnings: string[] = [];
    const result = buildBootstrapContextFiles(
      [makeFile({ path: "   ", content: "secret" }), makeFile({ content: "hello" })],
      { warn: (msg) => warnings.push(msg) },
    );
    expect(result).toMatchObject([{ path: "/tmp/AGENTS.md" }]);
    expect(warnings).toEqual([expect.stringContaining('missing or invalid "path" field')]);
  });
});

describe("bootstrap limit resolvers", () => {
  const defaults = { bootstrapMaxChars: 12345, bootstrapTotalMaxChars: 12345 };
  const invalidWorker: OpenClawConfig = {
    agents: {
      defaults,
      entries: {
        worker: { bootstrapMaxChars: 0, bootstrapTotalMaxChars: 0 },
      },
    },
  };
  it.each([
    ["defaults", { agents: { defaults } }, undefined, [12345, 12345]],
    ["unconfigured agent", { agents: { defaults } }, "worker", [12345, 12345]],
    ["invalid zero", invalidWorker, "worker", [20_000, 60_000]],
  ] satisfies [string, OpenClawConfig | undefined, string | undefined, number[]][])(
    "resolves %s limits",
    (_name, cfg, agentId, expected) => {
      expect([
        resolveBootstrapMaxChars(cfg, agentId),
        resolveBootstrapTotalMaxChars(cfg, agentId),
      ]).toEqual(expected);
    },
  );
});
