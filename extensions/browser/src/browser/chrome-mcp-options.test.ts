import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeChromeMcpOptions } from "./chrome-mcp-options.js";

describe("Chrome MCP profile options", () => {
  it.each([undefined, "npx"])(
    "launches the packaged Chrome MCP with Node for HTTP endpoints with command %s",
    (mcpCommand) => {
      const { command, args } = normalizeChromeMcpOptions({
        cdpUrl: "http://127.0.0.1:9222",
        mcpCommand,
      });

      const identity = JSON.parse(
        execFileSync(
          command,
          [
            "--eval",
            'process.stdout.write(JSON.stringify({ executable: require("node:fs").realpathSync(process.execPath), runtime: process.versions.bun ? "bun" : "node" }))',
          ],
          {
            encoding: "utf8",
            env: {
              SystemRoot: process.env.SystemRoot,
              SYSTEMROOT: process.env.SYSTEMROOT,
              WINDIR: process.env.WINDIR,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
              TMPDIR: process.env.TMPDIR,
            },
          },
        ),
      );
      expect(identity).toEqual({ executable: realpathSync(command), runtime: "node" });
      expect(args[0]).toMatch(
        /[/\\]chrome-devtools-mcp[/\\]build[/\\]src[/\\]bin[/\\]chrome-devtools-mcp\.js$/,
      );
      expect(args[1]).toBe("--experimentalVision");
      expect(args).toContain("--browserUrl");
      expect(args).toContain("http://127.0.0.1:9222");
      expect(args).not.toContain("--wsEndpoint");
    },
  );

  it("passes direct WebSocket CDP endpoints to Chrome MCP as wsEndpoint attachments", () => {
    const { args } = normalizeChromeMcpOptions({
      cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
    });

    expect(args).toContain("--wsEndpoint");
    expect(args).toContain("ws://127.0.0.1:9222/devtools/browser/abc");
    expect(args).not.toContain("--browserUrl");
  });

  it("keeps endpoint-looking arguments after -- positional", () => {
    const cdpUrl = "https://configured.example";
    const positionalArgs = ["--browserUrl", "https://positional.example"];
    const { args, browserUrl } = normalizeChromeMcpOptions({
      cdpUrl,
      mcpArgs: ["--", ...positionalArgs],
    });

    expect(browserUrl).toBe(cdpUrl);
    expect(args.slice(0, args.indexOf("--"))).toContain(cdpUrl);
    expect(args.slice(args.indexOf("--") + 1)).toEqual(positionalArgs);
  });

  it.each([["--autoConnect=false"], ["--auto-connect", "false"], ["--no-auto-connect"]])(
    "does not substitute cdpUrl for the explicit local connection choice %s",
    (...mcpArgs) => {
      const cdpUrl = "https://configured.example";
      const { args, browserUrl } = normalizeChromeMcpOptions({ cdpUrl, mcpArgs });

      expect(browserUrl).toBeUndefined();
      expect(args).not.toContain(cdpUrl);
      expect(args.slice(-mcpArgs.length)).toEqual(mcpArgs);
    },
  );

  it("preserves unrelated custom command arguments verbatim", () => {
    const mcpArgs = [
      "--headless=false",
      "--user-data-dir",
      "/tmp/chrome profile",
      "--chrome-arg=--disable-features=One,Two",
    ];
    const options = normalizeChromeMcpOptions({ mcpCommand: "custom-chrome-mcp", mcpArgs });

    expect(options.command).toBe("custom-chrome-mcp");
    expect(options.args).toEqual([
      "--autoConnect",
      "--no-usage-statistics",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      ...mcpArgs,
    ]);
  });
});
