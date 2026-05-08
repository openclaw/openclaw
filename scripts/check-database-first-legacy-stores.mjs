#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveRepoRoot, runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const sourceRoots = ["src", "extensions", "packages", "ui", "apps"];
const bridgeContractRoots = [...sourceRoots, "test"];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".swift", ".kt"]);
const displayPathRoots = ["docs", "scripts"];
const displayPathExtensions = new Set([".md", ".mdx", ".ts", ".tsx", ".mts", ".js", ".mjs", ".sh"]);

const legacyStoreMarkers = [
  { label: "sessions.json", pattern: /\bsessions\.json\b/u },
  { label: "legacy transcript lock file", pattern: /\.jsonl\.lock\b/u },
  { label: "cron jobs JSON", pattern: /\bjobs\.json\b/u },
  { label: "cron jobs state JSON", pattern: /\bjobs-state\.json\b/u },
  { label: "cron run JSONL log", pattern: /\bcron[/\\]runs[/\\][A-Za-z0-9._-]+\.jsonl\b/u },
  { label: "trajectory JSONL sidecar", pattern: /\.trajectory\.jsonl\b/u },
  { label: "ACP stream JSONL sidecar", pattern: /\.acp-stream\.jsonl\b/u },
  { label: "ACP event ledger JSON", pattern: /\bacp[/\\]event-ledger\.json\b/u },
  { label: "runtime cache JSON", pattern: /\bcache[/\\][A-Za-z0-9._-]+\.json\b/u },
  { label: "voice-call JSONL call log", pattern: /\bcalls\.jsonl\b/u },
  { label: "device-pair notify JSON", pattern: /\bdevice-pair-notify\.json\b/u },
  { label: "Active Memory session toggles JSON", pattern: /\bsession-toggles\.json\b/u },
  { label: "Nostr bus state JSON", pattern: /\bbus-state-[A-Za-z0-9._-]+\.json\b/u },
  { label: "Nostr profile state JSON", pattern: /\bprofile-state-[A-Za-z0-9._-]+\.json\b/u },
  { label: "Skill Workshop proposal JSON", pattern: /\bskill-workshop[/\\][a-f0-9]{16}\.json\b/iu },
  {
    label: "Skill Workshop reviewer session JSON",
    pattern: /\bskill-workshop[/\\]skill-workshop-review-[A-Za-z0-9._-]+\.json\b/u,
  },
  {
    label: "outbound delivery queue JSON",
    pattern: /\bdelivery-queue[/\\][A-Za-z0-9._-]+\.json\b/u,
  },
  {
    label: "session delivery queue JSON",
    pattern: /\bsession-delivery-queue[/\\][A-Za-z0-9._-]+\.json\b/u,
  },
  { label: "subagent registry JSON", pattern: /\bsubagents[/\\]runs\.json\b/u },
  { label: "OpenRouter model cache JSON", pattern: /\bopenrouter-models\.json\b/u },
  { label: "auth profile JSON", pattern: /\bauth-profiles\.json\b/u },
  { label: "auth profile state JSON", pattern: /\bauth-state\.json\b/u },
  {
    label: "retired per-agent auth JSON",
    pattern: /\bagents[/\\][A-Za-z0-9._-]+[/\\]agent[/\\]auth\.json\b/u,
  },
  {
    label: "retired per-agent model catalog JSON",
    pattern: /\bagents[/\\][A-Za-z0-9._-]+[/\\]agent[/\\]models\.json\b/u,
  },
  { label: "retired shared OAuth JSON", pattern: /\bcredentials[/\\]oauth\.json\b/u },
  { label: "exec approvals JSON", pattern: /\bexec-approvals\.json\b/u },
  { label: "workspace setup JSON", pattern: /\bworkspace-state\.json\b/u },
  {
    label: "pairing pending/paired JSON",
    pattern: /\b(?:devices|nodes)[/\\](?:pending|paired)\.json\b/u,
  },
  {
    label: "device bootstrap JSON",
    pattern: /\bdevices[/\\]bootstrap\.json\b/u,
  },
  { label: "device identity JSON", pattern: /\bidentity[/\\]device\.json\b/u },
  { label: "device auth JSON", pattern: /\bidentity[/\\]device-auth\.json\b/u },
  {
    label: "web push subscription JSON",
    pattern: /\bpush[/\\]web-push-subscriptions\.json\b/u,
  },
  { label: "web push VAPID JSON", pattern: /\bpush[/\\]vapid-keys\.json\b/u },
  { label: "APNs registration JSON", pattern: /\bpush[/\\]apns-registrations\.json\b/u },
  { label: "exec approvals JSON", pattern: /\bexec-approvals\.json\b/u },
  { label: "ACPX process leases JSON", pattern: /\bprocess-leases\.json\b/u },
  { label: "ACPX gateway instance id file", pattern: /\bgateway-instance-id\b/u },
  {
    label: "memory-core dreaming event JSONL",
    pattern: /\bmemory[/\\]\.dreams[/\\]events\.jsonl\b/u,
  },
  {
    label: "memory-core dreaming session corpus",
    pattern: /\bmemory[/\\]\.dreams[/\\]session-corpus\b/u,
  },
  {
    label: "memory-core dreaming checkpoint JSON",
    pattern:
      /\bmemory[/\\]\.dreams[/\\](?:daily-ingestion|session-ingestion|short-term-recall|phase-signals)\.json\b/u,
  },
  { label: "file-shaped memory index table", pattern: /\bmemory_index_files\b/u },
  {
    label: "memory-core dreaming promotion lock",
    pattern: /\bmemory[/\\]\.dreams[/\\]short-term-promotion\.lock\b/u,
  },
  { label: "gateway restart sentinel JSON", pattern: /\brestart-sentinel\.json\b/u },
  { label: "gateway restart intent JSON", pattern: /\bgateway-restart-intent\.json\b/u },
  {
    label: "gateway supervisor restart handoff JSON",
    pattern: /\bgateway-supervisor-restart-handoff\.json\b/u,
  },
  { label: "gateway singleton lock file", pattern: /\bgateway\.[A-Za-z0-9._-]+\.lock\b/u },
  { label: "QMD embed lock file", pattern: /\bqmd[/\\]embed\.lock\b/u },
  {
    label: "current conversation bindings JSON",
    pattern: /\bcurrent-conversations\.json\b/u,
  },
  { label: "Crestodian audit JSONL", pattern: /\bcrestodian\.jsonl\b/u },
  { label: "File Transfer audit JSONL", pattern: /\bfile-transfer\.jsonl\b/u },
  { label: "Config audit JSONL", pattern: /\bconfig-audit\.jsonl\b/u },
  { label: "command logger text log", pattern: /\bcommands\.log\b/u },
  { label: "Android camera debug log", pattern: /\bcamera_debug\.log\b/u },
  { label: "Config health JSON", pattern: /\bconfig-health\.json\b/u },
  { label: "macOS port guardian JSON", pattern: /\bport-guard\.json\b/u },
  {
    label: "Crestodian rescue pending JSON",
    pattern: /\bcrestodian[/\\]rescue-pending[/\\][A-Za-z0-9._-]+\.json\b/u,
  },
  { label: "Phone Control arm state JSON", pattern: /\bphone-control[/\\]armed\.json\b/u },
  { label: "Voice Wake settings JSON", pattern: /\bsettings[/\\]voicewake\.json\b/u },
  {
    label: "Voice Wake routing settings JSON",
    pattern: /\bsettings[/\\]voicewake-routing\.json\b/u,
  },
  {
    label: "plugin conversation binding approvals JSON",
    pattern: /\bplugin-binding-approvals\.json\b/u,
  },
  { label: "Memory Wiki source sync JSON", pattern: /\bsource-sync\.json\b/u },
  { label: "Memory Wiki activity JSONL", pattern: /\b\.openclaw-wiki[/\\]log\.jsonl\b/u },
  { label: "Memory Wiki vault metadata JSON", pattern: /\b\.openclaw-wiki[/\\]state\.json\b/u },
  { label: "Memory Wiki vault lock directory", pattern: /\b\.openclaw-wiki[/\\]locks\b/u },
  {
    label: "Memory Wiki import run JSON",
    pattern: /\bimport-runs[/\\][A-Za-z0-9._-]+\.json\b/u,
  },
  {
    label: "Memory Wiki compiled digest cache JSON",
    pattern: /\b\.openclaw-wiki[/\\]cache[/\\](?:agent-digest\.json|claims\.jsonl)\b/u,
  },
  { label: "ClawHub skill lock JSON", pattern: /\b\.clawhub[/\\]lock\.json\b/u },
  { label: "ClawHub skill origin JSON", pattern: /\b\.clawhub[/\\]origin\.json\b/u },
  { label: "Browser profile decoration marker", pattern: /\b\.openclaw-profile-decorated\b/u },
  { label: "installed plugin index JSON", pattern: /\bplugins[/\\]installs\.json\b/u },
  { label: "QQBot known users JSON", pattern: /\bknown-users\.json\b/u },
  { label: "QQBot ref-index JSONL", pattern: /\bref-index\.jsonl\b/u },
  {
    label: "QQBot credential backup JSON",
    pattern: /\bcredential-backup(?:-[A-Za-z0-9._-]+)?\.json\b/u,
  },
  { label: "BlueBubbles catchup cursor JSON", pattern: /\bbluebubbles[/\\]catchup\b/u },
  { label: "BlueBubbles inbound dedupe JSON", pattern: /\bbluebubbles[/\\]inbound-dedupe\b/u },
  { label: "Telegram sticker cache JSON", pattern: /\bsticker-cache\.json\b/u },
  { label: "Telegram update offset JSON", pattern: /\bupdate-offset-[A-Za-z0-9._-]+\.json\b/u },
  { label: "generic thread bindings JSON", pattern: /\bthread-bindings\.json\b/u },
  { label: "Telegram thread bindings JSON", pattern: /\bthread-bindings-[A-Za-z0-9._-]+\.json\b/u },
  { label: "Telegram sent-message cache JSON", pattern: /\.telegram-sent-messages\.json\b/u },
  { label: "Telegram message cache JSON", pattern: /\.telegram-messages\.json\b/u },
  { label: "Telegram topic-name cache JSON", pattern: /\.telegram-topic-names\.json\b/u },
  { label: "iMessage catchup cursor JSON", pattern: /\bimessage[/\\]catchup\b/u },
  { label: "iMessage reply cache JSONL", pattern: /\bimessage[/\\]reply-cache\.jsonl\b/u },
  { label: "iMessage sent echo cache JSONL", pattern: /\bimessage[/\\]sent-echoes\.jsonl\b/u },
  { label: "Feishu dedupe cache JSON", pattern: /\bfeishu[/\\]dedup[/\\][A-Za-z0-9_-]+\.json\b/u },
  {
    label: "Zalo outbound media JSON/bin sidecar",
    pattern: /\bopenclaw-zalo-outbound-media\b/u,
  },
  { label: "Microsoft Teams conversations JSON", pattern: /\bmsteams-conversations\.json\b/u },
  { label: "Microsoft Teams polls JSON", pattern: /\bmsteams-polls\.json\b/u },
  {
    label: "Microsoft Teams pending uploads JSON",
    pattern: /\bmsteams-pending-uploads\.json\b/u,
  },
  { label: "Microsoft Teams SSO token JSON", pattern: /\bmsteams-sso-tokens\.json\b/u },
  { label: "Microsoft Teams delegated token JSON", pattern: /\bmsteams-delegated\.json\b/u },
  { label: "Microsoft Teams feedback learnings JSON", pattern: /\.learnings\.json\b/u },
  { label: "Matrix sync store JSON", pattern: /\bbot-storage\.json\b/u },
  { label: "Matrix QA sync store JSON", pattern: /\bsync-store\.json\b/u },
  { label: "Matrix storage metadata JSON", pattern: /\bstorage-meta\.json\b/u },
  { label: "Matrix inbound dedupe JSON", pattern: /\binbound-dedupe\.json\b/u },
  { label: "Matrix startup verification JSON", pattern: /\bstartup-verification\.json\b/u },
  {
    label: "Matrix credentials JSON",
    pattern:
      /\b(?:credentials[/\\]matrix[/\\]credentials(?:-[A-Za-z0-9._-]+)?|matrix[/\\][^\n"'`]*credentials(?:-[A-Za-z0-9._-]+)?)\.json\b/u,
  },
  { label: "Matrix recovery key JSON", pattern: /\brecovery-key\.json\b/u },
  { label: "Matrix IndexedDB snapshot JSON", pattern: /\bcrypto-idb-snapshot\.json\b/u },
  { label: "GitHub Copilot token JSON", pattern: /\bgithub-copilot\.token\.json\b/u },
  {
    label: "Discord model-picker preferences JSON",
    pattern: /\bmodel-picker-preferences\.json\b/u,
  },
  { label: "Discord command deploy cache JSON", pattern: /\bcommand-deploy-cache\.json\b/u },
  {
    label: "QQBot gateway session JSON",
    pattern: /\bqqbot[/\\]sessions[/\\]session-[A-Za-z0-9_-]+\.json\b/u,
  },
  { label: "sandbox registry JSON", pattern: /\b(?:containers|browsers)\.json\b/u },
  { label: "native hook relay bridge JSON", pattern: /\bopenclaw-native-hook-relays\b/u },
  { label: "plugin-state sidecar SQLite", pattern: /\bplugin-state[/\\]state\.sqlite\b/u },
  { label: "runtime state sidecar SQLite", pattern: /\bopenclaw-state\.sqlite\b/u },
  { label: "task registry sidecar SQLite", pattern: /\btasks[/\\]runs\.sqlite\b/u },
  {
    label: "Task Flow registry sidecar SQLite",
    pattern: /\btasks[/\\]flows[/\\]registry\.sqlite\b/u,
  },
  { label: "debug proxy blob directory env", pattern: /\bOPENCLAW_DEBUG_PROXY_BLOB_DIR\b/u },
  { label: "debug proxy sidecar schema", pattern: /\bPROXY_CAPTURE_SCHEMA_SQL\b/u },
  {
    label: "debug proxy sidecar SQLite schema file",
    pattern: /\bsrc[/\\]proxy-capture[/\\]schema\.sql\b/u,
  },
];

const writeApiPattern =
  /\b(?:appendFile|appendFileSync|appendRegularFile|appendRegularFileSync|createWriteStream|getQueuedFileWriter|openSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|writeFile|writeFileSync|writeJson|writeJsonAtomic)\b/u;
const legacySessionStoreApiPattern =
  /\b(?:loadSessionStore|saveSessionStore|updateSessionStore|updateSessionStoreEntry|resolveStorePath|resolveLegacySessionStorePath)\b/u;
const legacyTranscriptApiPattern =
  /\b(?:parseSessionEntries|migrateSessionEntries|migrateLegacySessionEntries|parseTranscriptEntries|streamSessionTranscriptLines(?:Reverse)?|selectActivePath|hasBrokenPromptRewriteBranch|migrateSessionTranscriptFileToSqlite)\b/u;
const forbiddenRuntimeLocatorContractMarkers = [
  {
    label: "transcript locator runtime contract",
    pattern: /\btranscriptLocator\b/u,
  },
  {
    label: "SQLite transcript pseudo-locator",
    pattern: /sqlite-transcript:\/\//u,
  },
  {
    label: "session transcript file runtime contract",
    pattern: /\bsessionFile\b/u,
  },
  {
    label: "trajectory runtime locator contract",
    pattern: /\bruntimeLocator\b/u,
  },
  {
    label: "file-backed session manager opener",
    pattern: /\bSessionManager\.open\(/u,
  },
  {
    label: "legacy SessionManager SQLite opener facade",
    pattern:
      /\b(?:SessionManager|TranscriptSessionManager)\.(?:create|openForSession|continueRecent|forkFromSession|list|listAll)\b/u,
  },
  {
    label: "session-manager transcript listing facade",
    pattern: /\b(?:SessionManager|TranscriptSessionManager)\.listAll\b/u,
  },
  {
    label: "session-manager transcript fork facade",
    pattern: /\b(?:SessionManager|TranscriptSessionManager)\.forkFromSession\b/u,
  },
  {
    label: "session-manager mutable new-session facade",
    pattern: /\b(?:SessionManager|TranscriptSessionManager)\.newSession\b/u,
  },
  {
    label: "session-manager branch-session facade",
    pattern: /\b(?:SessionManager|TranscriptSessionManager)\.createBranchedSession\b/u,
  },
  {
    label: "SessionManager-based tool result truncation",
    pattern: /\btruncateOversizedToolResultsInSessionManager\b/u,
  },
  {
    label: "SessionManager tail removal bridge",
    pattern: /\bremoveSessionManagerTailEntries\b/u,
  },
  {
    label: "session store path runtime contract",
    pattern: /\bsessionStorePath\b/u,
  },
  {
    label: "session accounting transcript locator output",
    pattern: /\bnewTranscriptLocator\b/u,
  },
  {
    label: "embedded run agent meta transcript locator output",
    pattern: /\bagentMeta\??\.transcriptLocator\b/u,
  },
  {
    label: "embedded attempt transcript locator output",
    pattern: /\btranscriptLocatorUsed\b/u,
  },
  {
    label: "context engine compaction transcript locator output",
    pattern: /\bresult\??\.transcriptLocator\b/u,
  },
  {
    label: "session JSONL export downloader",
    pattern: /\bdownloadSessionJson\b/u,
  },
  {
    label: "session JSONL export button",
    pattern: /\bdownload-json-btn\b/u,
  },
  {
    label: "file-shaped memory session transcript helper",
    pattern: /\blistSessionTranscriptsForAgent\b/u,
  },
  {
    label: "file-shaped memory session source-key helper",
    pattern: /\bsessionSourceKeyFor(?:Scope|Transcript)\b/u,
  },
  {
    label: "pi-mono raw stream diagnostics env",
    pattern: /\bPI_RAW_STREAM(?:_PATH)?\b/u,
  },
  {
    label: "pi-mono raw stream diagnostics JSONL",
    pattern: /\braw-openai-completions\.jsonl\b/u,
  },
  {
    label: "Android camera debug file contract",
    pattern: /\bcamera_debug\.log\b/u,
  },
  {
    label: "Android debug log temp file contract",
    pattern: /\bdebug_logs\.txt\b/u,
  },
  {
    label: "Android notification recent packages SharedPreferences key",
    pattern: /\bnotifications\.(?:forwarding\.)?recentPackages\b/u,
  },
  {
    label: "memory index file-path resolved contract",
    pattern: /\b(?:settings|resolvedMemory)\.store\.path\b/u,
  },
  {
    label: "workspace setup fake state path",
    pattern: /\.openclaw[/\\]setup-state\b/u,
  },
  {
    label: "ClawHub runtime lockfile abstraction",
    pattern: /\bClawHubSkillsLockfile\b/u,
  },
  {
    label: "ClawHub runtime origin file abstraction",
    pattern: /\bClawHubSkillOrigin\b/u,
  },
];

const forbiddenBridgeFixtureMarkers = [
  {
    label: "runtime state sidecar SQLite fixture",
    pattern: /\bopenclaw-state\.sqlite\b/u,
  },
  {
    label: "plugin-state sidecar-shaped SQLite helper",
    pattern:
      /\b(?:resolvePluginStateSqlitePath|closePluginStateSqliteStore|clearPluginStateSqliteStoreForTests|seedPluginStateSqliteEntriesForTests)\b/u,
  },
  {
    label: "task registry sidecar-shaped SQLite helper",
    pattern:
      /\b(?:resolveTaskRegistrySqlitePath|resolveTaskFlowRegistrySqlitePath|closeTaskRegistrySqliteStore|closeTaskFlowRegistrySqliteStore)\b/u,
  },
];

const forbiddenGenericMemoryIndexSqlMarkers = [
  {
    label: "generic memory vector table",
    pattern: /\bchunks_vec\b/u,
  },
  {
    label: "generic memory FTS table",
    pattern: /\bchunks_fts\b/u,
  },
  {
    label: "generic memory embedding cache table",
    pattern: /\bembedding_cache\b/u,
  },
  {
    label: "generic memory meta table SQL",
    pattern:
      /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|FROM|INTO|UPDATE|DELETE\s+FROM)\s+meta\b/iu,
  },
  {
    label: "generic memory files table SQL",
    pattern:
      /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|FROM|INTO|UPDATE|DELETE\s+FROM)\s+files\b/iu,
  },
  {
    label: "generic memory chunks table SQL",
    pattern:
      /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+chunks\b/iu,
  },
];

const forbiddenEmbeddingJsonMarkers = [
  {
    label: "embedding TEXT schema",
    pattern: /\bembedding\s+TEXT\b/iu,
  },
  {
    label: "embedding JSON array write",
    pattern: /\bJSON\.stringify\(\s*embedding\s*\)/u,
  },
  {
    label: "embedding raw ArrayBuffer write",
    pattern: /\bnew\s+Float32Array\(\s*embedding\s*\)\.buffer\b/u,
  },
];

const forbiddenRootDoctorLegacyModuleMarkers = [
  {
    label: "root doctor SQLite state importer module",
    pattern:
      /(?:^|[/\\])doctor-sqlite-state(?:\.test)?\.(?:ts|js)\b|(?:['"`])(?:\.{1,2}\/)+doctor-sqlite-state\.js(?:['"`])/u,
  },
  {
    label: "root doctor cron importer module",
    pattern:
      /(?:^|[/\\])doctor-cron(?:\.test)?\.(?:ts|js)\b|(?:['"`])(?:\.{1,2}\/)+doctor-cron\.js(?:['"`])/u,
  },
  {
    label: "root doctor sandbox registry importer module",
    pattern:
      /(?:^|[/\\])doctor-sandbox-registry-migration(?:\.test)?\.(?:ts|js)\b|(?:['"`])(?:\.{1,2}\/)+doctor-sandbox-registry-migration\.js(?:['"`])/u,
  },
  {
    label: "root doctor state migrations facade",
    pattern:
      /(?:^|[/\\])doctor-state-migrations\.(?:ts|js)\b|(?:['"`])(?:\.{1,2}\/)+doctor-state-migrations\.js(?:['"`])/u,
  },
  {
    label: "root doctor legacy config module",
    pattern:
      /(?:^|[/\\])doctor-legacy-config(?:\.migrations)?(?:\.test)?\.(?:ts|js)\b|(?:['"`])(?:\.{1,2}\/)+doctor-legacy-config\.js(?:['"`])/u,
  },
  {
    label: "root doctor legacy OAuth repair module",
    pattern:
      /(?:^|[/\\])doctor-auth-legacy-oauth(?:\.test)?\.(?:ts|js)\b|(?:['"`])(?:\.{1,2}\/)+doctor-auth-legacy-oauth\.js(?:['"`])/u,
  },
  {
    label: "root doctor flat auth profile importer module",
    pattern:
      /(?:^|[/\\])doctor-auth-flat-profiles(?:\.test)?\.(?:ts|js)\b|(?:['"`])(?:\.{1,2}\/)+doctor-auth-flat-profiles\.js(?:['"`])/u,
  },
];

const allowedExactPaths = new Set([
  "extensions/discord/src/doctor-legacy-state.ts",
  "extensions/feishu/src/doctor-legacy-state.ts",
  "extensions/imessage/src/doctor-legacy-state.ts",
  "extensions/matrix/src/doctor-legacy-state.ts",
  "extensions/matrix/src/doctor-state-imports.ts",
  "extensions/memory-wiki/src/doctor-legacy-digest-state.ts",
  "extensions/memory-wiki/src/doctor-legacy-source-sync-state.ts",
  "extensions/memory-wiki/src/digest-state-migration.ts",
  "extensions/memory-wiki/src/source-sync-state-migration.ts",
  "extensions/memory-wiki/src/source-sync-migration.ts",
  "extensions/msteams/src/doctor-legacy-state.ts",
  "extensions/nostr/src/doctor-legacy-state.ts",
  "extensions/skill-workshop/src/doctor-legacy-state.ts",
  "extensions/qqbot/src/doctor-legacy-state.ts",
  "extensions/telegram/src/doctor-legacy-state.ts",
  "extensions/whatsapp/src/doctor-legacy-state.ts",
  "extensions/memory-wiki/src/log-migration.ts",
]);

const allowedPrefixes = ["src/commands/doctor", "src/commands/export-trajectory"];

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isGeneratedPath(relativePath) {
  return (
    relativePath.includes(".generated.") ||
    relativePath.endsWith("/generated.ts") ||
    relativePath.includes("/generated/")
  );
}

function isTestPath(relativePath) {
  return (
    /(?:^|[./-])(?:test|spec)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /\.(?:test|spec|e2e|live)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    relativePath.includes(".test.") ||
    relativePath.includes(".test-harness.") ||
    relativePath.includes(".e2e.") ||
    relativePath.includes(".live.") ||
    relativePath.includes("test-helpers") ||
    relativePath.includes("test-utils") ||
    relativePath.includes("test-support") ||
    relativePath.includes("/test/")
  );
}

function isAllowedPath(relativePath) {
  return (
    allowedExactPaths.has(relativePath) ||
    allowedPrefixes.some((prefix) => relativePath.startsWith(prefix))
  );
}

async function collectSourceFiles(root, options = {}) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".turbo" ||
        entry.name === ".build"
      ) {
        continue;
      }
      files.push(...(await collectSourceFiles(entryPath, options)));
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }
    const relativePath = toPosixPath(path.relative(repoRoot, entryPath));
    if (
      isGeneratedPath(relativePath) ||
      (!options.includeTests && isTestPath(relativePath)) ||
      isAllowedPath(relativePath)
    ) {
      continue;
    }
    files.push({ absolutePath: entryPath, relativePath });
  }
  return files;
}

async function collectFilesWithExtensions(root, extensions) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".turbo" ||
        entry.name === ".build"
      ) {
        continue;
      }
      files.push(...(await collectFilesWithExtensions(entryPath, extensions)));
      continue;
    }
    if (!entry.isFile() || !extensions.has(path.extname(entry.name))) {
      continue;
    }
    const relativePath = toPosixPath(path.relative(repoRoot, entryPath));
    if (isGeneratedPath(relativePath)) {
      continue;
    }
    files.push({ absolutePath: entryPath, relativePath });
  }
  return files;
}

function lineForIndex(content, index) {
  return content.slice(0, index).split("\n").length;
}

function findViolations(content, relativePath) {
  const violations = [];
  if (legacySessionStoreApiPattern.test(content)) {
    for (const match of content.matchAll(new RegExp(legacySessionStoreApiPattern, "gu"))) {
      violations.push({
        path: relativePath,
        line: lineForIndex(content, match.index ?? 0),
        label: "legacy whole-session-store API",
      });
    }
  }
  if (legacyTranscriptApiPattern.test(content)) {
    for (const match of content.matchAll(new RegExp(legacyTranscriptApiPattern, "gu"))) {
      violations.push({
        path: relativePath,
        line: lineForIndex(content, match.index ?? 0),
        label: "legacy transcript JSONL API",
      });
    }
  }
  if (writeApiPattern.test(content)) {
    for (const marker of legacyStoreMarkers) {
      for (const match of content.matchAll(new RegExp(marker.pattern, "gu"))) {
        violations.push({
          path: relativePath,
          line: lineForIndex(content, match.index ?? 0),
          label: marker.label,
        });
      }
    }
  }
  for (const marker of forbiddenRuntimeLocatorContractMarkers) {
    for (const match of content.matchAll(new RegExp(marker.pattern, "gu"))) {
      violations.push({
        path: relativePath,
        line: lineForIndex(content, match.index ?? 0),
        label: marker.label,
      });
    }
  }
  for (const marker of forbiddenGenericMemoryIndexSqlMarkers) {
    for (const match of content.matchAll(new RegExp(marker.pattern, "gu"))) {
      violations.push({
        path: relativePath,
        line: lineForIndex(content, match.index ?? 0),
        label: marker.label,
      });
    }
  }
  for (const marker of forbiddenEmbeddingJsonMarkers) {
    for (const match of content.matchAll(new RegExp(marker.pattern, "gu"))) {
      violations.push({
        path: relativePath,
        line: lineForIndex(content, match.index ?? 0),
        label: marker.label,
      });
    }
  }
  return violations;
}

function findBridgeContractViolations(content, relativePath) {
  const violations = [];
  for (const marker of forbiddenRuntimeLocatorContractMarkers) {
    for (const match of content.matchAll(new RegExp(marker.pattern, "gu"))) {
      violations.push({
        path: relativePath,
        line: lineForIndex(content, match.index ?? 0),
        label: marker.label,
      });
    }
  }
  for (const marker of forbiddenBridgeFixtureMarkers) {
    for (const match of content.matchAll(new RegExp(marker.pattern, "gu"))) {
      violations.push({
        path: relativePath,
        line: lineForIndex(content, match.index ?? 0),
        label: marker.label,
      });
    }
  }
  return violations;
}

function findRootDoctorLegacyModuleViolations(content, relativePath) {
  const checkedText = `${relativePath}\n${content}`;
  const violations = [];
  for (const marker of forbiddenRootDoctorLegacyModuleMarkers) {
    for (const match of checkedText.matchAll(new RegExp(marker.pattern, "gu"))) {
      violations.push({
        path: relativePath,
        line: lineForIndex(checkedText, match.index ?? 0),
        label: marker.label,
      });
    }
  }
  return violations;
}

function findDisplayPathViolations(content, relativePath) {
  const violations = [];
  const displayPathMarkers = [
    {
      label: "legacy auth profile KV display path",
      pattern: /(?:#|SQLite\s+`)kv\/auth-profiles\b/gu,
    },
    {
      label: "legacy pairing KV display path",
      pattern: /SQLite\s+`kv`\s+scope\s+`pairing\.channel`/gu,
    },
  ];
  for (const marker of displayPathMarkers) {
    for (const match of content.matchAll(marker.pattern)) {
      violations.push({
        path: relativePath,
        line: lineForIndex(content, match.index ?? 0),
        label: marker.label,
      });
    }
  }
  return violations;
}

async function main() {
  const runtimeFiles = (
    await Promise.all(sourceRoots.map((root) => collectSourceFiles(path.join(repoRoot, root))))
  ).flat();
  const violations = [];
  for (const file of runtimeFiles) {
    if (isAllowedPath(file.relativePath)) {
      continue;
    }
    const content = await fs.readFile(file.absolutePath, "utf8");
    violations.push(...findViolations(content, file.relativePath));
    violations.push(...findRootDoctorLegacyModuleViolations(content, file.relativePath));
  }
  const testFiles = (
    await Promise.all(
      bridgeContractRoots.map((root) =>
        collectSourceFiles(path.join(repoRoot, root), { includeTests: true }),
      ),
    )
  )
    .flat()
    .filter((file) => isTestPath(file.relativePath) || file.relativePath.startsWith("test/"));
  for (const file of testFiles) {
    if (isAllowedPath(file.relativePath)) {
      continue;
    }
    const content = await fs.readFile(file.absolutePath, "utf8");
    violations.push(...findBridgeContractViolations(content, file.relativePath));
    violations.push(...findRootDoctorLegacyModuleViolations(content, file.relativePath));
  }
  const displayPathFiles = (
    await Promise.all(
      displayPathRoots.map((root) =>
        collectFilesWithExtensions(path.join(repoRoot, root), displayPathExtensions),
      ),
    )
  ).flat();
  for (const file of displayPathFiles) {
    const content = await fs.readFile(file.absolutePath, "utf8");
    violations.push(...findDisplayPathViolations(content, file.relativePath));
  }

  if (violations.length === 0) {
    console.log("database-first legacy store guard: runtime source looks OK.");
    return;
  }

  console.error("database-first legacy store guard: runtime source still uses legacy stores:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.label}`);
  }
  console.error(
    "Move runtime writes to SQLite. Keep legacy JSON/JSONL/sidecar SQLite handling inside doctor/migration/import/export code only.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
