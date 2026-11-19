#!/usr/bin/env node
// One call for everything the create-template skill needs before writing a proposal:
// it starts the private draft and summarizes what a Template could carry. Workspace
// facts are read directly and the remaining CLI lookups run in parallel, because the
// person is waiting on this command.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
// The person is waiting: a lookup that has not answered by now is reported as a warning instead.
const COMMAND_TIMEOUT_MS = 15_000;
const DRAFT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const AVATAR_IMAGE = /\.(?:png|jpe?g|webp|gif|svg)$/i;
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
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: "timed out" });
        return;
      }
      try {
        resolve({
          ok: code === 0,
          value: JSON.parse(stdout),
          error: code === 0 ? undefined : stderr.trim(),
        });
      } catch {
        resolve({ ok: false, error: (stderr || stdout).trim().slice(0, 300) || `exit ${code}` });
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

/**
 * Starts this request's private proposal. Same location, id shape, and empty document
 * as `openclaw templates draft`, without paying for a CLI start on the waiting path.
 */
async function createDraft(workspace) {
  const directory = join(workspace, ".openclaw", "template-drafts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const path of [join(workspace, ".openclaw"), directory]) {
    if (!(await lstat(path)).isDirectory()) {
      throw new Error("The workspace draft folder is not a plain directory.");
    }
  }
  const draftId = randomUUID();
  const document = {
    name: "my-template",
    description: "",
    version: "0.1.0",
    scope: { input: "", job: "", output: "", authority: "" },
    manifest: "---\nschemaVersion: 1\nagent:\n  id: my-template\n---\n",
    files: [],
  };
  await writeFile(join(directory, `${draftId}.json`), `${JSON.stringify(document, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return draftId;
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

/**
 * A workspace-relative image for the agent's avatar, if it has one. An avatar chosen in
 * the Control UI is stored inline as a data URL, so it is written beside the draft for
 * review to read as a file; the agent never has to copy image data into the proposal.
 */
async function resolveAvatar(workspace, identity, draftId) {
  let candidate = typeof identity?.avatar === "string" ? identity.avatar.trim() : "";
  if (!candidate) {
    try {
      const identityFile = await readFile(join(workspace, "IDENTITY.md"), "utf8");
      candidate = identityFile.match(/^\s*-?\s*\**avatar\**\s*:\s*(\S.*)$/im)?.[1]?.trim() ?? "";
    } catch {
      candidate = "";
    }
  }
  const inline = candidate.match(INLINE_AVATAR);
  if (inline) {
    const bytes = Buffer.from(inline[2], "base64");
    if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
      return undefined;
    }
    const extension = INLINE_AVATAR_EXTENSIONS[inline[1].toLowerCase()];
    const relative = `.openclaw/template-drafts/${draftId}-avatar.${extension}`;
    try {
      await writeFile(join(workspace, relative), bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      // A repeated inventory for the same draft finds the file it already wrote.
      if (error?.code !== "EEXIST") {
        return undefined;
      }
    }
    return relative;
  }
  if (!candidate || /^[a-z][a-z0-9+.-]*:/i.test(candidate) || isAbsolute(candidate)) {
    return undefined;
  }
  const relative = normalize(candidate).split(sep).join("/");
  if (relative.startsWith("../") || relative === ".." || !AVATAR_IMAGE.test(relative)) {
    return undefined;
  }
  return (await fileSize(join(workspace, relative))) ? relative : undefined;
}

async function readClawHubSkillLock(workspace) {
  try {
    const lock = JSON.parse(await readFile(join(workspace, ".clawhub", "lock.json"), "utf8"));
    return lock && typeof lock.skills === "object" && lock.skills ? lock.skills : {};
  } catch {
    return {};
  }
}

function frontmatterValue(frontmatter, key) {
  const lines = frontmatter.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) {
    return "";
  }
  const inline = lines[index].slice(key.length + 1).trim();
  if (inline && !/^[|>][+-]?$/.test(inline)) {
    return inline.replace(/^(["'])(.*)\1$/, "$2");
  }
  const block = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && !/^\s/.test(line)) {
      break;
    }
    block.push(line.trim());
  }
  return block.join(" ");
}

/**
 * Only skills in this agent's own workspace can travel with a Template: ClawHub
 * installs by exact release, and the rest as folders the agent re-authors.
 */
async function listWorkspaceSkills(workspace) {
  const lock = await readClawHubSkillLock(workspace);
  const skills = { workspace: [], clawhub: [] };
  let entries = [];
  try {
    entries = await readdir(join(workspace, "skills"), { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    // A workspace override of this skill is tooling, not part of the role being shared.
    if (entry.name === "create-template") {
      continue;
    }
    let text;
    try {
      text = await readFile(join(workspace, "skills", entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.replace(/\r/g, "") ?? "";
    const name = frontmatterValue(frontmatter, "name") || entry.name;
    const locked = lock[entry.name] ?? lock[name];
    if (locked?.version) {
      const ref = locked.ownerHandle ? `@${locked.ownerHandle}/${entry.name}` : entry.name;
      skills.clawhub.push({ name, ref, version: locked.version });
    } else {
      skills.workspace.push({
        name,
        path: `skills/${entry.name}`,
        description: oneLine(frontmatterValue(frontmatter, "description"), 110),
      });
    }
  }
  return skills;
}

function summarizePlugins(result) {
  // Only ClawHub releases can be declared; locally installed plugins are counted, not listed.
  const plugins = { clawhub: [], notPortable: 0 };
  for (const plugin of result?.plugins ?? []) {
    if (!plugin?.id || plugin.origin === "bundled" || plugin.enabled === false) {
      continue;
    }
    const spec = typeof plugin.trust?.installSpec === "string" ? plugin.trust.installSpec : "";
    const clawhub = spec.match(/^clawhub:(.+)@([^@]+)$/);
    if (clawhub) {
      plugins.clawhub.push({
        id: plugin.id,
        ref: clawhub[1],
        version: clawhub[2],
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
      enabled: job.enabled !== false,
      schedule: { cron: job.schedule.expr, timezone: job.schedule.tz ?? "UTC" },
      session: job.sessionTarget === "isolated" ? "isolated" : "main",
      message: oneLine(message, 240),
    });
  }
  return automations;
}

const options = parseArgs(process.argv.slice(2));
let draftId = options.draft;
try {
  draftId ??= await createDraft(options.workspace);
} catch (error) {
  process.stderr.write(`Could not start the private Template draft: ${error.message}\n`);
  process.exit(1);
}

const [plugins, automations, identity, instructions, skills] = await Promise.all([
  cliJson(["plugins", "list", "--enabled", "--json"]),
  cliJson(["cron", "list", "--agent", options.agent, "--all", "--json"]),
  cliJson(["config", "get", `agents.entries.${options.agent}.identity`, "--json"]),
  listInstructionFiles(options.workspace),
  listWorkspaceSkills(options.workspace),
]);

const warnings = [];
if (!plugins.ok) warnings.push(`plugins unavailable: ${plugins.error}`);
if (!automations.ok) warnings.push(`automations unavailable: ${automations.error}`);

const avatar = await resolveAvatar(
  options.workspace,
  identity.ok ? identity.value : undefined,
  draftId,
);
const output = {
  draftId,
  draftPath: join(options.workspace, ".openclaw", "template-drafts", `${draftId}.json`),
  agent: {
    id: options.agent,
    ...(identity.ok && identity.value?.name ? { name: identity.value.name } : {}),
    ...(identity.ok && identity.value?.emoji ? { emoji: identity.value.emoji } : {}),
  },
  ...(avatar ? { avatar } : {}),
  instructionFiles: instructions.present,
  privateFiles: instructions.privateFiles,
  skills,
  plugins: summarizePlugins(plugins.value),
  automations: summarizeAutomations(automations.value, options.agent),
  ...(warnings.length ? { warnings } : {}),
};
process.stdout.write(`${JSON.stringify(output, null, 1)}\n`);
