import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const execFileAsync = promisify(execFile);
const LIVE = isLiveTestEnabled(["OPENCLAW_LIVE_CLI_MCP_GEMINI"]);
const describeLive = LIVE ? describe : describe.skip;

async function canRunGemini(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describeLive("Gemini CLI MCP settings smoke", () => {
  it("connects to an OpenClaw-configured streamable-http server", async () => {
    const geminiCommand = process.env.OPENCLAW_LIVE_GEMINI_COMMAND ?? "gemini";
    if (!(await canRunGemini(geminiCommand))) {
      console.warn(`Skipping Gemini MCP live smoke: ${geminiCommand} is not runnable.`);
      return;
    }

    const inheritedEnv =
      typeof process.env.CONTEXT7_API_KEY === "string" && process.env.CONTEXT7_API_KEY
        ? { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY }
        : undefined;
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: geminiCommand,
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: process.cwd(),
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            context7: {
              transport: "streamable-http",
              url: "https://mcp.context7.com/mcp",
              ...(inheritedEnv ? { headers: { Authorization: "Bearer ${CONTEXT7_API_KEY}" } } : {}),
            },
          },
        },
      },
      env: inheritedEnv,
    });

    try {
      const result = await execFileAsync(geminiCommand, ["--debug", "mcp", "list"], {
        env: {
          ...process.env,
          ...prepared.env,
        },
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain("context7");
      expect(output).toMatch(/\(http\)|type:\s*http|http/i);
      expect(output).not.toContain("transport");
    } finally {
      await prepared.cleanup?.();
    }
  }, 60_000);
});
