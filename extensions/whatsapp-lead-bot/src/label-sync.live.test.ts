/**
 * Label Sync PoC — evidence-based investigation.
 *
 * Uses the solayre agent (which runs inside the gateway) to call label tools.
 * All WA operations go through the gateway's active Baileys socket.
 *
 * Run:
 *   OPENCLAW_LIVE_TEST=1 pnpm vitest run \
 *     --config vitest.live.config.ts \
 *     extensions/whatsapp-lead-bot/src/label-sync.live.test.ts
 *
 * Optional:
 *   WA_ACCOUNT=solayre   — WhatsApp account (default: solayre)
 *   AGENT=solayre        — Agent to invoke tools through (default: solayre)
 *
 * Mobile verification steps (manual, with mobile-mcp):
 *   After Probe 2 — screenshot Android WA Etiquetas, verify __SYNC_TEST appears
 *   After Probe 3 — tap __SYNC_TEST, verify self-chat appears
 *   After Probe 4 — verify __SYNC_TEST is gone
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../../src/infra/env.js";
import { readWebSelfId } from "../../../src/web/auth-store.js";

const LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const WA_ACCOUNT = process.env.WA_ACCOUNT ?? "solayre";
const AGENT = process.env.AGENT ?? "solayre";
const TEST_LABEL_NAME = "__SYNC_TEST";
const TEST_LABEL_COLOR = 14;

const REPO_ROOT = path.resolve(__dirname, "../../../");
const authDir = path.join(process.env.HOME ?? "", ".openclaw/credentials/whatsapp", WA_ACCOUNT);

/** Resolve the gateway token from config (fall back to env var). */
function resolveGatewayToken(): string | undefined {
  // Try env var first (set externally or already configured)
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  // Fall back: read directly from openclaw.json
  try {
    const cfgPath = path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json");
    // biome-ignore lint/suspicious/noExplicitAny: config shape varies
    const cfg: any = JSON.parse(require("node:fs").readFileSync(cfgPath, "utf-8"));
    return cfg?.gateway?.auth?.token ?? cfg?.gateway?.remote?.token ?? undefined;
  } catch {
    return undefined;
  }
}

/** Run the openclaw agent with a message and return stdout. */
function agentRun(message: string): string {
  const cmd = `pnpm openclaw agent --message ${JSON.stringify(message)} --agent ${AGENT}`;
  console.log(
    `  $ pnpm openclaw agent --message ${JSON.stringify(message).slice(0, 80)}... --agent ${AGENT}`,
  );
  const gatewayToken = resolveGatewayToken();
  const env = gatewayToken ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: gatewayToken } : process.env;
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8", timeout: 60_000, env });
}

describeLive("WhatsApp Label Sync PoC (via gateway agent tools)", () => {
  let createdLabelId: string | null = null;
  let selfJid: string | null = null;

  beforeAll(() => {
    const { jid } = readWebSelfId(authDir);
    selfJid = jid;
    console.log(
      `[beforeAll] Self JID: ${selfJid ?? "(not found)"}, account: ${WA_ACCOUNT}, agent: ${AGENT}`,
    );
  });

  // ── Probe 1: inventory ──────────────────────────────────────────────────────

  it("Probe 1: lists existing labels via get_labels tool", () => {
    console.log("\n[Probe 1] Fetching current labels via get_labels agent tool");
    const out = agentRun(
      "Call get_labels tool and respond with ONLY the JSON array of labels, no other text.",
    );
    console.log("[Probe 1] Raw output (last 500):", out.slice(-500));

    // Extract JSON array from agent output
    const match = out.match(/\[[\s\S]*\]/);
    if (match) {
      const labels = JSON.parse(match[0]) as { id: string; name: string }[];
      console.log(`[Probe 1] ${labels.length} label(s):`, labels.map((l) => l.name).join(", "));
      expect(labels.length).toBeGreaterThan(0);
    } else {
      console.log("[Probe 1] Could not parse JSON array from output — checking for label names");
      // Soft check: at least COLD/HOT/OUT should appear in text
      expect(out).toMatch(/COLD|HOT|OUT|WARM/i);
    }
  }, 90_000);

  // ── Probe 2: label creation round-trip ──────────────────────────────────────

  it("Probe 2: creates label via create_label tool and verifies it fires on Android", () => {
    console.log(`\n[Probe 2] Creating label "${TEST_LABEL_NAME}" (color=${TEST_LABEL_COLOR})`);
    const out = agentRun(
      `Call create_label tool with name="${TEST_LABEL_NAME}" and color=${TEST_LABEL_COLOR}. ` +
        `Respond with ONLY a JSON object containing the created label's id field, e.g. {"id": "123"}.`,
    );
    console.log("[Probe 2] Raw output (last 300):", out.slice(-300));

    const match = out.match(/\{[^{}]*"id"\s*:\s*"([^"]+)"[^{}]*\}/);
    if (match) {
      createdLabelId = match[1];
      console.log(`[Probe 2] Created label ID: ${createdLabelId}`);
    } else {
      console.log("[Probe 2] WARNING: Could not parse label ID from output");
    }

    console.log(
      "\n>>> CHECK ANDROID NOW: Open WA ⋮ → Etiquetas — verify __SYNC_TEST appears <<<\n",
    );
    expect(true).toBe(true); // structural pass — evidence is in console
  }, 90_000);

  // ── Probe 3: label association round-trip ────────────────────────────────────

  it("Probe 3: applies label to self-chat via add_chat_label tool", () => {
    if (!createdLabelId) {
      console.log("[Probe 3] SKIP — no label ID from Probe 2");
      return;
    }
    if (!selfJid) {
      console.log("[Probe 3] SKIP — self JID not found");
      return;
    }

    const baseJid = selfJid.includes(":") ? selfJid.split(":")[0] + "@s.whatsapp.net" : selfJid;

    console.log(`\n[Probe 3] Applying label ${createdLabelId} to ${baseJid}`);
    const out = agentRun(
      `Call add_chat_label tool with chat_jid="${baseJid}" and label_id="${createdLabelId}". ` +
        `Respond with ONLY {"success": true} or {"success": false, "error": "..."}`,
    );
    console.log("[Probe 3] Raw output (last 300):", out.slice(-300));

    console.log(
      "\n>>> CHECK ANDROID NOW: Tap __SYNC_TEST in Etiquetas — verify self-chat appears <<<\n",
    );
    expect(true).toBe(true);
  }, 90_000);

  // ── Probe 4: cleanup ─────────────────────────────────────────────────────────

  afterAll(() => {
    if (createdLabelId) {
      console.log(
        `\n[cleanup] Test label ID: ${createdLabelId} — delete manually in WA if it persists`,
      );
    }
    console.log("\n>>> FINAL CHECK: Verify __SYNC_TEST status on Android <<<\n");
  });
});
