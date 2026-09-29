import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./embedded-agent-helpers.js";
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

function makeMiddleBootstrapFile(lines: string[]): WorkspaceBootstrapFile {
  return makeFile({
    content: [
      "# AGENTS.md",
      "",
      "A".repeat(9000),
      "",
      ...lines,
      "",
      "B".repeat(7000),
      "tail marker",
    ].join("\n"),
  });
}

function renderMiddle(lines: string[], maxChars: number) {
  return buildBootstrapContextFiles([makeMiddleBootstrapFile(lines)], { maxChars })[0]?.content;
}

describe("buildBootstrapContextFiles", () => {
  it("keeps missing markers", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    expect(buildBootstrapContextFiles(files)).toEqual([
      {
        path: "/tmp/AGENTS.md",
        content: "[MISSING] Expected at: /tmp/AGENTS.md",
      },
    ]);
  });
  it("skips empty or whitespace-only content", () => {
    const files = [makeFile({ content: "   \n  " })];
    expect(buildBootstrapContextFiles(files)).toStrictEqual([]);
  });
  it("truncates large bootstrap content with a warning and bounded head/tail", () => {
    const content = `HEAD-${"a".repeat(600)}${"b".repeat(300)}-TAIL`;
    const warnings: string[] = [];
    const [result] = buildBootstrapContextFiles([makeFile({ name: "SOUL.md", content })], {
      maxChars: 200,
      warn: (message) => warnings.push(message),
    });
    expect(result?.content).toHaveLength(199);
    expect(result?.content).toContain("[...truncated, read SOUL.md for full content...]");
    expect(result?.content).toContain("kept 75+25 chars");
    expect(result?.content.startsWith(content.slice(0, 75))).toBe(true);
    expect(result?.content.endsWith(content.slice(-25))).toBe(true);
    expect(warnings).toEqual([expect.stringMatching(/SOUL\.md.*limit 200/)]);
  });
  it.each([
    { name: "SOUL.md", maxChars: 200, head: 73, middle: 200, tail: 23 },
    { name: "AGENTS.md", maxChars: 600, head: 269, middle: 638, tail: 89 },
  ] as const)(
    "keeps $name truncation valid at UTF-16 boundaries",
    ({ name, maxChars, head, middle, tail }) => {
      const content = `${"h".repeat(head)}😀${"m".repeat(middle)}😀${"t".repeat(tail)}`;
      const [result] = buildBootstrapContextFiles([makeFile({ name, content })], { maxChars });
      expect(result?.content.startsWith("h".repeat(head))).toBe(true);
      expect(result?.content.endsWith("t".repeat(tail))).toBe(true);
      expect(result?.content).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    },
  );
  it("gives USER.md its own small bootstrap budget", () => {
    const files = [
      makeFile({
        name: "USER.md",
        path: "/tmp/USER.md",
        content: "u".repeat(10_000),
      }),
      makeFile({
        name: "MEMORY.md",
        path: "/tmp/MEMORY.md",
        content: "m".repeat(10_000),
      }),
    ];
    const result = buildBootstrapContextFiles(files);

    expect(result[0]?.content.length).toBeLessThanOrEqual(4_000);
    expect(result[0]?.content).toContain("read USER.md for full content");
    expect(result[1]?.content).toBe("m".repeat(10_000));
  });
  it("keeps non-Latin mandatory policy lines from oversized AGENTS.md middle content", () => {
    const mandatory = "禁止在此子树使用共享账号";
    const ordinary = "请保持本段内容简洁";
    const content = [
      "# Root policy",
      "A".repeat(900),
      "",
      mandatory,
      "",
      ordinary,
      "B".repeat(700),
      "tail marker",
    ].join("\n");
    const [result] = buildBootstrapContextFiles([makeFile({ content })], {
      maxChars: 600,
    });

    expect(result?.content).toContain("[Policy digest from AGENTS.md]");
    expect(result?.content).toContain(mandatory);
    expect(result?.content).not.toContain(ordinary);
    expect(result?.content.length).toBeLessThanOrEqual(600);
  });
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

  it.each([
    { name: "blank line", before: ["Example policy:", ""], after: [] },
    { name: "backtick closing", before: ["```", "Example policy:", "```"], after: [] },
  ])("clears framing at a $name boundary", ({ before, after }) => {
    const candidate = "Never commit secrets without validation.";
    const content = renderMiddle([...before, candidate, ...after], 2000);

    expect(content).toContain(candidate);
    expect(content).not.toContain("Example policy:");
    expect(content).not.toContain("```");
    expect(content).not.toContain("~~~");
    expect(content?.length).toBeLessThanOrEqual(2000);
  });

  it.each(["Never commit secrets without validation."])(
    "keeps repeated frames local and ordered for %s",
    (second) => {
      const first = "Never commit secrets without validation.";
      const middle = "Must read scoped AGENTS.md before subtree work.";
      const frame = "Example policy:";
      const [result] = buildBootstrapContextFiles(
        [makeMiddleBootstrapFile([frame, first, "", middle, "", frame, second])],
        { maxChars: 2000 },
      );

      expect(result?.content).toContain([frame, first, middle, frame, second].join("\n"));
      expect(result?.content.split(frame)).toHaveLength(3);
      expect(result?.content.length).toBeLessThanOrEqual(2000);
    },
  );

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
  it.each([
    { maxChars: 64, head: "HEAD-", tail: "-TAIL" },
    { maxChars: 22, head: "H", tail: "" },
  ])("keeps source bytes with compact markers at budget $maxChars", ({ maxChars, head, tail }) => {
    const [result] = buildBootstrapContextFiles(
      [makeFile({ name: "USER.md", content: `HEAD-${"a".repeat(1_000)}-TAIL` })],
      { maxChars },
    );
    expect(result?.content.startsWith(head)).toBe(true);
    expect(result?.content.endsWith(tail)).toBe(true);
    expect(result?.content).toContain("truncated");
    expect(result?.content.length).toBeLessThanOrEqual(maxChars);
  });

  it("enforces strict total cap even when truncation markers are present", () => {
    const files = [
      makeFile({ name: "AGENTS.md", content: "a".repeat(1_000) }),
      makeFile({ name: "SOUL.md", path: "/tmp/SOUL.md", content: "b".repeat(1_000) }),
    ];
    const result = buildBootstrapContextFiles(files, {
      maxChars: 100,
      totalMaxChars: 150,
    });
    const totalChars = result.reduce((sum, entry) => sum + entry.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(150);
    expect(result).toHaveLength(1);
  });

  it("keeps missing markers under small total budgets", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    const result = buildBootstrapContextFiles(files, {
      totalMaxChars: 20,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.content.length).toBeLessThanOrEqual(20);
    expect(result[0]?.content.startsWith("[MISSING]")).toBe(true);
  });

  it("skips files with missing or invalid paths and emits warnings", () => {
    const malformed = makeFile({ path: "   ", content: "secret" });
    const good = makeFile({ content: "hello" });
    const warnings: string[] = [];
    const result = buildBootstrapContextFiles([malformed, good], {
      warn: (msg) => warnings.push(msg),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("/tmp/AGENTS.md");
    expect(warnings).toHaveLength(1);
    expect(
      warnings.filter((warning) => !warning.includes('missing or invalid "path" field')),
    ).toStrictEqual([]);
  });
});

describe("bootstrap limit resolvers", () => {
  const defaults = { bootstrapMaxChars: 12345, bootstrapTotalMaxChars: 12345 };
  const forWorker = (value: number | undefined): OpenClawConfig => ({
    agents: {
      defaults,
      entries: { worker: { bootstrapMaxChars: value, bootstrapTotalMaxChars: value } },
    },
  });
  it.each([
    ["unset", undefined, undefined, [20_000, 60_000]],
    ["defaults", { agents: { defaults } }, undefined, [12345, 12345]],
    ["unconfigured agent", { agents: { defaults } }, "worker", [12345, 12345]],
    ["invalid zero", forWorker(0), "worker", [20_000, 60_000]],
    ["invalid nonfinite", forWorker(Number.NaN), "worker", [20_000, 60_000]],
    ["inherit", forWorker(undefined), "worker", [12345, 12345]],
    [
      "fractional override",
      {
        agents: {
          defaults,
          list: [{ id: "worker", bootstrapMaxChars: 0.5, bootstrapTotalMaxChars: 0.5 }],
        },
      },
      "worker",
      [0, 0],
    ],
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
