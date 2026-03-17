import { detectBinary } from "../../../src/commands/onboard-helpers.js";
import { loadConfig } from "../../../src/config/config.js";
import { runCommandWithTimeout } from "../../../src/process/exec.js";
import { createIMessageRpcClient } from "./client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS as DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS2 } from "./constants.js";
const rpcSupportCache = /* @__PURE__ */ new Map();
async function probeRpcSupport(cliPath, timeoutMs) {
  const cached = rpcSupportCache.get(cliPath);
  if (cached) {
    return cached;
  }
  try {
    const result = await runCommandWithTimeout([cliPath, "rpc", "--help"], { timeoutMs });
    const combined = `${result.stdout}
${result.stderr}`.trim();
    const normalized = combined.toLowerCase();
    if (normalized.includes("unknown command") && normalized.includes("rpc")) {
      const fatal = {
        supported: false,
        fatal: true,
        error: 'imsg CLI does not support the "rpc" subcommand (update imsg)'
      };
      rpcSupportCache.set(cliPath, fatal);
      return fatal;
    }
    if (result.code === 0) {
      const supported = { supported: true };
      rpcSupportCache.set(cliPath, supported);
      return supported;
    }
    return {
      supported: false,
      error: combined || `imsg rpc --help failed (code ${String(result.code ?? "unknown")})`
    };
  } catch (err) {
    return { supported: false, error: String(err) };
  }
}
async function probeIMessage(timeoutMs, opts = {}) {
  const cfg = opts.cliPath || opts.dbPath ? void 0 : loadConfig();
  const cliPath = opts.cliPath?.trim() || cfg?.channels?.imessage?.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || cfg?.channels?.imessage?.dbPath?.trim();
  const effectiveTimeout = timeoutMs ?? cfg?.channels?.imessage?.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;
  const detected = await detectBinary(cliPath);
  if (!detected) {
    return { ok: false, error: `imsg not found (${cliPath})` };
  }
  const rpcSupport = await probeRpcSupport(cliPath, effectiveTimeout);
  if (!rpcSupport.supported) {
    return {
      ok: false,
      error: rpcSupport.error ?? "imsg rpc unavailable",
      fatal: rpcSupport.fatal
    };
  }
  const client = await createIMessageRpcClient({
    cliPath,
    dbPath,
    runtime: opts.runtime
  });
  try {
    await client.request("chats.list", { limit: 1 }, { timeoutMs: effectiveTimeout });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await client.stop();
  }
}
export {
  DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS2 as DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS,
  probeIMessage
};
