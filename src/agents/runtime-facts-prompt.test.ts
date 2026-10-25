import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { MediaGenerationOperation } from "./media-generation-activity.js";
import * as mediaActivity from "./media-generation-activity.js";
import { buildRuntimeFactsContext } from "./runtime-facts-prompt.js";

const params = { capabilityToolNames: new Set(["exec"]), agentId: "main", cfg: {} };
const fact = (text: string) => ({ kind: "conversation-data", text });
const temporalFact = fact(expect.stringContaining("## Temporal Context\n"));
const contextFacts = (text: string) => [fact(text), temporalFact];
const mediaParams = (tools: string[]) => ({
  ...params,
  sessionKey: "agent:main:media",
  capabilityToolNames: new Set(tools),
});
const mediaFacts = (lines: string[]) =>
  contextFacts(["## Media Generation Tasks", ...lines].join("\n"));
async function expectContext(
  input: Parameters<typeof buildRuntimeFactsContext>[0],
  expected: unknown = [temporalFact],
) {
  expect(await buildRuntimeFactsContext(input)).toEqual(expected);
}
afterEach(() => vi.restoreAllMocks());

it.each([{ tools: [] }, { tools: ["session_status"] }])(
  "refreshes the date after midnight and timezone changes with tools %j",
  async ({ tools }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-01T06:59:59Z"));
    const capabilityToolNames = new Set(tools);
    const cfg = { agents: { defaults: { userTimezone: "America/Los_Angeles" } } };
    const contextParams = { ...params, cfg, capabilityToolNames, executionHost: false };
    const exactTimeHint = capabilityToolNames.has("session_status")
      ? "\nFor the exact current time, use `session_status`."
      : "";
    const first = await buildRuntimeFactsContext(contextParams);
    clock.mockReturnValue(Date.parse("2026-09-01T07:00:00Z"));
    const nextDay = await buildRuntimeFactsContext(contextParams);
    cfg.agents.defaults.userTimezone = "Pacific/Honolulu";
    const nextZone = await buildRuntimeFactsContext(contextParams);

    expect([first, nextDay, nextZone]).toEqual(
      [
        ["2026-08-31", "America/Los_Angeles"],
        ["2026-09-01", "America/Los_Angeles"],
        ["2026-08-31", "Pacific/Honolulu"],
      ].map(([date, zone]) => [
        fact(`## Temporal Context\nCurrent date: ${date}\nTime zone: ${zone}${exactTimeHint}`),
      ]),
    );
  },
);
it("sorts current agent and wildcard hints, preserves paths and argument notes, and clears stale hints", () =>
  withMockedPlatform("win32", async () => {
    const file: execApprovals.ExecApprovalsFile = {
      version: 1,
      agents: {
        main: { allowlist: [{ pattern: "C:\\Tools\\z.exe", argPattern: "--version" }] },
        "*": { allowlist: [{ pattern: "C:\\Tools\\a.exe" }] },
        other: { allowlist: [{ pattern: "C:\\Private\\other.exe" }] },
      },
    };
    vi.spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync").mockImplementation(async () => file);
    const initial = await buildRuntimeFactsContext(params);
    expect(initial).toEqual(contextFacts(expect.any(String)));
    const before = initial.at(0)?.text;
    expect(before).toContain("## Approved executables");
    expect(before).toContain(
      "exact arguments are enforced at runtime; no approval prompt needed when args match",
    );
    expect(before).toContain(
      "C:\\Tools\\a.exe (any arguments)\n  C:\\Tools\\z.exe (restricted args)",
    );
    expect(before).not.toContain("other.exe");
    file.agents!.main!.allowlist!.unshift({ pattern: "C:\\Tools\\b.exe" });
    const added = (await buildRuntimeFactsContext(params)).at(0)?.text;
    expect(added).toContain("b.exe (any arguments)");
    file.agents!.main!.allowlist!.reverse();
    expect((await buildRuntimeFactsContext(params)).at(0)?.text).toBe(added);
    file.agents = {};
    await expectContext(params);
    expect(
      (await buildRuntimeFactsContext({ ...params, includeEmptySnapshots: true })).at(0)?.text,
    ).toBe("## Approved executables\nnone");
  }));

