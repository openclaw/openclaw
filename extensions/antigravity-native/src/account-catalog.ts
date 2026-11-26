import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { decodeAgyCatalog } from "./catalog.js";

/** Both catalog publication and turn admission use the same native account and CLI listing. */
export async function readAgyAccountCatalog(
  signal: AbortSignal,
  timeoutMs: number,
  assertCurrent: () => void,
) {
  assertCurrent();
  const home = await realpath(homedir());
  const profile = join(home, ".gemini", "antigravity-cli");
  const settingsPath = join(profile, "settings.json");
  let settingsText: string | undefined;
  try {
    settingsText = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw new AgentHarnessPreflightError("Cannot read native Antigravity account settings.");
    }
  }
  if (settingsText !== undefined) {
    let settings: unknown;
    try {
      settings = JSON.parse(settingsText);
    } catch {
      throw new AgentHarnessPreflightError("Cannot parse native Antigravity account settings.");
    }
    if (
      !isRecord(settings) ||
      (settings.modelProvider !== undefined && settings.modelProvider !== "")
    ) {
      throw new AgentHarnessPreflightError(
        "This native Antigravity profile is not in account sign-in mode. No Gemini key or alternate backend will be selected.",
      );
    }
  }
  // Native agy may run its own children under the owner's Full access consent. Never
  // forward the Gateway environment or any host proxy, API key, or cloud identity.
  const path = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter);
  if (!path) {
    throw new AgentHarnessPreflightError("Antigravity requires an absolute Gateway PATH entry.");
  }
  const env = { HOME: home, PATH: path, LANG: "C.UTF-8" };
  assertCurrent();
  const catalog = await runCommandBuffered(["agy", "--output-format", "json", "models"], {
    cwd: home,
    preparedEnv: env,
    signal,
    timeoutMs: Math.min(timeoutMs, 15_000),
    killProcessTree: true,
    maxOutputBytes: 1024 * 1024,
    discardOutput: { stderr: true },
  });
  assertCurrent();
  if (catalog.code !== 0 || catalog.termination !== "exit") {
    throw new AgentHarnessPreflightError(
      "Antigravity account model discovery failed. Check that agy is installed and signed in as the Gateway service user.",
    );
  }
  const models = decodeAgyCatalog(catalog.stdout.toString("utf8"));
  return { profile, env, models };
}
