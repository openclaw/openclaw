import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const proxyPath = path.resolve(bundledPluginFile("acpx", "src/runtime-internals/mcp-proxy.mjs"));

async function makeTempScript(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-mcp-proxy-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, content, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("mcp-proxy security", () => {
  it("blocks commands that do not start with the allowed prefix", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        targetCommand: "node -e 'console.log(1)'",
      }),
      "utf8",
    ).toString("base64url");

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCLAW_MCP_PROXY_ALLOWED_COMMAND_PREFIX: "/usr/bin/safe-bin",
      },
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("MCP proxy blocked command");
    expect(stderr).toContain("does not start with allowed prefix");
  });

  it("requires a valid signature when OPENCLAW_MCP_PROXY_SECRET is set", async () => {
    const secret = "test-secret";
    const payloadBody = {
      targetCommand: "node -e 'console.log(1)'",
    };
    
    // Invalid signature
    const payload = Buffer.from(
      JSON.stringify({
        ...payloadBody,
        signature: "invalid",
      }),
      "utf8",
    ).toString("base64url");

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCLAW_MCP_PROXY_SECRET: secret,
      },
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("signature verification failed");
  });

  it("allows execution when a valid signature is provided", async () => {
    const secret = "test-secret";
    const echoServerPath = await makeTempScript(
      "echo.cjs",
      "process.stdin.on('data', (d) => process.stdout.write(d))",
    );
    const targetCommand = `${process.execPath} ${echoServerPath}`;
    const payloadBody = {
      targetCommand,
      mcpServers: [],
    };
    
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(JSON.stringify(payloadBody));
    const signature = hmac.digest("hex");

    const payload = Buffer.from(
      JSON.stringify({
        ...payloadBody,
        signature,
      }),
      "utf8",
    ).toString("base64url");

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCLAW_MCP_PROXY_SECRET: secret,
      },
    });

    child.stdin.write('{"jsonrpc":"2.0","method":"session/new","params":{}}\n');
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
  });
});