it("bounds hints and omits command approvals, global wildcards, bare names, and unsafe or oversized tokens", () =>
  withMockedPlatform("win32", async () => {
    vi.spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync").mockResolvedValue({
      version: 1,
      agents: {
        main: {
          allowlist: [
            ...[
              "*",
              "node",
              "=command:C:\\Tools\\node.exe --version",
              "C:\\bad\nname.exe",
              `C:\\${"x".repeat(300)}.exe`,
            ].map((pattern) => ({ pattern })),
            ...Array.from({ length: 12 }, (_, i) => ({
              pattern: `C:\\Tools\\app${String(i).padStart(2, "0")}.exe`,
            })).toReversed(),
          ],
        },
      },
    });
    const facts = expectDefined(
      (await buildRuntimeFactsContext(params)).at(0),
      "approved executable facts",
    ).text;
    expect(facts.match(/\(any arguments\)/g)).toHaveLength(10);
    expect(facts).toContain("app00.exe");
    expect(facts).toContain("app09.exe");
    expect(facts).not.toMatch(/app10|app11|=command:|bad|xxx/);
    expect(facts.length).toBeLessThan(3000);
  }));

it.each(["linux", "win32"] as const)(
  "gates approval reads on Windows and exec capability: %s",
  (platform) =>
    withMockedPlatform(platform, async () => {
      const load = vi
        .spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync")
        .mockImplementation(async () => {
          throw new Error("unavailable");
        });
      await expectContext({ ...params, capabilityToolNames: new Set(["read"]) });
      await expectContext({
        ...params,
        executionHost: false,
        capabilityToolNames: new Set(["exec", "process"]),
      });
      expect(load).not.toHaveBeenCalled();
      const facts = (await buildRuntimeFactsContext(params)).find((fragment) =>
        fragment.text.startsWith("## Approved executables\n"),
      )?.text;
      if (platform === "win32") {
        expect(facts).toBe("## Approved executables\nunavailable");
      } else {
        expect(facts).toBeUndefined();
        expect(load).not.toHaveBeenCalled();
      }
    }),
);
function createMediaTask(
  tool: "image" | "music" | "video" = "image",
  overrides: Partial<MediaGenerationOperation> = {},
): MediaGenerationOperation {
  return {
    taskId: `${tool}-1`,
    taskKind: `${tool}_generation`,
    sourceId: tool === "image" ? "image_generate:provider" : `${tool}_generate`,
    requesterSessionKey: "agent:main:media",
    requesterAgentId: "main",
    task: "Generate media",
    status: "running",
    ...overrides,
  };
}

it("uses one native owner snapshot for enabled media and refreshes it next turn", async () => {
  const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations");
  const contextParams = {
    ...mediaParams(["exec", "process", "video_generate", "image_generate", "music_generate"]),
    executionHost: false,
  };
  read.mockReturnValue([
    createMediaTask("video", { status: "queued" }),
    createMediaTask("image", { taskId: "other-agent", requesterAgentId: "other" }),
    createMediaTask("image", { progressSummary: "Rendering" }),
    createMediaTask("music"),
  ]);
  await expectContext(
    contextParams,
    mediaFacts([
      '- tool=image_generate; task=image-1; status=running; provider_json="provider"; progress_json="Rendering"',
      "- tool=music_generate; task=music-1; status=running",
      "- tool=video_generate; task=video-1; status=queued",
    ]),
  );
  expect(read).toHaveBeenCalledExactlyOnceWith("agent:main:media", "main");

  read.mockReturnValue([]);
  await expectContext(contextParams);
  await expectContext(
    { ...contextParams, includeEmptySnapshots: true },
    mediaFacts([
      "- tool=image_generate; none",
      "- tool=music_generate; none",
      "- tool=video_generate; none",
    ]),
  );
  expect(read).toHaveBeenCalledTimes(3);
});

it("includes only enabled media sections", async () => {
  const tools = ["music_generate", "video_generate"];
  const read = vi
    .spyOn(mediaActivity, "listMediaGenerationOperations")
    .mockReturnValue([createMediaTask(), createMediaTask("music")]);
  await expectContext(
    mediaParams(tools),
    mediaFacts(["- tool=music_generate; task=music-1; status=running"]),
  );
  await expectContext(
    { ...mediaParams(tools), includeEmptySnapshots: true },
    mediaFacts([
      "- tool=music_generate; task=music-1; status=running",
      "- tool=video_generate; none",
    ]),
  );
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([undefined, "", "   "])(
  "omits empty media facts without session %j unless retained",
  async (sessionKey) => {
    const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations");
    const contextParams = { ...mediaParams(["image_generate", "video_generate"]), sessionKey };
    await expectContext(contextParams);
    await expectContext(
      { ...contextParams, includeEmptySnapshots: true },
      mediaFacts(["- tool=image_generate; none", "- tool=video_generate; none"]),
    );
    expect(read).not.toHaveBeenCalled();
  },
);
