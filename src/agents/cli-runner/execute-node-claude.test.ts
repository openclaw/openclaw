import { describe, expect, it } from "vitest";
import { stripGatewayLocalClaudeArgs } from "./execute-node-claude.js";

describe("stripGatewayLocalClaudeArgs", () => {
  const args = ["-p", "--setting-sources", "user", "--settings", '{"autoMemoryEnabled":false}'];

  it("keeps Gateway-local settings off ordinary node runs", () => {
    expect(stripGatewayLocalClaudeArgs(args, { exactToolAvailability: false })).toEqual([
      "-p",
      "--setting-sources",
      "user",
    ]);
  });

  it("forwards exact-tool settings so the node fails closed instead of running unisolated", () => {
    expect(stripGatewayLocalClaudeArgs(args, { exactToolAvailability: true })).toEqual(args);
  });
});
