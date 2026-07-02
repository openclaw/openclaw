#!/usr/bin/env node
/**
 * Live repro/proof for claude-cli apiKeyHelper auth-gate fix (#97489).
 *
 * Run:
 *   pnpm exec tsx scripts/proof-claude-cli-api-key-helper-auth.mjs
 *
 * Uses an isolated HOME with only ~/.claude/settings.json (apiKeyHelper) and
 * deliberately no ~/.claude/.credentials.json — matching the issue repro shape.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_CLI_API_KEY_HELPER_MARKER,
  hasClaudeCliApiKeyHelper,
} from "../extensions/anthropic/cli-auth-seam.ts";
import anthropicProviderDiscovery from "../extensions/anthropic/provider-discovery.ts";
import { resetCliCredentialCachesForTest } from "../src/agents/cli-credentials.ts";
import { isMissingProviderAuthError } from "../src/agents/model-auth-runtime-shared.ts";
import { resolveApiKeyForProvider } from "../src/agents/model-auth.ts";

const repoRoot = path.dirname(fileURLToPath(new URL(".", import.meta.url)));

function log(section, message) {
  console.log(`[${section}] ${message}`);
}

function setupReproHome() {
  const reproHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-claude-apikeyhelper-proof-"));
  const claudeDir = path.join(reproHome, ".claude");
  const binDir = path.join(reproHome, "bin");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const helperPath = path.join(binDir, "get-anthropic-key.sh");
  fs.writeFileSync(
    helperPath,
    `#!/usr/bin/env bash
# Proof helper: Claude CLI executes this at spawn time.
printf '%s' "sk-ant-api03-proof-key-from-apiKeyHelper"
`,
    "utf8",
  );
  fs.chmodSync(helperPath, 0o755);

  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ apiKeyHelper: helperPath }, null, 2)}\n`,
    "utf8",
  );

  const credentialsPath = path.join(claudeDir, ".credentials.json");
  assert.equal(fs.existsSync(credentialsPath), false, "repro must not seed .credentials.json");

  return { reproHome, helperPath, settingsPath, credentialsPath };
}

async function main() {
  const startedAt = new Date().toISOString();
  const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

  console.log("=== claude-cli apiKeyHelper auth-gate proof ===");
  console.log(`timestamp: ${startedAt}`);
  console.log(`git: ${gitSha}`);
  console.log(`node: ${process.version}`);
  console.log(`platform: ${process.platform}`);

  const { reproHome, helperPath, settingsPath, credentialsPath } = setupReproHome();
  console.log(`repro_home: ${reproHome}`);
  console.log(`settings: ${settingsPath}`);
  console.log(`helper: ${helperPath}`);
  console.log(`credentials_exists: ${fs.existsSync(credentialsPath)}`);

  const previousHome = process.env.HOME;
  process.env.HOME = reproHome;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY_OLD;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  resetCliCredentialCachesForTest();

  try {
    log("step-1", "hasClaudeCliApiKeyHelper()");
    assert.equal(hasClaudeCliApiKeyHelper(), true);
    console.log("  ok: settings.json apiKeyHelper detected");

    log("step-2", "provider-discovery resolveSyntheticAuth({ provider: claude-cli })");
    const discoveryAuth = anthropicProviderDiscovery.resolveSyntheticAuth?.({
      provider: "claude-cli",
      config: {},
      env: process.env,
    });
    console.log("  result:", JSON.stringify(discoveryAuth));
    assert.deepEqual(discoveryAuth, {
      apiKey: CLAUDE_CLI_API_KEY_HELPER_MARKER,
      source: "Claude CLI apiKeyHelper",
      mode: "api-key",
    });

    log("step-3", "resolveApiKeyForProvider({ provider: claude-cli }) — full auth-gate path");
    let resolved;
    try {
      resolved = await resolveApiKeyForProvider({
        provider: "claude-cli",
        cfg: {},
        store: { version: 1, profiles: {} },
      });
    } catch (error) {
      if (isMissingProviderAuthError(error)) {
        console.error("  FAIL: missing-provider-auth still thrown");
        console.error(`  message: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.log("  result:", JSON.stringify(resolved));
    assert.equal(resolved.apiKey, CLAUDE_CLI_API_KEY_HELPER_MARKER);
    assert.equal(resolved.source, "Claude CLI apiKeyHelper");
    assert.equal(resolved.mode, "api-key");

    log("step-4", "direct claude CLI with repro HOME (optional network)");
    const claudeBin = execFileSync("bash", ["-lc", "command -v claude"], {
      encoding: "utf8",
    }).trim();
    if (!claudeBin) {
      console.log("  skip: claude binary not found");
    } else {
      try {
        const claudeVersion = execFileSync(claudeBin, ["--version"], {
          encoding: "utf8",
          env: { ...process.env, HOME: reproHome },
        }).trim();
        console.log(`  claude: ${claudeVersion}`);
        const claudeOutput = execFileSync(
          claudeBin,
          ["--model", "claude-sonnet-4-6", "-p", "Reply with exactly: PROOF-OK"],
          {
            encoding: "utf8",
            env: { ...process.env, HOME: reproHome },
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
          },
        );
        const snippet = claudeOutput.trim().slice(0, 200).replace(/\s+/g, " ");
        console.log(`  claude_output_snippet: ${snippet}`);
        assert.match(claudeOutput, /PROOF-OK/);
        console.log("  ok: claude CLI accepted apiKeyHelper auth and returned a reply");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  note: claude direct probe did not complete (${message.slice(0, 160)})`);
        console.log("  auth-gate proof above still stands without this network step");
      }
    }

    console.log("");
    console.log("PASS: apiKeyHelper-only Claude CLI auth passes OpenClaw synthetic auth gate");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(reproHome, { force: true, recursive: true });
  }
}

await main();
