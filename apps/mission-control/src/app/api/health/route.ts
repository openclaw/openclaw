import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/health — Health check endpoint for orchestrators and monitoring.
 *
 * Returns status of the DB, gateway connectivity, and basic runtime info.
 * Does NOT require authentication (always public).
 */
export async function GET(request: NextRequest) {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

    // --- Database check ---
    try {
        const start = performance.now();
        // Dynamic import to avoid pulling db into the client bundle
        const { getDb } = await import("@/lib/db");
        const db = getDb();
        const row = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
        checks.database = {
            ok: row?.ok === 1,
            latencyMs: Math.round(performance.now() - start),
        };
    } catch (err) {
        checks.database = {
            ok: false,
            error: err instanceof Error ? err.message : "Unknown database error",
        };
    }

    // --- Gateway connectivity check (via WebSocket RPC client) ---
    try {
        const start = performance.now();
        const { getOpenClawClient } = await import("@/lib/openclaw-client");
        const client = getOpenClawClient();
        const metrics = client.getConnectionMetrics();
        checks.gateway = {
            ok: metrics.connected,
            latencyMs: Math.round(performance.now() - start),
        };
    } catch (err) {
        checks.gateway = {
            ok: false,
            error: err instanceof Error ? err.message : "Gateway unreachable",
        };
    }

    // --- Scheduler check (lazily starts the schedule engine) ---
    try {
        const { getScheduleEngine } = await import("@/lib/schedule-engine");
        const engine = getScheduleEngine();
        if (!engine.isRunning()) {
            engine.start();
        }
        checks.scheduler = { ok: true };
    } catch (err) {
        checks.scheduler = {
            ok: false,
            error: err instanceof Error ? err.message : "Scheduler failed to start",
        };
    }

    // --- Telegram Master Daemon check ---
    try {
        const { getTelegramMasterMonitor } = await import("@/lib/telegram-master");
        const monitor = getTelegramMasterMonitor();
        monitor.start();
        checks.telegram_master = { ok: true };
    } catch (err) {
        checks.telegram_master = {
            ok: false,
            error: err instanceof Error ? err.message : "Telegram daemon failed to start",
        };
    }

    // --- Overall ---
    const allOk = Object.values(checks).every((c) => c.ok);

    const softMode = request.nextUrl.searchParams.get("soft") === "true";

    return NextResponse.json(
        {
            status: allOk ? "healthy" : "degraded",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            version: process.env.npm_package_version || "unknown",
            checks,
        },
        {
            status: softMode ? 200 : allOk ? 200 : 503,
            headers: { "Cache-Control": "no-store" },
        }
    );
}
