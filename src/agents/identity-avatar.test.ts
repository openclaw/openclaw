import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentAvatar } from "./identity-avatar.js";

describe("resolveAgentAvatar", () => {
  it("returns none when agent has no identity and no IDENTITY.md", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "test", workspace: "/tmp/nonexistent" }],
      },
    };
    const result = resolveAgentAvatar(cfg, "test");
    expect(result.kind).toBe("none");
    expect(result.reason).toBe("missing");
  });

  it("returns remote for http URLs", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "test", identity: { avatar: "https://example.com/avatar.png" } }],
      },
    };
    const result = resolveAgentAvatar(cfg, "test");
    expect(result.kind).toBe("remote");
    expect(result.url).toBe("https://example.com/avatar.png");
  });

  it("returns data for data URIs", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "test", identity: { avatar: "data:image/png;base64,ABC" } }],
      },
    };
    const result = resolveAgentAvatar(cfg, "test");
    expect(result.kind).toBe("data");
    expect(result.url).toBe("data:image/png;base64,ABC");
  });
});
