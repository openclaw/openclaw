// Integration proof for PR #92035: QMD temporal decay through the real
// patched QmdMemoryManager.search() path (manager construction, qmd CLI
// execution, result mapping, decay re-ranking, source diversification).
//
// Usage:
//   PROOF_TMP=$(mktemp -d) && OPENCLAW_STATE_DIR="$PROOF_TMP/state" \
//     node_modules/.bin/tsx scripts/qmd-decay-proof.mts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QmdMemoryManager } from "../extensions/memory-core/src/memory/qmd-manager.js";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const today = new Date();
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(today.getTime() - n * 24 * 60 * 60 * 1000);

async function main() {
  if (!process.env.OPENCLAW_STATE_DIR) {
    throw new Error("Set OPENCLAW_STATE_DIR to an isolated scratch dir before running.");
  }
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-decay-proof-"));
  const workspaceDir = path.join(tmpRoot, "workspace");
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });

  // Stale, keyword-dense file (60 days old).
  const staleName = `${fmt(daysAgo(60))}.md`;
  await fs.writeFile(
    path.join(memoryDir, staleName),
    [
      `# ${fmt(daysAgo(60))}`,
      "",
      "Tachyon relay calibration notes. The tachyon relay calibration needs",
      "tachyon relay calibration each cycle. Tachyon relay calibration log.",
    ].join("\n"),
  );

  // Fresh file mentioning the term once (today).
  const freshName = `${fmt(today)}.md`;
  await fs.writeFile(
    path.join(memoryDir, freshName),
    [
      `# ${fmt(today)}`,
      "",
      "Daily log. Reviewed the tachyon relay calibration once this morning;",
      "everything nominal. Rest of the day was unrelated work.",
    ].join("\n"),
  );

  // Evergreen file (must not decay).
  await fs.writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    "# MEMORY\n\nDurable note: tachyon relay calibration owner is the infra team.\n",
  );

  async function runSearch(label: string, temporalDecayEnabled: boolean) {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            workspace: workspaceDir,
            memorySearch: {
              enabled: true,
              query: {
                hybrid: {
                  temporalDecay: { enabled: temporalDecayEnabled, halfLifeDays: 3 },
                },
              },
            },
          },
        ],
      },
      memory: { backend: "qmd" },
    } as never;

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const manager = await QmdMemoryManager.create({
      cfg,
      agentId: "main",
      resolved,
      mode: "full",
    });
    if (!manager) {
      throw new Error("manager creation returned null");
    }
    await manager.sync({ reason: "proof", force: true }).catch((e: unknown) => {
      console.log(`  [sync] ${String(e)}`);
    });
    const status = manager.status();
    console.log(`  [status] files=${status.files} chunks=${status.chunks} dirty=${status.dirty}`);
    console.log(`  [status] dbPath=${(status as { dbPath?: string }).dbPath}`);
    console.log(`  [status] workspaceDir=${(status as { workspaceDir?: string }).workspaceDir}`);

    const results = await manager.search("tachyon relay calibration", {
      maxResults: 5,
      sessionKey: "agent:main:cli:direct:proof",
      onDebug: (info) => console.log(`  [debug] backend=${info.backend} mode=${info.effectiveMode}`),
    });
    console.log(`\n=== ${label} ===`);
    for (const r of results) {
      console.log(`  score=${r.score.toFixed(4)}  path=${r.path}  source=${r.source}`);
    }
    await manager.close();
    return results;
  }

  const off = await runSearch("temporalDecay DISABLED (baseline)", false);
  const on = await runSearch("temporalDecay ENABLED (halfLifeDays=3)", true);

  const score = (results: typeof off, name: string) =>
    results.find((r) => r.path.endsWith(name))?.score;
  console.log(`\n--- Verification ---`);
  console.log(
    `evergreen MEMORY.md unchanged: off=${score(off, "memory.md")} on=${score(on, "memory.md")}`,
  );
  console.log(
    `fresh ${freshName}: off=${score(off, freshName)} on=${score(on, freshName)?.toFixed(4)}`,
  );
  console.log(
    `stale ${staleName}: off=${score(off, staleName)} on=${score(on, staleName)?.toFixed(4)}`,
  );
  const freshOn = score(on, freshName) ?? 0;
  const staleOn = score(on, staleName) ?? 0;
  const evergreenStable = score(off, "memory.md") === score(on, "memory.md");
  console.log(
    `\nIntegrated decay applied (fresh > stale post-decay): ${freshOn > staleOn ? "YES" : "NO"}`,
  );
  console.log(`Evergreen exemption held: ${evergreenStable ? "YES" : "NO"}`);

  await fs.rm(tmpRoot, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
