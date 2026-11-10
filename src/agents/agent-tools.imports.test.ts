import { expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

it("keeps cold chat preparation independent of tool construction", () => {
  expect(
    findSourceImportBackedges(
      [
        "src/gateway/server-methods/chat-send-external-entry.ts",
        "src/agents/embedded-agent-runner/run/attempt.ts",
      ],
      [
        "src/agents/agent-tools.ts",
        "src/agents/agent-tools.preparation-sync.ts",
        "src/agents/core-coding-tools.ts",
        "src/agents/openclaw-tools.ts",
        "src/agents/openclaw-plugin-tools.ts",
        "src/agents/harness/host-capability.ts",
        "src/agents/tools/cron-tool.ts",
      ],
    ),
  ).toEqual([]);
});
