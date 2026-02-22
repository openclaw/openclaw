import fs from "fs";
import os from "os";
import path from "path";
import net from "net";
import { execFile } from "child_process";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isLaunchdServiceLoaded(target: string): Promise<boolean> {
  try {
    await execFileAsync("launchctl", ["print", target]);
    return true;
  } catch {
    return false;
  }
}

function resolveGatewaySocketTarget(): { host: string; port: number } {
  const fallback = { host: "127.0.0.1", port: 18789 };
  const raw = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname || fallback.host;
    const port = Number(parsed.port || fallback.port);
    if (!host || !Number.isFinite(port) || port <= 0) {return fallback;}
    return { host, port };
  } catch {
    return fallback;
  }
}

async function canOpenSocket(
  host: string,
  port: number,
  timeoutMs = 1200
): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) {return;}
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function waitForGatewayReady(timeoutMs = 20_000): Promise<boolean> {
  const { host, port } = resolveGatewaySocketTarget();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await canOpenSocket(host, port)) {return true;}
    await sleep(350);
  }

  return false;
}

async function restartGatewayLaunchd(): Promise<{
  label: string;
  domain: string;
  strategy: "kickstart" | "bootstrap";
}> {
  const uid = process.getuid?.();
  if (!uid) {
    throw new Error("Unsupported runtime: could not resolve user id for launchctl");
  }

  const label = process.env.OPENCLAW_LAUNCHD_LABEL || "ai.openclaw.gateway";
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${label}.plist`
  );

  if (!fs.existsSync(plistPath)) {
    throw new Error(`LaunchAgent plist not found: ${plistPath}`);
  }

  const loaded = await isLaunchdServiceLoaded(target);

  if (loaded) {
    try {
      await execFileAsync("launchctl", ["kickstart", "-k", target]);
      return { label, domain, strategy: "kickstart" };
    } catch {
      // Fall through to bootstrap path.
      try {
        await execFileAsync("launchctl", ["bootout", target]);
      } catch {
        // Ignore bootout failures and attempt bootstrap anyway.
      }
      await sleep(500);
    }
  }

  await execFileAsync("launchctl", ["bootstrap", domain, plistPath]);
  await sleep(500);
  await execFileAsync("launchctl", ["kickstart", "-k", target]);

  return { label, domain, strategy: "bootstrap" };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApiGuard(async (request: NextRequest) => {
  void request;
  try {
    const result = await restartGatewayLaunchd();
    const ready = await waitForGatewayReady();
    return NextResponse.json({
      ok: true,
      message: "Gateway restart triggered",
      ready,
      ...result,
    });
  } catch (error) {
    return handleApiError(error, "Failed to restart gateway");
  }
}, ApiGuardPresets.expensive);
