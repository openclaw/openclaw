import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCapitalHftStateDir } from "./lib/brokerdesk-state-dir.mjs";

async function writeProbeState(stateDir, timestampMs) {
  await fs.mkdir(stateDir, { recursive: true });
  const probeFiles = [
    "capital_latest_quote_event.json",
    "background_quotes_status.json",
    "quote_status.json",
  ];
  for (const fileName of probeFiles) {
    const filePath = path.join(stateDir, fileName);
    await fs.writeFile(filePath, `{"probe":"${path.basename(stateDir)}"}\n`, "utf8");
    await fs.utimes(filePath, new Date(timestampMs), new Date(timestampMs));
  }
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-hft-state-dir-"));
const olderStaging = path.join(tempRoot, "dist-staging-0001", "CapitalHftService", "state");
const newerStaging = path.join(tempRoot, "dist-staging-0002", "CapitalHftService", "state");
const hftRoot = path.join(tempRoot, "CapitalHftService");
await writeProbeState(olderStaging, Date.now() - 60_000);
await writeProbeState(newerStaging, Date.now());
await fs.mkdir(hftRoot, { recursive: true });
await fs.writeFile(path.join(hftRoot, "hft_service_status.json"), `{"status":"running"}\n`, "utf8");
await fs.utimes(
  path.join(hftRoot, "hft_service_status.json"),
  new Date(Date.now() + 60_000),
  new Date(Date.now() + 60_000),
);

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", { value: "win32" });

const originalOpenClawStateDir = process.env.OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR;
const originalCapitalHftServiceStateDir = process.env.CAPITAL_HFT_STATE_DIR;

try {
  delete process.env.OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR;
  delete process.env.CAPITAL_HFT_STATE_DIR;

  const resolved = resolveCapitalHftStateDir({
    capitalHftRoot: tempRoot,
    capitalHftServiceRoot: "",
  });
  if (resolved !== newerStaging) {
    throw new Error(`expected newest staging dir, got ${resolved}`);
  }

  const hftResolved = resolveCapitalHftStateDir({
    capitalHftRoot: tempRoot,
    capitalHftServiceRoot: hftRoot,
  });
  if (hftResolved !== hftRoot) {
    throw new Error(`expected CapitalHftService root, got ${hftResolved}`);
  }

  process.env.OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR = "C:\\override-openclaw";
  const openClawOverride = resolveCapitalHftStateDir({
    capitalHftRoot: tempRoot,
    capitalHftServiceRoot: "",
  });
  if (openClawOverride !== "C:\\override-openclaw") {
    throw new Error(
      `expected OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR override, got ${openClawOverride}`,
    );
  }

  delete process.env.OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR;
  process.env.CAPITAL_HFT_STATE_DIR = "C:\\override-capital-hft";
  const capitalHftOverride = resolveCapitalHftStateDir({
    capitalHftRoot: tempRoot,
    capitalHftServiceRoot: "",
  });
  if (capitalHftOverride !== "C:\\override-capital-hft") {
    throw new Error(`expected CAPITAL_HFT_STATE_DIR override, got ${capitalHftOverride}`);
  }

  process.stdout.write("CAPITAL_HFT_STATE_DIR_CHECK=OK\n");
} finally {
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR;
  } else {
    process.env.OPENCLAW_CAPITAL_CAPITAL_HFT_STATE_DIR = originalOpenClawStateDir;
  }
  if (originalCapitalHftServiceStateDir === undefined) {
    delete process.env.CAPITAL_HFT_STATE_DIR;
  } else {
    process.env.CAPITAL_HFT_STATE_DIR = originalCapitalHftServiceStateDir;
  }
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}
