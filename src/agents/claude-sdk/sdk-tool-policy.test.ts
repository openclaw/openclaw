import { describe, expect, it } from "vitest";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import {
  CLAUDE_SDK_PROVIDER_ID,
  collectSdkDisallowedTools,
} from "./sdk-tool-policy.js";

// Narrow helper — we only need the config + agentId fields for the
// policy helper, so cast at the call site rather than materializing a
// full RunEmbeddedPiAgentParams every time.
type TestParams = Pick<RunEmbeddedPiAgentParams, "config" | "agentId">;

function asParams(p: TestParams): RunEmbeddedPiAgentParams {
  return p as unknown as RunEmbeddedPiAgentParams;
}

describe("collectSdkDisallowedTools", () => {
  it("returns [] when no config is provided", () => {
    expect(collectSdkDisallowedTools(asParams({}))).toEqual([]);
  });

  it("pulls global config.tools.deny", () => {
    const result = collectSdkDisallowedTools(
      asParams({ config: { tools: { deny: ["Bash", "Edit"] } } as never }),
    );
    expect(result).toEqual(["Bash", "Edit"]);
  });

  it("merges global deny + byProvider[anthropic].deny (de-dup, first wins)", () => {
    const result = collectSdkDisallowedTools(
      asParams({
        config: {
          tools: {
            deny: ["Bash"],
            byProvider: {
              [CLAUDE_SDK_PROVIDER_ID]: { deny: ["Bash", "Edit"] },
              openai: { deny: ["Grep"] },
            },
          },
        } as never,
      }),
    );
    expect(result).toEqual(["Bash", "Edit"]);
  });

  it("skips byProvider entries that are not anthropic", () => {
    const result = collectSdkDisallowedTools(
      asParams({
        config: {
          tools: { byProvider: { openai: { deny: ["Grep"] } } },
        } as never,
      }),
    );
    expect(result).toEqual([]);
  });

  it("adds agent-level tools.deny when the agent id matches", () => {
    const result = collectSdkDisallowedTools(
      asParams({
        agentId: "main",
        config: {
          tools: { deny: ["Bash"] },
          agents: {
            list: [{ id: "main", tools: { deny: ["Glob"] } }],
          },
        } as never,
      }),
    );
    expect(result).toEqual(["Bash", "Glob"]);
  });

  it("adds agent byProvider[anthropic].deny on top of agent-level deny", () => {
    const result = collectSdkDisallowedTools(
      asParams({
        agentId: "main",
        config: {
          agents: {
            list: [
              {
                id: "main",
                tools: {
                  deny: ["A"],
                  byProvider: {
                    [CLAUDE_SDK_PROVIDER_ID]: { deny: ["B", "A"] },
                  },
                },
              },
            ],
          },
        } as never,
      }),
    );
    expect(result).toEqual(["A", "B"]);
  });

  it("ignores the agent entry when agentId does not match", () => {
    const result = collectSdkDisallowedTools(
      asParams({
        agentId: "research",
        config: {
          agents: {
            list: [{ id: "main", tools: { deny: ["Glob"] } }],
          },
        } as never,
      }),
    );
    expect(result).toEqual([]);
  });

  it("normalizes agent id casing when matching the list entry", () => {
    // normalizeAgentId lowercases + sanitizes, so "Main" and "main"
    // must both resolve to the same list entry.
    const result = collectSdkDisallowedTools(
      asParams({
        agentId: "Main",
        config: {
          agents: {
            list: [{ id: "main", tools: { deny: ["Bash"] } }],
          },
        } as never,
      }),
    );
    expect(result).toEqual(["Bash"]);
  });

  it("drops non-string, blank, and duplicate deny entries", () => {
    const result = collectSdkDisallowedTools(
      asParams({
        config: {
          tools: {
            deny: ["Bash", "Bash", "", "  ", 0 as unknown as string, "Edit"],
          },
        } as never,
      }),
    );
    expect(result).toEqual(["Bash", "Edit"]);
  });
});
