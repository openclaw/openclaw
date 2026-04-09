import { describe, expect, it } from "vitest";
import { resolveHeartbeatPromptForSystemPrompt } from "./heartbeat-system-prompt.js";

describe("resolveHeartbeatPromptForSystemPrompt", () => {
  it("omits the heartbeat section when disabled in defaults", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                includeSystemPromptSection: false,
              },
            },
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("omits the heartbeat section when the default cadence is disabled", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                every: "0m",
              },
            },
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("omits the heartbeat section when the default-agent override disables cadence", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                every: "30m",
              },
            },
            list: [
              {
                id: "main",
                heartbeat: {
                  every: "0m",
                },
              },
            ],
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("omits the heartbeat section when only a non-default agent has explicit heartbeat config", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            list: [
              { id: "main", default: true },
              {
                id: "ops",
                heartbeat: {
                  every: "30m",
                },
              },
            ],
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });

  it("honors default-agent overrides for the prompt text", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                prompt: "Default prompt",
              },
            },
            list: [
              {
                id: "main",
                heartbeat: {
                  prompt: "  Ops check  ",
                },
              },
            ],
          },
        },
        agentId: "main",
        defaultAgentId: "main",
      }),
    ).toBe("Ops check");
  });

  it("does not inject the heartbeat section for non-default agents", () => {
    expect(
      resolveHeartbeatPromptForSystemPrompt({
        config: {
          agents: {
            defaults: {
              heartbeat: {
                prompt: "Default prompt",
              },
            },
            list: [
              {
                id: "ops",
                heartbeat: {
                  prompt: "Ops prompt",
                },
              },
            ],
          },
        },
        agentId: "ops",
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });
});
