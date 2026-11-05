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
  ])(
    "delimits the complete native carrier on creation and refresh ($policy)",
    async ({ policy, refreshable }) => {
      const params = createThreadRequestAttemptParams({ provider: "openai" });
      const options = {
        appServer: createThreadRequestAppServerOptions(),
        developerInstructions: policy,
        refreshableInstructions: refreshable,
      };
      const start = await buildThreadStartParams(params, {
        ...options,
        cwd: "/repo",
        dynamicTools: [],
      });
      const resume = await buildThreadResumeParams(params, { ...options, threadId: "root" });
      const expected = `<openclaw_thread_policy>\n${[policy, refreshable].filter(Boolean).join("\n\n")}\n</openclaw_thread_policy>`;
      expect(start.developerInstructions).toBe(expected);
      expect(resume.developerInstructions).toBe(expected);
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
        expect(text).toContain("fully replaces only earlier blocks with the same tag");
        expect(text).not.toContain("legacy OpenClaw-supplied generic policy");
        expect(text).toContain("an empty block withdraws their entire policy");
        expect(text).toContain("Rules omitted from it are withdrawn from those blocks");
        expect(text).toContain("Instructions outside those blocks retain their authority");
        expect(text).toContain(
          "does not erase conversation history, facts or results, or cancel unfinished user requests",
        );
        expect(text.endsWith(expected)).toBe(true);
      } finally {
        await h.client.closeAndWait();
      }
    },
  );
});
