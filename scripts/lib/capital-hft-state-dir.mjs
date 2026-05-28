import { existsSync } from "node:fs";
import path from "node:path";

const CAPITAL_HFT_SERVICE_ROOT = "D:\\群益及元大API\\CapitalHftService";

export function resolveCapitalHftStateDir() {
  if (process.env.OPENCLAW_CAPITAL_HFT_STATE_DIR) {
    return process.env.OPENCLAW_CAPITAL_HFT_STATE_DIR;
  }
  if (process.env.OPENCLAW_CAPITAL_STATE_DIR) {
    return process.env.OPENCLAW_CAPITAL_STATE_DIR;
  }
  if (process.env.OPENCLAW_CAPITAL_HFT_SERVICE_STATE_DIR) {
    return process.env.OPENCLAW_CAPITAL_HFT_SERVICE_STATE_DIR;
  }
  if (process.env.CAPITAL_HFT_STATE_DIR) {
    return process.env.CAPITAL_HFT_STATE_DIR;
  }
  if (process.platform === "win32") {
    return existsSync(CAPITAL_HFT_SERVICE_ROOT)
      ? CAPITAL_HFT_SERVICE_ROOT
      : path.join("D:\\群益及元大API", "CapitalHftService");
  }
  return path.resolve("CapitalHftService");
}
