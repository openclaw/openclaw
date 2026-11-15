import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildNodeJoinCommands } from "./node-commands.js";

describe("browser node join commands", () => {
  it("keeps hostile shell characters in single arguments for both CLI forms", () => {
    const joinLink = "openclaw-node://join#i=synthetic.'$(printf injected);& space";
    const discoveryUrl = "https://discovery.example.test/'$(printf injected)";
    const version = "2026.11.5'; printf injected #";
    const commands = buildNodeJoinCommands({ joinLink, discoveryUrl, version })!;
    for (const [prefix, command] of [
      ["npx", commands.command],
      ["openclaw", commands.installedCommand],
    ]) {
      // The shell executes only printf, not a join: parse the generated argument string.
      const argv = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`], {
        encoding: "utf8",
      })
        .split("\0")
        .slice(0, -1);
      expect(argv).toEqual([
        ...(prefix === "npx" ? ["npx", "-y", `openclaw@${version}`] : ["openclaw"]),
        "node",
        "join",
        joinLink,
        "--discovery-url",
        discoveryUrl,
        "--service",
      ]);
    }
  });
  it("creates no command without Discovery", () => {
    expect(
      buildNodeJoinCommands({ joinLink: "private", discoveryUrl: null, version: "1" }),
    ).toBeNull();
  });
});
