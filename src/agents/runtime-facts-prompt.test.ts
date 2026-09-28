import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { MediaGenerationOperation } from "./media-generation-activity.js";
import * as mediaActivity from "./media-generation-activity.js";
import { buildRuntimeFactsContext } from "./runtime-facts-prompt.js";

const params = { capabilityToolNames: new Set(["exec"]), agentId: "main", cfg: {} };
afterEach(() => vi.restoreAllMocks());

describe("approved executable runtime facts", () => {
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
      vi.spyOn(execApprovals, "loadExecApprovals").mockImplementation(() => file);
      expect(await buildRuntimeFactsContext(params)).toEqual([
        { kind: "conversation-data", text: expect.any(String) },
      ]);
      const before = (await buildRuntimeFactsContext(params)).at(0)?.text;
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
      expect((await buildRuntimeFactsContext(params)).at(0)?.text).toBe(
        "## Approved executables\nnone",
      );
    }));

  it("bounds hints and omits command approvals, global wildcards, bare names, and unsafe or oversized tokens", () =>
    withMockedPlatform("win32", async () => {
      vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({
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

  it.each(["linux", "darwin", "win32"] as const)(
    "gates approval reads on Windows and exec capability: %s",
    (platform) =>
      withMockedPlatform(platform, async () => {
        const load = vi.spyOn(execApprovals, "loadExecApprovals").mockImplementation(() => {
          throw new Error("unavailable");
        });
        expect(
          await buildRuntimeFactsContext({ ...params, capabilityToolNames: new Set(["read"]) }),
        ).toEqual([]);
        expect(load).not.toHaveBeenCalled();
        const facts = (await buildRuntimeFactsContext(params)).at(0)?.text;
        if (platform === "win32") {
          expect(facts).toBe("## Approved executables\nunavailable");
        } else {
          expect(facts).toBeUndefined();
          expect(load).not.toHaveBeenCalled();
        }
      }),
  );
});

function createMediaTask(
  overrides: Partial<MediaGenerationOperation> = {},
): MediaGenerationOperation {
  return {
    taskId: "image-1",
    taskKind: "image_generation",
    sourceId: "image_generate:provider",
    requesterSessionKey: "agent:main:media",
    requesterAgentId: "main",
    task: "Generate media",
    status: "running",
    createdAt: 1,
    ...overrides,
  };
}

describe("media task runtime facts", () => {
  it("uses one native owner snapshot for enabled media and refreshes it next turn", async () => {
    const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations");
    const mediaParams = {
      ...params,
      sessionKey: "agent:main:media",
      capabilityToolNames: new Set(["video_generate", "image_generate", "music_generate"]),
    };
    read.mockReturnValue([
      createMediaTask({
        taskId: "video-1",
        taskKind: "video_generation",
        sourceId: "video_generate",
        status: "queued",
      }),
      createMediaTask({ taskId: "other-agent", requesterAgentId: "other" }),
      createMediaTask({ progressSummary: "Rendering" }),
      createMediaTask({
        taskId: "music-1",
        taskKind: "music_generation",
        sourceId: "music_generate",
      }),
    ]);
    expect(await buildRuntimeFactsContext(mediaParams)).toEqual([
      {
        kind: "conversation-data",
        text: [
          "## Media Generation Tasks",
          '- tool=image_generate; task=image-1; status=running; provider_json="provider"; progress_json="Rendering"',
          "- tool=music_generate; task=music-1; status=running",
          "- tool=video_generate; task=video-1; status=queued",
        ].join("\n"),
      },
    ]);
    expect(read).toHaveBeenCalledExactlyOnceWith("agent:main:media", "main");

    read.mockReturnValue([]);
    expect(await buildRuntimeFactsContext(mediaParams)).toEqual([
      {
        kind: "conversation-data",
        text: [
          "## Media Generation Tasks",
          "- tool=image_generate; none",
          "- tool=music_generate; none",
          "- tool=video_generate; none",
        ].join("\n"),
      },
    ]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      tools: ["music_generate"],
      expected: "## Media Generation Tasks\n- tool=music_generate; task=music-1; status=running",
    },
    {
      tools: ["music_generate", "video_generate"],
      expected:
        "## Media Generation Tasks\n- tool=music_generate; task=music-1; status=running\n- tool=video_generate; none",
    },
  ])("includes only enabled media sections: $tools", async ({ tools, expected }) => {
    const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations").mockReturnValue([
      createMediaTask(),
      createMediaTask({
        taskId: "music-1",
        taskKind: "music_generation",
        sourceId: "music_generate",
      }),
    ]);
    expect(
      await buildRuntimeFactsContext({
        ...params,
        sessionKey: "agent:main:media",
        capabilityToolNames: new Set(tools),
      }),
    ).toEqual([{ kind: "conversation-data", text: expected }]);
    expect(read).toHaveBeenCalledExactlyOnceWith("agent:main:media", "main");
  });

  it.each([undefined, "", "   "])(
    "keeps explicit empty media facts without session %j",
    async (sessionKey) => {
      const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations");
      expect(
        await buildRuntimeFactsContext({
          ...params,
          sessionKey,
          capabilityToolNames: new Set(["image_generate", "video_generate"]),
        }),
      ).toEqual([
        {
          kind: "conversation-data",
          text: "## Media Generation Tasks\n- tool=image_generate; none\n- tool=video_generate; none",
        },
      ]);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("does not read owner tasks without an enabled media capability", async () => {
    const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations");
    expect(
      await buildRuntimeFactsContext({
        ...params,
        sessionKey: "agent:main:media",
        capabilityToolNames: new Set(["read"]),
      }),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
