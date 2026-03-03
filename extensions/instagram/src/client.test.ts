import { describe, expect, it } from "vitest";
import { __testing } from "./client.js";

describe("instagram cli argv", () => {
  it("uses node for script paths", () => {
    const argv = __testing.buildInstagramCliArgv(
      {
        accountId: "default",
        enabled: true,
        configured: true,
        cliPath: "/tmp/instagram-cli/dist/cli.js",
        cliArgs: ["--foo"],
        config: {},
      },
      ["llm", "threads"],
    );
    expect(argv[0]).toBe(process.execPath);
    expect(argv.slice(1)).toEqual(["/tmp/instagram-cli/dist/cli.js", "--foo", "llm", "threads"]);
  });

  it("uses binary paths directly", () => {
    const argv = __testing.buildInstagramCliArgv(
      {
        accountId: "default",
        enabled: true,
        configured: true,
        cliPath: "instagram-cli",
        cliArgs: [],
        config: {},
      },
      ["llm", "threads"],
    );
    expect(argv).toEqual(["instagram-cli", "llm", "threads"]);
  });
});
