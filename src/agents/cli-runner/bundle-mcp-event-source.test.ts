import { describe, expect, it } from "vitest";
import { shouldCreateBundleMcpRuntimeForAttempt } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../tool-policy-shared.js";
import {
  BUNDLE_MCP_ALLOWLIST_NAME,
  withBundleMcpEventSourceReach,
} from "./bundle-mcp-event-source.js";

const bannerGateParams = {
  toolsEnabled: true,
  resolveConfiguredMcpNamespaces: () => ["docs__"],
} as const;

describe("bundle MCP event source reach", () => {
  it("carries the bundled MCP family name into an exec completion source policy", () => {
    // The default source policy a prepared turn records lists only coding tool
    // names; without the carrier the recovered wake policy fails the bundled
    // MCP runtime gate, so exec completion wakes (and every turn spawned from
    // them) run without bundle MCP tools.
    const recorded = ["apply_patch", "exec", "message", "read"];
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        ...bannerGateParams,
        toolsAllow: recorded,
      }),
    ).toBe(false);

    const carried = withBundleMcpEventSourceReach(
      { settings: undefined, toolsAllow: [...recorded] },
      true,
    );
    expect(carried.toolsAllow).toEqual(
      expect.arrayContaining([...recorded, BUNDLE_MCP_ALLOWLIST_NAME]),
    );
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        ...bannerGateParams,
        toolsAllow: carried.toolsAllow as string[],
      }),
    ).toBe(true);
  });

  it("keeps a policy that already carries the family name identical", () => {
    const carried = withBundleMcpEventSourceReach(
      { settings: undefined, toolsAllow: ["message", BUNDLE_MCP_ALLOWLIST_NAME] },
      true,
    );
    expect(carried.toolsAllow).toEqual(["message", BUNDLE_MCP_ALLOWLIST_NAME]);
  });

  it("leaves unrestricted and inactive-bundle policies as recorded", () => {
    const unrestricted = withBundleMcpEventSourceReach(
      { settings: undefined, toolsAllow: undefined },
      true,
    );
    expect(unrestricted.toolsAllow).toBeUndefined();

    const inactive = { settings: undefined, toolsAllow: ["message", "read"] };
    const untouched = withBundleMcpEventSourceReach(inactive, false);
    expect(untouched).toBe(inactive);
    expect(untouched.toolsAllow).toEqual(["message", "read"]);
  });

  it("treats plugin groups, separator tool names, and wildcard caps as carried", () => {
    for (const toolsAllow of [["group:plugins"], ["docs__summarize"], ["*"]]) {
      const carried = withBundleMcpEventSourceReach(
        { settings: undefined, toolsAllow: [...toolsAllow] },
        true,
      );
      expect(carried.toolsAllow).toEqual(toolsAllow);
    }
  });

  it("widens every recorded intersection group without dropping caps", () => {
    const narrow = ["exec"];
    const message = ["message"];
    const composed = attachToolAllowlistIntersection(
      [...narrow],
      [narrow.slice(), message.slice()],
    );
    expect(readToolAllowlistIntersection(composed)).toEqual([narrow, message]);

    const carried = withBundleMcpEventSourceReach(
      { settings: undefined, toolsAllow: composed },
      true,
    ).toolsAllow as string[];
    const groups = readToolAllowlistIntersection(carried) ?? [];
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).toEqual(expect.arrayContaining([BUNDLE_MCP_ALLOWLIST_NAME]));
    }
    expect(groups[0]).toEqual(expect.arrayContaining(["exec"]));
    expect(groups[1]).toEqual(expect.arrayContaining(["message"]));
    expect(carried).toEqual(expect.arrayContaining([BUNDLE_MCP_ALLOWLIST_NAME]));
  });
});
