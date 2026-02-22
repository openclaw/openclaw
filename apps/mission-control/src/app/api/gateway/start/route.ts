import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { NextRequest, NextResponse } from "next/server";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve the gateway directory for the built-in OpenClaw runtime.
 * Preference order:
 * 1) OPENCLAW_GATEWAY_DIR
 * 2) OPENCLAW_PLATFORM_DIR (legacy env var; still honored if provided)
 * 3) Common sibling locations relative to mission-control root
 *
 * Note: We intentionally do NOT auto-select old external dashboard trees.
 */
function resolveGatewayDir(): string | null {
    const fromEnv = process.env.OPENCLAW_GATEWAY_DIR || process.env.OPENCLAW_PLATFORM_DIR;
    if (fromEnv) {
        const direct = fromEnv;
        const nestedCore = path.join(fromEnv, "packages", "core");
        for (const candidate of [direct, nestedCore]) {
            if (
                fs.existsSync(path.join(candidate, "openclaw.mjs")) &&
                fs.existsSync(path.join(candidate, "scripts", "run-node.mjs"))
            ) {
                return candidate;
            }
        }
    }

    // Walk up from mission-control to find sibling OpenClaw gateway roots.
    const mcRoot = process.cwd();
    const parentDir = path.dirname(mcRoot);
    const candidates = [
        path.join(parentDir, "openclaw-fresh", "openclaw-main"),
        path.join(parentDir, "openclaw-main"),
        path.join(parentDir, "openclaw"),
        path.join(parentDir, "packages", "core"),
    ];

    for (const dir of candidates) {
        if (
            fs.existsSync(path.join(dir, "openclaw.mjs")) &&
            fs.existsSync(path.join(dir, "scripts", "run-node.mjs"))
        ) {
            return dir;
        }
    }

    return null;
}

/** Parse gateway URL to get host and port */
function resolveGatewayTarget(): { host: string; port: number } {
    const fallback = { host: "127.0.0.1", port: 18789 };
    const raw = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
    try {
        const parsed = new URL(raw);
        return {
            host: parsed.hostname || fallback.host,
            port: Number(parsed.port || fallback.port),
        };
    } catch {
        return fallback;
    }
}

/** Check if the gateway is already listening */
async function isPortOpen(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
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

/** Wait for the gateway to become reachable */
async function waitForGateway(host: string, port: number, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isPortOpen(host, port)) {return true;}
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

export const POST = withApiGuard(async (request: NextRequest) => {
    void request;

    try {
        const { host, port } = resolveGatewayTarget();

        // Already running?
        if (await isPortOpen(host, port)) {
            return NextResponse.json({
                ok: true,
                message: "Gateway is already running",
                alreadyRunning: true,
                host,
                port,
            });
        }

        // Find gateway directory
        const gatewayDir = resolveGatewayDir();
        if (!gatewayDir) {
            return NextResponse.json(
                {
                    ok: false,
                    message:
                        "Could not find OpenClaw gateway root. Set OPENCLAW_GATEWAY_DIR in .env.local",
                },
                { status: 404 }
            );
        }

        // Resolve token from mission control env
        const token = process.env.OPENCLAW_AUTH_TOKEN || "";

        // Spawn the gateway as a detached process
        const nodePath = process.execPath;
        const child = spawn(
            nodePath,
            [
                "scripts/run-node.mjs",
                "--dev",
                "gateway",
                "--port",
                String(port),
                ...(token ? ["--token", token] : []),
            ],
            {
                cwd: gatewayDir,
                detached: true,
                stdio: "ignore",
                env: {
                    ...process.env,
                    OPENCLAW_SKIP_CHANNELS: "1",
                    CLAWDBOT_SKIP_CHANNELS: "1",
                    OPENCLAW_TS_COMPILER: "tsc",
                },
            }
        );

        child.unref();

        const pid = child.pid;

        // Wait for the gateway to be reachable
        const ready = await waitForGateway(host, port);

        return NextResponse.json({
            ok: true,
            message: ready ? "Gateway started successfully" : "Gateway spawned but not yet reachable",
            ready,
            pid,
            host,
            port,
            gatewayDir,
        });
    } catch (error) {
        return handleApiError(error, "Failed to start gateway");
    }
}, ApiGuardPresets.expensive);
