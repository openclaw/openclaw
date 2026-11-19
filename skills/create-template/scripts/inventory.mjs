#!/usr/bin/env node
// One call for everything the create-template skill needs before writing a proposal:
// it starts the private draft and summarizes what a Template could carry. Workspace
// facts are read directly and the remaining CLI lookups run in parallel, because the
// person is waiting on this command.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import validVersion from "semver/functions/valid.js";

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
// The person is waiting: a lookup that has not answered by now is reported as a warning instead.
const COMMAND_TIMEOUT_MS = 15_000;
const DRAFT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INLINE_AVATAR = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)$/i;
const INLINE_AVATAR_EXTENSIONS = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  gif: "gif",
  "svg+xml": "svg",
};
// The same ceiling review applies to a draft avatar.
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
// Startup files a Template may carry. USER.md and MEMORY.md describe the current
// owner, so they are reported as private and never offered as source material.
const PORTABLE_FILES = [
  "SOUL.md",
  "AGENTS.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];
const PRIVATE_FILES = ["USER.md", "MEMORY.md"];

function usage(message) {
  process.stderr.write(
    `${message}\nUsage: node inventory.mjs <absolute-agent-workspace> --agent <agent-id> [--draft <draftId>] --json\n`,
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { workspace: undefined, agent: undefined, draft: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      continue;
    }
    if (arg === "--agent" || arg === "--draft") {
      const value = argv[index + 1];
      if (!value) {
        usage(`${arg} needs a value.`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--") || options.workspace) {
      usage(`Unexpected argument ${JSON.stringify(arg)}.`);
    }
    options.workspace = arg;
  }
  if (!options.workspace || !isAbsolute(options.workspace)) {
    usage("Pass the agent workspace as an absolute path.");
  }
  if (!options.agent || !AGENT_ID.test(options.agent)) {
    usage("Pass this agent's id with --agent.");
  }
  if (options.draft && !DRAFT_ID.test(options.draft)) {
    usage("--draft must be the draft id attached to this request.");
  }
  return options;
}

/** Runs one bundled CLI command and parses its JSON, without failing the whole inventory. */
function cliJson(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    // Output from an unsuccessful lookup can contain local paths or configuration.
    // Return only availability; never put that output into the proposal context.
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(code === 0 ? { ok: true, value: JSON.parse(stdout) } : { ok: false });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}

function oneLine(value, max) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function fileSize(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/** The same CLI owner initializes ordinary chat drafts and returns their actual path. */
async function requestDraft(workspace, existingId) {
  if (existingId) {
    return {
      draftId: existingId,
      path: join(workspace, ".openclaw", "template-drafts", existingId + ".json"),
    };
  }
  const result = await cliJson(["templates", "draft", workspace, "--json"]);
  const draft = result.value;
  if (
    !result.ok ||
    !draft?.ok ||
    !DRAFT_ID.test(draft.draftId) ||
    draft.path !== join(workspace, ".openclaw", "template-drafts", draft.draftId + ".json")
  ) {
    throw new Error(
      "Draft initialization did not return a confirmed result. Inspect this request before starting another draft.",
    );
  }
  return draft;
}

async function listInstructionFiles(workspace) {
  const present = [];
  for (const name of PORTABLE_FILES) {
    const bytes = await fileSize(join(workspace, name));
    if (bytes) {
      present.push({ file: name, bytes });
    }
  }
  const privateFiles = [];
  for (const name of PRIVATE_FILES) {
    if (await fileSize(join(workspace, name))) {
      privateFiles.push(name);
    }
  }
  return { present, privateFiles };
}

/** Stage only the selected agent’s local or inline image. Remote URLs are never fetched. */
async function stageAvatar(workspace, projectedUrl, draftId) {
  const inline = typeof projectedUrl === "string" && projectedUrl.match(INLINE_AVATAR);
  if (!inline) return undefined;
  const bytes = Buffer.from(inline[2], "base64");
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
    throw new Error("The agent portrait exceeds the supported image limits.");
  }
  const extension = INLINE_AVATAR_EXTENSIONS[inline[1].toLowerCase()];
  const relative = `.openclaw/template-drafts/${draftId}-avatar.${extension}`;
  const root = await fsSafeRoot(workspace);
  await root.write(relative, bytes, { mode: 0o600, overwrite: true });
  return relative;
}

function exactRelease(version) {
  return typeof version === "string" && validVersion(version) !== null && /^[0-9]/.test(version);
}

function summarizeSkills(report, workspace) {
  const skills = { workspace: [], clawhub: [] };
  for (const skill of report?.skills ?? []) {
    if (
      !skill.eligible ||
      skill.blockedByAgentFilter ||
      skill.bundled ||
      skill.name === "create-template"
    ) {
      continue;
    }
    const release = skill.clawhub;
    if (release?.valid && release.slug && exactRelease(release.installedVersion)) {
      skills.clawhub.push({
        name: skill.name,
        ref:
          release.ownerHandle && !release.slug.startsWith("@")
            ? `@${release.ownerHandle}/${release.slug}`
            : release.slug,
        version: release.installedVersion,
      });
    } else if (
      !release &&
      skill.source === "openclaw-workspace" &&
      typeof skill.baseDir === "string" &&
      dirname(resolve(skill.baseDir)) === resolve(workspace, "skills")
    ) {
      skills.workspace.push({
        name: skill.name,
        path: `skills/${basename(skill.baseDir)}`,
        description: oneLine(skill.description, 110),
      });
    }
  }
  return skills;
}

function summarizePlugins(inspections) {
  const plugins = { clawhub: [], notPortable: 0 };
  for (const { plugin, install } of inspections ?? []) {
    if (!plugin?.id || !plugin.enabled || plugin.origin === "bundled") {
      continue;
    }
    const version = install?.version ?? install?.resolvedVersion;
    if (install?.source === "clawhub" && install.clawhubPackage && exactRelease(version)) {
      plugins.clawhub.push({
        id: plugin.id,
        ref: install.clawhubPackage,
        version,
        description: oneLine(plugin.description, 90),
      });
    } else {
      plugins.notPortable += 1;
    }
  }
  return plugins;
}

function summarizeAutomations(result, agentId) {
  const automations = [];
  for (const job of result?.jobs ?? []) {
    const message = job?.payload?.kind === "agentTurn" ? job.payload.message : undefined;
    // Heartbeats and plugin-managed jobs belong to the host, not to the role being shared.
    if (
      !message ||
      job.enabled === false ||
      job.agentId !== agentId ||
      /^heartbeat-/.test(job.name ?? "") ||
      /^[a-z0-9-]+:/.test(job.declarationKey ?? "") ||
      message.startsWith("__openclaw_")
    ) {
      continue;
    }
    // Templates declare cron schedules; one-shot reminders and intervals are not routines to share.
    if (job.schedule?.kind !== "cron" || typeof job.schedule.expr !== "string") {
      continue;
    }
    automations.push({
      name: job.name,
      enabled: true,
      schedule: { cron: job.schedule.expr, timezone: job.schedule.tz ?? "UTC" },
      session: job.sessionTarget === "isolated" ? "isolated" : "main",
      message: oneLine(message, 240),
    });
  }
  return automations;
}

const options = parseArgs(process.argv.slice(2));
const [draft, plugins, automations, roster, instructions, skillReport] = await Promise.all([
  requestDraft(options.workspace, options.draft),
  cliJson(["plugins", "inspect", "--all", "--json"]),
  // Use the active-only list: a paused routine must not become a new owner’s running job.
  cliJson(["cron", "list", "--agent", options.agent, "--json"]),
  cliJson(["agents", "list", "--json"]),
  listInstructionFiles(options.workspace),
  cliJson([
    "gateway",
    "call",
    "skills.status",
    "--params",
    JSON.stringify({ agentId: options.agent }),
    "--json",
  ]),
]);
const { draftId } = draft;
const warnings = [];
const report = skillReport.value;
const hasSkills =
  skillReport.ok &&
  Array.isArray(report?.skills) &&
  typeof report.workspaceDir === "string" &&
  resolve(report.workspaceDir) === resolve(options.workspace) &&
  (!report.agentId || report.agentId === options.agent);
if (!hasSkills) warnings.push("skills unavailable for this agent workspace");
if (!plugins.ok || !Array.isArray(plugins.value)) warnings.push("plugin inspection unavailable");
if (!automations.ok) warnings.push("automation inventory unavailable");
const skills = summarizeSkills(hasSkills ? report : undefined, options.workspace);

const identity =
  roster.ok && Array.isArray(roster.value)
    ? roster.value.find(
        (row) =>
          row?.id === options.agent &&
          typeof row.workspace === "string" &&
          resolve(row.workspace) === resolve(options.workspace),
      )
    : undefined;
if (!identity) warnings.push("identity unavailable for this agent workspace");
const avatar = await stageAvatar(options.workspace, identity?.identityAvatarUrl, draftId);
const output = {
  draftId,
  draftPath: draft.path,
  agent: {
    id: options.agent,
    ...(identity?.identityName ? { name: identity.identityName } : {}),
    ...(identity?.identityEmoji ? { emoji: identity.identityEmoji } : {}),
  },
  ...(avatar ? { avatar } : {}),
  instructionFiles: instructions.present,
  privateFiles: instructions.privateFiles,
  skills,
  plugins: summarizePlugins(plugins.ok && Array.isArray(plugins.value) ? plugins.value : []),
  automations: summarizeAutomations(automations.value, options.agent),
  ...(warnings.length ? { warnings } : {}),
};
process.stdout.write(`${JSON.stringify(output, null, 1)}\n`);
