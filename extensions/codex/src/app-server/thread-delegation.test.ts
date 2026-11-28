import { expect, it } from "vitest";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import { buildThreadStartParams } from "./thread-requests.js";

it("uses sessions_spawn as the only delegation surface for unrestricted threads", async () => {
  const start = await buildThreadStartParams(createAttemptParams({ provider: "openai" }), {
    appServer: createAppServerOptions() as never,
    cwd: "/repo",
    config: { "features.multi_agent": true },
    dynamicTools: [
      {
        type: "function",
        name: "sessions_spawn",
        description: "Create an OpenClaw child session.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });

  expect(start.config).toMatchObject({
    "agents.enabled": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
  });
  expect(start.developerInstructions).not.toContain("spawn_agent");
});

it("never advertises unavailable delegation tools", () => {
  for (const params of [
    Object.assign(createAttemptParams({ provider: "openai" }), {
      delegationCapability: "report_only" as const,
    }),
    Object.assign(createAttemptParams({ provider: "openai" }), { toolsAllow: ["openclaw"] }),
    Object.assign(createAttemptParams({ provider: "openai" }), { disableTools: true }),
  ]) {
    expect(buildDeveloperInstructions(params)).not.toContain("`sessions_spawn`");
  }
});
