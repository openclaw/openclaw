/**
 * Subagent peer session messaging grant.
 *
 * Verifies the operator `tools.subagents.messaging: "peers"` grant re-enables
 * `sessions_send` for spawned children, keeps channel delivery denied, and clamps
 * the child to its own agent's session visibility.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectiveSessionToolsVisibility } from "../plugin-sdk/session-visibility.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

const CHILD_SESSION_KEY = "agent:main:subagent:peer-messaging";

function childToolNames(cfg: OpenClawConfig): Set<string> {
  return new Set(
    createOpenClawCodingTools({ config: cfg, sessionKey: CHILD_SESSION_KEY }).map(
      (tool) => tool.name,
    ),
  );
}

describe("subagent peer session messaging", () => {
  it("denies sessions_send for children while messaging is off or unset", () => {
    const configs: OpenClawConfig[] = [{}, { tools: { subagents: { messaging: "off" } } }];
    for (const cfg of configs) {
      expect(childToolNames(cfg).has("sessions_send")).toBe(false);
    }
  });

  it("re-enables only sessions_send for children under the peers grant", () => {
    const names = childToolNames({ tools: { subagents: { messaging: "peers" } } });
    expect(names.has("sessions_send")).toBe(true);
    // Channel delivery and peer-conversation tools stay hard-denied.
    expect(names.has("message")).toBe(false);
    expect(names.has("conversations_list")).toBe(false);
    expect(names.has("conversations_send")).toBe(false);
    expect(names.has("conversations_turn")).toBe(false);
    expect(names.has("gateway")).toBe(false);
  });

  it("narrows gateway-wide visibility to the child's own agent under the peers grant", () => {
    const cfg: OpenClawConfig = { tools: { sessions: { visibility: "all" } } };
    expect(
      resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: false,
        subagentPeerMessaging: true,
      }),
    ).toBe("agent");
  });

  it("preserves an explicitly narrower operator visibility under the peers grant", () => {
    const cfg: OpenClawConfig = { tools: { sessions: { visibility: "tree" } } };
    expect(
      resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: false,
        subagentPeerMessaging: true,
      }),
    ).toBe("tree");
  });
});
