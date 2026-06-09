#!/usr/bin/env node
// Enforces the app-owned HTTP egress boundary: runtime fetches should use the
// canonical helper unless an owner-specific transport has a documented reason.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_EXTENSIONS = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const RAW_FETCH_PATTERN =
  /(?<![.$\w])(?:globalThis\.|global\.)?fetch\s*\(|(?<![.$\w])fetchWithTimeout\s*\(|from\s+["']undici["']|import\s*\(\s*["']undici["']\s*\)|loadUndiciRuntimeDeps\(\)\.fetch\s*\(/u;
const RETIRED_GUARD_PATTERNS = [
  {
    name: "fetchWithSsrFGuard",
    pattern: /\bfetchWithSsrFGuard\b/u,
  },
  {
    name: "openclaw/plugin-sdk/ssrf-runtime",
    pattern: /openclaw\/plugin-sdk\/ssrf-runtime(?:["']|$)/u,
  },
  {
    name: "withTrustedEnvProxyGuardedFetchMode",
    pattern: /\bwithTrustedEnvProxyGuardedFetchMode\b/u,
  },
  {
    name: "GUARDED_FETCH_MODE",
    pattern: /\bGUARDED_FETCH_MODE\b/u,
  },
  {
    name: "useTrustedEnvProxy",
    pattern: /\buseTrustedEnvProxy\b/u,
  },
  {
    name: "generic ssrfPolicy fetch plumbing",
    pattern:
      /\bssrfPolicy\b[\s\S]{0,160}\bfetch(?:With\w*|Fn|Impl)?\b|\bfetch(?:With\w*|Fn|Impl)?\b[\s\S]{0,160}\bssrfPolicy\b/u,
  },
];
const RETIRED_FETCH_RUNTIME_EXPORT_PATTERN =
  /\b(?:createPinnedLookup|PinnedDispatcherPolicy|SsrFPolicy|LookupFn|SsrFBlockedError|fetchWithSsrFGuard|GUARDED_FETCH_MODE)\b/u;

const RAW_FETCH_ALLOWLIST = new Map(
  [
    [
      "src/infra/net/egress-fetch.ts",
      "canonical HTTP egress helper; proxy.enabled is honored through dispatcher policy",
    ],
    [
      "src/infra/net/runtime-fetch.ts",
      "low-level dispatcher bridge used by the canonical helper; proxy.enabled handled by callers",
    ],
    [
      "src/infra/net/undici-runtime.ts",
      "lazy undici constructor/runtime loader; proxy.enabled handled by callers",
    ],
    [
      "src/infra/net/ssrf.ts",
      "legacy address/classifier and dispatcher owner retained for browser/CDP and low-level proxy helpers; proxy.enabled handled by callers",
    ],
    [
      "src/infra/net/proxy/managed-proxy-undici.ts",
      "managed proxy undici TLS helper; proxy.enabled owner",
    ],
    [
      "src/utils/fetch-timeout.ts",
      "generic timeout primitive retained for non-egress and owner-specific transports; proxy.enabled handled by callers",
    ],
    [
      "src/media-understanding/shared.ts",
      "owner-specific provider helper keeps provider fetch mechanics behind fetchWithTimeoutGuarded; proxy.enabled is honored via canonical helper",
    ],
    [
      "src/agents/tools/web-search-provider-common.ts",
      "web search provider compatibility helper owns cross-origin auth redirect behavior; proxy.enabled is honored through dispatcher policy",
    ],
    [
      "src/agents/mcp-http-fetch.ts",
      "MCP HTTP transport installs the runtime fetch hook through undici; proxy.enabled is honored by its dispatcher policy",
    ],
    [
      "src/agents/utils/tools-manager.ts",
      "operator/plugin configured package metadata endpoint; not arbitrary user/content URL egress; proxy.enabled is not honored by this owner",
    ],
    [
      "packages/memory-host-sdk/src/host/remote-http.ts",
      "memory remote HTTP package owns URL validation on every hop; proxy.enabled is not honored by this package",
    ],
    [
      "src/cli/nodes-camera.ts",
      "camera node media download is protocol-owned and same-host HTTPS-only; proxy.enabled is not honored",
    ],
    [
      "src/agents/sandbox/browser.ts",
      "browser/CDP boundary is explicitly out of scope for this egress refactor; proxy.enabled is not the policy owner here",
    ],
    [
      "src/agents/provider-local-service.ts",
      "local provider health check targets OpenClaw-owned loopback service endpoints; proxy.enabled is intentionally bypassed",
    ],
    [
      "src/agents/runtime/proxy.ts",
      "agent runtime proxy connects to an operator-configured proxy URL; proxy.enabled is not the owner of this transport",
    ],
    [
      "src/agents/anthropic-transport-stream.ts",
      "Anthropic SDK transport adapter receives an injected fetch implementation; proxy.enabled is owned by the caller",
    ],
    [
      "src/agents/auth-profiles/usage.ts",
      "fixed OpenClaw usage endpoint, not arbitrary user/model URL egress; proxy.enabled is not honored by this owner",
    ],
    [
      "src/agents/minimax-vlm.ts",
      "provider-owned fixed API endpoint; proxy.enabled is not honored by this owner",
    ],
    [
      "src/agents/tools/pdf-native-providers.ts",
      "provider-owned fixed API endpoints; proxy.enabled is not honored by this owner",
    ],
    [
      "src/cli/capability-cli.ts",
      "CLI capability video import is an operator command path; proxy.enabled is not honored by this owner",
    ],
    [
      "src/commands/docs.ts",
      "operator docs command fetches the configured docs site; proxy.enabled is not honored by this owner",
    ],
    [
      "src/commands/onboard-custom.ts",
      "operator onboarding checks configured endpoints; proxy.enabled is not honored by this owner",
    ],
    [
      "src/crestodian/probes.ts",
      "local process health probe; proxy.enabled is intentionally bypassed",
    ],
    [
      "src/gateway/server-cron-notifications.ts",
      "operator-configured webhook transport; proxy.enabled is not honored by this owner",
    ],
    [
      "src/gateway/gateway-cli-backend.live-probe-helpers.ts",
      "live local gateway probe helper; proxy.enabled is intentionally bypassed",
    ],
    [
      "src/infra/push-apns.relay.ts",
      "operator-configured APNS relay endpoint; proxy.enabled is not honored by this owner",
    ],
    [
      "src/infra/update-check.ts",
      "fixed OpenClaw update metadata endpoint; proxy.enabled is not honored by this owner",
    ],
    [
      "src/llm/providers/openai-chatgpt-responses.ts",
      "provider transport path with provider-owned base URL; proxy.enabled is not honored by this owner",
    ],
    [
      "src/llm/utils/oauth/anthropic.ts",
      "OAuth exchange against fixed provider endpoint; proxy.enabled is not honored by this owner",
    ],
    [
      "src/llm/utils/oauth/github-copilot.ts",
      "OAuth exchange against fixed provider endpoint; proxy.enabled is not honored by this owner",
    ],
    [
      "src/plugin-sdk/qa-runtime.ts",
      "QA runtime test transport helper; proxy.enabled is not the policy owner here",
    ],
    [
      "src/plugin-sdk/provider-catalog-live-runtime.ts",
      "catalog live runtime type surface for dispatcher-aware callers; proxy.enabled handled by callers",
    ],
    [
      "src/plugins/openai-compatible-embedding-provider.ts",
      "provider-owned operator-configured base URL; proxy.enabled is not honored by this owner",
    ],
    [
      "src/plugins/provider-self-hosted-setup.ts",
      "operator-configured self-hosted provider setup; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/discord/src/monitor/rest-fetch.ts",
      "Discord transport-specific REST fetch; proxy.enabled is honored by this owner",
    ],
    [
      "extensions/discord/src/internal/listeners.ts",
      "Discord SDK type shim exposes a message.fetch method, not runtime HTTP egress; proxy.enabled is not applicable",
    ],
    [
      "extensions/discord/src/internal/structures.ts",
      "Discord SDK structure method delegates to Discord REST owner, not global fetch; proxy.enabled is owned by Discord transport",
    ],
    [
      "extensions/discord/src/probe.ts",
      "Discord fixed API probe transport; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/google/oauth.http.ts",
      "Google OAuth helper owns Google API transport; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/google/oauth.project.ts",
      "Google API owner uses Google OAuth helper; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/google/oauth.token.ts",
      "Google OAuth token exchange uses Google OAuth helper; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/googlechat/src/google-auth.runtime.ts",
      "Google Chat auth runtime carries dispatcher types for Google transport; proxy.enabled honored by owner-specific dispatcher",
    ],
    [
      "extensions/imessage/src/monitor/catchup.ts",
      "iMessage monitor receives injected fetch delegate; proxy.enabled is owned by caller",
    ],
    [
      "extensions/qa-lab/src/docker-harness.ts",
      "QA Lab Docker health commands run inside local containers; proxy.enabled is intentionally bypassed",
    ],
    [
      "extensions/qa-lab/src/mantis/slack-desktop-smoke.runtime.ts",
      "Mantis proof runtime embeds a Slack API setup probe for QA automation; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/qa-lab/src/mantis/telegram-desktop-builder.runtime.ts",
      "Mantis proof runtime embeds a Telegram API setup probe for QA automation; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/qa-lab/web/src/app.ts",
      "QA Lab browser UI fetches same-origin app routes; proxy.enabled is not applicable",
    ],
    [
      "extensions/qa-matrix/src/cli.runtime.ts",
      "QA Matrix fault-proxy CLI inspects undici dispatcher state; proxy.enabled is the subject under test",
    ],
    [
      "extensions/qqbot/src/engine/api/api-client.ts",
      "QQBot API transport helper owns vendor calls; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/qqbot/src/engine/tools/channel-api.ts",
      "QQBot channel API transport helper owns vendor calls; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/qqbot/src/engine/adapter/types.ts",
      "QQBot adapter types document owner-specific fetch init options, not runtime HTTP egress; proxy.enabled is owned by QQBot transport",
    ],
    [
      "extensions/signal/src/client-container.ts",
      "Signal CLI local REST container transport; proxy.enabled is intentionally bypassed",
    ],
    [
      "extensions/telegram/src/audit-membership-runtime.ts",
      "Telegram audit helper receives injected fetch delegate; proxy.enabled is owned by caller",
    ],
    [
      "extensions/telegram/src/fetch.ts",
      "Telegram transport-specific REST fetch; proxy.enabled is honored by this owner",
    ],
    [
      "extensions/telegram/src/probe.ts",
      "Telegram fixed Bot API probe transport; proxy.enabled is not honored by this owner",
    ],
    [
      "extensions/telegram/src/telegram-ingress-worker.runtime.ts",
      "Telegram ingress worker receives injected fetch delegate; proxy.enabled is owned by caller",
    ],
    [
      "extensions/vydra/shared.ts",
      "Vydra provider transport uses injected/fixed owner fetches; proxy.enabled is not honored by this owner",
    ],
  ].map(([file, reason]) => [file, reason]),
);

const RETIRED_VOCABULARY_ALLOWLIST = new Set([
  "src/infra/net/ssrf.ts",
  "src/plugin-sdk/ssrf-policy.ts",
  "src/plugin-sdk/ssrf-runtime-internal.ts",
  "src/commands/doctor/shared/legacy-config-migrate.ts",
  "src/commands/doctor/shared/legacy-web-fetch-migrate.ts",
]);

const RETAINED_SSRF_POLICY_OWNER_PREFIXES = [
  "extensions/browser/",
  "extensions/discord/",
  "extensions/github-copilot/",
  "extensions/google/",
  "extensions/lmstudio/",
  "extensions/matrix/",
  "extensions/minimax/",
  "extensions/msteams/",
  "extensions/openai/",
  "extensions/openrouter/",
  "extensions/qqbot/",
  "extensions/slack/",
  "extensions/tlon/",
  "extensions/vydra/",
  "packages/memory-host-sdk/",
  "src/config/",
  "src/image-generation/",
  "src/media/",
  "src/media-understanding/",
  "src/plugin-sdk/lmstudio-runtime.ts",
];

function normalizeRepoPath(value) {
  return value.split(path.sep).join("/");
}

function shouldScanRuntimeFile(file) {
  const normalized = normalizeRepoPath(file);
  if (!RUNTIME_EXTENSIONS.test(normalized)) {
    return false;
  }
  if (
    normalized.includes("/assets/") ||
    normalized.includes("/dist/") ||
    normalized.includes("/fixtures/") ||
    normalized.includes("/test-support/") ||
    normalized.includes("/test-helpers/") ||
    normalized.includes("test-helpers") ||
    normalized.includes("test-harness") ||
    normalized.includes("e2e-harness") ||
    normalized.startsWith("src/plugins/contracts/") ||
    normalized.includes(".test.") ||
    normalized.includes(".e2e.") ||
    normalized.includes(".live.") ||
    normalized.endsWith(".d.ts") ||
    normalized === "scripts/check-runtime-http-egress-boundary.mjs"
  ) {
    return false;
  }
  return (
    normalized.startsWith("src/") ||
    normalized.startsWith("extensions/") ||
    normalized.startsWith("packages/")
  );
}

function findMatchingRuntimeLine(source, pattern) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
      continue;
    }
    if (pattern.test(line)) {
      return index + 1;
    }
  }
  return undefined;
}

function isRetiredVocabularyAllowlisted(file, name) {
  if (RETIRED_VOCABULARY_ALLOWLIST.has(file)) {
    return true;
  }
  if (name !== "generic ssrfPolicy fetch plumbing") {
    return false;
  }
  return RETAINED_SSRF_POLICY_OWNER_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function collectRuntimeHttpEgressBoundaryViolations(files, readFile = readFileSync) {
  const violations = [];
  for (const file of files.map(normalizeRepoPath).filter(shouldScanRuntimeFile)) {
    let source;
    try {
      source = readFile(file, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const rawFetchLine = findMatchingRuntimeLine(source, RAW_FETCH_PATTERN);
    if (rawFetchLine && !RAW_FETCH_ALLOWLIST.has(file)) {
      violations.push(
        `${file}:${rawFetchLine} raw runtime fetch must use src/infra/net/egress-fetch.ts or add an approved transport exception with whether proxy.enabled is honored`,
      );
    }

    if (file === "src/plugin-sdk/fetch-runtime.ts") {
      const retiredFetchRuntimeExportLine = findMatchingRuntimeLine(
        source,
        RETIRED_FETCH_RUNTIME_EXPORT_PATTERN,
      );
      if (retiredFetchRuntimeExportLine) {
        violations.push(
          `${file}:${retiredFetchRuntimeExportLine} fetch-runtime must not export retired SSRF guard or pinned-dispatcher APIs; use src/plugin-sdk/ssrf-dispatcher.ts for narrow pinned-dispatcher helpers`,
        );
      }
    }

    for (const { name, pattern } of RETIRED_GUARD_PATTERNS) {
      if (!isRetiredVocabularyAllowlisted(file, name)) {
        const line = findMatchingRuntimeLine(source, pattern);
        if (line) {
          violations.push(
            `${file}:${line} retired ${name} vocabulary is not allowed; use the canonical egress helper or a named retained owner`,
          );
        }
      }
    }
  }
  return violations;
}

function gitFiles() {
  return execFileSync("git", ["ls-files", "src", "extensions", "packages"], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function main() {
  const violations = collectRuntimeHttpEgressBoundaryViolations(gitFiles());
  if (violations.length > 0) {
    console.error("Runtime HTTP egress boundary violations:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Runtime HTTP egress boundary check passed.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
