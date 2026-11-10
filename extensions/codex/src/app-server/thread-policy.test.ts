import { describe, expect, it } from "vitest";
import { createClientHarness } from "./test-support.js";
import {
  createThreadRequestAppServerOptions,
  createThreadRequestAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import { refreshCodexThreadPolicy } from "./thread-policy.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";

describe("native thread policy refresh", () => {
  it.each([
    { policy: "shared runtime policy", refreshable: "Current skills and persona" },
    { policy: "", refreshable: undefined },
    { policy: "shared runtime policy", refreshable: undefined, nativeBase: true },
  ])(
    "delimits the complete native carrier on creation and refresh ($policy)",
    async ({ policy, refreshable, ...scenario }) => {
      const params = createThreadRequestAttemptParams({ provider: "openai" });
      const options = {
        appServer: createThreadRequestAppServerOptions(),
        developerInstructions: policy,
        refreshableInstructions: refreshable,
        config:
          "nativeBase" in scenario ? { instructions: "Independent operator policy" } : undefined,
      };
      const start = await buildThreadStartParams(params, {
        ...options,
        cwd: "/repo",
        dynamicTools: [],
      });
      const resume = await buildThreadResumeParams(params, { ...options, threadId: "root" });
      const expected = `<thread_policy>\n${[policy, refreshable].filter(Boolean).join("\n\n")}\n</thread_policy>`;
      if ("nativeBase" in scenario) {
        expect(start.baseInstructions).toBeUndefined();
        expect(start.developerInstructions).toMatch(/^<thread_policy>\nYou are/);
        expect(start.developerInstructions).not.toContain("Independent operator policy");
        expect(start.developerInstructions?.match(/<thread_policy>/g)).toHaveLength(1);
        expect(start.developerInstructions).toMatch(/shared runtime policy\n<\/thread_policy>$/);
      } else {
        expect(start.developerInstructions).toBe(expected);
      }
      expect(resume.developerInstructions).toBe(start.developerInstructions);
      const h = createClientHarness();
      try {
        const update = refreshCodexThreadPolicy({
          client: h.client,
          threadId: "root",
          developerInstructions: resume.developerInstructions,
          timeoutMs: 1_000,
          assertCurrent: () => {},
        });
        const request = JSON.parse(await h.waitForWrite(0));
        h.send({ id: request.id, result: {} });
        await update;
        expect(request.method).toBe("thread/inject_items");
        const text = request.params.items[0].content[0].text;
        expect(text).toContain("legacy unframed OpenClaw generic policy");
        expect(text).toContain("Omitted rules are withdrawn; an empty block withdraws that policy");
        expect(text).toContain(
          "Independent native, project and current-request instructions retain authority",
        );
        expect(text).toContain("Preserve history and unfinished user requests");
        expect(text.endsWith(resume.developerInstructions)).toBe(true);
      } finally {
        await h.client.closeAndWait();
      }
    },
  );
});
