import { describe, expect, it } from "vitest";
import {
  filterCodexDynamicToolsForAllowlist,
  hasWildcardCodexToolsAllow,
} from "./dynamic-tool-allowlist.js";

describe("Codex dynamic tool allowlist", () => {
  it.each([
    { toolsAllow: ["*"], expected: true },
    { toolsAllow: [" * "], expected: true },
    { toolsAllow: ["READ", " * "], expected: true },
    { toolsAllow: ["read", "message"], expected: false },
  ])("detects normalized wildcard values in $toolsAllow", ({ toolsAllow, expected }) => {
    expect(hasWildcardCodexToolsAllow(toolsAllow)).toBe(expected);
  });

  it("preserves only the exact host current-reply instance", () => {
    const collision = { name: "send_current_reply", owner: "plugin" };
    const hostCurrentReply = { name: "send_current_reply", owner: "host" };
    const read = { name: "read", owner: "core" };

    expect(
      filterCodexDynamicToolsForAllowlist(
        [collision, hostCurrentReply, read],
        ["read"],
        new Set([hostCurrentReply]),
      ),
    ).toEqual([hostCurrentReply, read]);
    expect(filterCodexDynamicToolsForAllowlist([collision, read], ["read"])).toEqual([read]);
  });
});
