import { describe, expect, it } from "vitest";
import type { JsonObject } from "./protocol.js";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";

describe("Codex blocking question ownership", () => {
  it.each<JsonObject>([
    { "tools.experimental_request_user_input.enabled": true },
    { tools: { experimental_request_user_input: { enabled: true } } },
    { "features.default_mode_request_user_input": true },
    { features: { default_mode_request_user_input: true } },
  ])("preserves explicit native question opt-in %j with callable ask_user", (config) => {
    const params = createAttemptParams({ provider: "openai" });
    const options = {
      cwd: "/repo",
      dynamicTools: [
        {
          type: "function" as const,
          name: "ask_user",
          description: "Ask a question",
          inputSchema: { type: "object" },
        },
      ],
      askUserAvailable: true,
      appServer: createAppServerOptions(),
      developerInstructions: "test instructions",
      config,
    };
    const start = buildThreadStartParams(params, options);
    const resume = buildThreadResumeParams(params, { ...options, threadId: "thread-1" });
    for (const request of [start, resume]) {
      expect(request.config).toMatchObject(config);
      expect(request.config?.["tools.experimental_request_user_input.enabled"]).not.toBe(false);
    }
  });

  it.each([undefined, true, false])(
    "preserves native blocking question configuration %s when ask_user is absent",
    (enabled) => {
      const params = createAttemptParams({ provider: "openai" });
      const options = {
        cwd: "/repo",
        dynamicTools: [
          {
            type: "function" as const,
            name: "message",
            description: "Send a message.",
            inputSchema: { type: "object" },
          },
        ],
        appServer: createAppServerOptions(),
        developerInstructions: "test instructions",
        config:
          enabled === undefined
            ? undefined
            : { "tools.experimental_request_user_input.enabled": enabled },
      };

      const start = buildThreadStartParams(params, options);
      const resume = buildThreadResumeParams(params, { ...options, threadId: "thread-1" });
      for (const request of [start, resume]) {
        expect(request.config?.["tools.experimental_request_user_input.enabled"]).toBe(enabled);
      }
    },
  );
});
