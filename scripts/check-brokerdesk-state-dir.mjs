import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveBrokerDeskStateDir } from "./lib/brokerdesk-state-dir.mjs";

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

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-brokerdesk-state-dir-"));
const olderStaging = path.join(tempRoot, "dist-staging-0001", "BrokerDesk", "state");
const newerStaging = path.join(tempRoot, "dist-staging-0002", "BrokerDesk", "state");
await writeProbeState(olderStaging, Date.now() - 60_000);
await writeProbeState(newerStaging, Date.now());

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", { value: "win32" });

const originalOpenClawStateDir = process.env.OPENCLAW_CAPITAL_BROKERDESK_STATE_DIR;
const originalBrokerDeskStateDir = process.env.BROKERDESK_STATE_DIR;

try {
  delete process.env.OPENCLAW_CAPITAL_BROKERDESK_STATE_DIR;
  delete process.env.BROKERDESK_STATE_DIR;

  const resolved = resolveBrokerDeskStateDir({ brokerDeskRoot: tempRoot });
  if (resolved !== newerStaging) {
    throw new Error(`expected newest staging dir, got ${resolved}`);
  }

  process.env.OPENCLAW_CAPITAL_BROKERDESK_STATE_DIR = "C:\\override-openclaw";
  const openClawOverride = resolveBrokerDeskStateDir({ brokerDeskRoot: tempRoot });
  if (openClawOverride !== "C:\\override-openclaw") {
    throw new Error(
      `expected OPENCLAW_CAPITAL_BROKERDESK_STATE_DIR override, got ${openClawOverride}`,
    );
  }

  delete process.env.OPENCLAW_CAPITAL_BROKERDESK_STATE_DIR;
  process.env.BROKERDESK_STATE_DIR = "C:\\override-brokerdesk";
  const brokerDeskOverride = resolveBrokerDeskStateDir({ brokerDeskRoot: tempRoot });
  if (brokerDeskOverride !== "C:\\override-brokerdesk") {
    throw new Error(`expected BROKERDESK_STATE_DIR override, got ${brokerDeskOverride}`);
  }

  process.stdout.write("BROKERDESK_STATE_DIR_CHECK=OK\n");
} finally {
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_CAPITAL_BROKERDESK_STATE_DIR;
  } else {
    process.env.OPENCLAW_CAPITAL_BROKERDESK_STATE_DIR = originalOpenClawStateDir;
  }
  if (originalBrokerDeskStateDir === undefined) {
    delete process.env.BROKERDESK_STATE_DIR;
  } else {
    process.env.BROKERDESK_STATE_DIR = originalBrokerDeskStateDir;
  }
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}
