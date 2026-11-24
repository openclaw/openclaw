import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const gitBin = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const stat = (file) => fs.lstatSync(file, { throwIfNoEntry: false });
const within = (parent, file) => file === parent || file.startsWith(parent + path.sep);
const credentialDirectories = new Set([".ssh", ".codex", ".gnupg", ".openclaw"]);
const git = (root, ...args) =>
  execFileSync(gitBin, ["-C", root, ...args], { encoding: "utf8", maxBuffer: Infinity });

// Native realpath normalizes case on macOS. Resolve missing ancestors after
// partial closeout; selected artifacts pass only their parent so a symlink's
// leaf remains an entry to unlink, never a target authorized for deletion.
function physical(file) {
  const absolute = path.resolve(file);
  return stat(absolute)
    ? fs.realpathSync.native(absolute)
    : path.join(physical(path.dirname(absolute)), path.basename(absolute));
}

function requireOutsideCredentialStores(target, symlink = false) {
  const roots = [
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"),
    path.join(os.homedir(), ".ssh"),
    path.join(os.homedir(), ".gnupg"),
  ].flatMap((directory) => [path.resolve(directory), physical(directory)]);
  // A selected link may point at a store, but may not remove an entry in one.
  if (
    roots.some((directory) => within(directory, target) || (!symlink && within(target, directory)))
  ) {
    throw new Error(`Selected resource overlaps a credential/state store: ${target}`);
  }
}

function selectedArtifact(root, worktree, requested) {
  const input = path.resolve(root, requested);
  const target = path.join(physical(path.dirname(input)), path.basename(input));
  const artifacts = path.join(root, ".artifacts");
  const entry = stat(target);
  if (
    target !== input ||
    (entry && !fs.readdirSync(path.dirname(target)).includes(path.basename(target))) ||
    !(
      (within(artifacts, target) && target !== artifacts) ||
      (worktree && within(worktree, target) && target !== worktree)
    ) ||
    target
      .split(path.sep)
      .some((part) => part === ".git" || credentialDirectories.has(part.toLowerCase()))
  ) {
    throw new Error(`Artifact outside task boundaries or noncanonical path: ${requested}`);
  }
  if (entry && !entry.isDirectory() && !entry.isSymbolicLink()) {
    throw new Error(`Select artifact directories or symlinks, not files: ${target}`);
  }
  requireOutsideCredentialStores(target, entry?.isSymbolicLink());
  return { path: target, identity: entry ? `${entry.dev}:${entry.ino}` : "" };
}

function requireNoCredentialStores(directory) {
  if (!stat(directory)?.isDirectory()) {
    return;
  }
  const pending = [directory];
  while (pending.length) {
    const parent = pending.pop();
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      // Dirents do not follow symlinks; unlinking a link preserves its store.
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(parent, entry.name);
      if (credentialDirectories.has(entry.name.toLowerCase())) {
        throw new Error(`Selected artifact contains a credential/state store: ${child}`);
      }
      pending.push(child);
    }
  }
}

function* dependencyReferences(directory) {
  const root = physical(directory);
  yield root;
  const pending = [root];
  if (stat(directory).isSymbolicLink()) {
    yield path.resolve(path.dirname(directory), fs.readlinkSync(directory));
  }
  while (pending.length) {
    const parent = pending.pop();
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const child = path.join(parent, entry.name);
      if (entry.isSymbolicLink()) {
        // Inspect installed package links, including scopes and nested stores,
        // without recursively following targets outside this installation.
        yield path.resolve(parent, fs.readlinkSync(child));
        try {
          yield physical(child);
        } catch (error) {
          // Broken package links still retain their literal target reference.
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
      } else if (entry.isDirectory()) {
        pending.push(child);
      }
    }
  }
}

function inventory(plan) {
  const { root, worktree, artifacts } = plan;
  if (worktree) {
    requireOutsideCredentialStores(worktree);
  }
  const rootArtifacts = artifacts.filter((resource) =>
    within(path.join(root, ".artifacts"), resource.path),
  );
  if (
    rootArtifacts.length &&
    git(
      root,
      "ls-files",
      "-z",
      "--",
      ...rootArtifacts.map((resource) => `:(literal)${path.relative(root, resource.path)}`),
    )
  ) {
    throw new Error("Selected root artifact contains tracked source");
  }
  if (worktree && stat(worktree)) {
    const entry = stat(worktree);
    if (
      entry.isSymbolicLink() ||
      physical(worktree) !== worktree ||
      `${entry.dev}:${entry.ino}` !== plan.worktreeIdentity
    ) {
      throw new Error("Selected worktree identity changed");
    }
    if (git(worktree, "rev-parse", "HEAD").trim() !== plan.head) {
      throw new Error("Expected worktree HEAD changed");
    }
    if (
      git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").trim() !==
      plan.common
    ) {
      throw new Error("Worktree repository identity changed");
    }
    if (
      git(
        worktree,
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=no",
        "--ignore-submodules=none",
      )
    ) {
      throw new Error("Worktree has tracked changes");
    }
    const tracked = git(worktree, "ls-files", "-z").split("\0").filter(Boolean);
    for (const resource of artifacts) {
      if (tracked.some((file) => within(resource.path, path.join(worktree, file)))) {
        throw new Error(`Artifact contains tracked source: ${resource.path}`);
      }
    }
    // No exclude-standard: Git otherwise silently removes ignored .env files
    // even without --force. Include empty untracked directories too.
    const unknown = git(worktree, "ls-files", "--others", "--directory", "-z")
      .split("\0")
      .filter(Boolean);
    const requireSelected = (target) => {
      if (artifacts.some((resource) => within(resource.path, target))) {
        return;
      }
      // Git collapses wholly untracked directories. Expand only ancestors of
      // explicit selections; their empty shells are safe after partial cleanup.
      if (
        stat(target)?.isDirectory() &&
        artifacts.some((resource) => within(target, resource.path))
      ) {
        for (const name of fs.readdirSync(target)) {
          requireSelected(path.join(target, name));
        }
        return;
      }
      throw new Error(`Unselected ignored or untracked content: ${target}`);
    };
    for (const file of unknown) {
      requireSelected(path.resolve(worktree, file));
    }
  }
  // A task installation can become shared by another registered checkout,
  // including tracked contents removed with the selected worktree itself.
  const resources = worktree ? [{ path: worktree }, ...artifacts] : artifacts;
  const registrations = git(root, "worktree", "list", "--porcelain", "-z").split("\0");
  for (const record of registrations) {
    if (!record.startsWith("worktree ")) {
      continue;
    }
    const checkout = record.slice(9);
    if (checkout === worktree || !stat(checkout)) {
      continue;
    }
    const registered = physical(checkout);
    if (
      artifacts.some(
        (resource) =>
          (registered !== root && within(registered, resource.path)) ||
          (!stat(resource.path)?.isSymbolicLink() && within(resource.path, registered)),
      )
    ) {
      throw new Error(`Artifact overlaps a registered worktree; use its native owner: ${checkout}`);
    }
    const dependencies = path.join(checkout, "node_modules");
    if (!stat(dependencies)) {
      continue;
    }
    for (const shared of dependencyReferences(dependencies)) {
      if (
        resources.some(
          (resource) =>
            within(shared, resource.path) ||
            (!stat(resource.path)?.isSymbolicLink() && within(resource.path, shared)),
        )
      ) {
        throw new Error(`Shared dependencies are referenced by ${checkout}`);
      }
    }
  }
  for (const resource of artifacts) {
    const fresh = selectedArtifact(root, worktree, resource.path);
    if (fresh.path !== resource.path || (fresh.identity && fresh.identity !== resource.identity)) {
      throw new Error(`Selected artifact identity changed: ${resource.path}`);
    }
  }
}

function requireNoProcessHolders(resources) {
  const scan = spawnSync("lsof", ["-nP", "-Fpn0"], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: Infinity,
  });
  if (scan.error || scan.status !== 0 || !scan.stdout) {
    throw new Error("Unable to inspect process holders; check lsof before retrying");
  }
  let pid;
  for (const field of scan.stdout.split("\0")) {
    const record = field.replace(/^\n/, "");
    if (record.startsWith("p")) {
      pid = record.slice(1);
    }
    if (!record.startsWith("n") || !path.isAbsolute(record.slice(1))) {
      continue;
    }
    const held = resources.find((resource) => within(resource, record.slice(1)));
    if (held) {
      throw new Error(`Live process ${pid} holds ${held}; release it before closeout`);
    }
  }
}

// This covers the responding native daemon, never an invented host-wide census.
// An explicitly selected independent daemon must also be available.
async function withCodex(socket, run) {
  const address =
    socket ||
    path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "app-server-control/app-server-control.sock",
    );
  const client = new WebSocket("ws://localhost/", {
    createConnection: () => net.connect(address),
    handshakeTimeout: 10000,
  });
  let nextId = 0;
  /** @type {Map<number, {method: string, resolve: (value: unknown) => void, reject: (error: Error) => void}>} */
  const pending = new Map();
  const unavailable = () => {
    for (const { reject } of pending.values()) {
      reject(new Error("Known Codex owner unavailable"));
    }
    pending.clear();
  };
  client.on("error", unavailable);
  client.on("close", unavailable);
  client.on("message", (bytes) => {
    let message;
    try {
      const buffer = Buffer.isBuffer(bytes)
        ? bytes
        : Array.isArray(bytes)
          ? Buffer.concat(bytes)
          : Buffer.from(bytes);
      message = JSON.parse(buffer.toString("utf8"));
    } catch {
      unavailable();
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(`Known Codex owner refused ${request.method}`));
    } else {
      request.resolve(message.result);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} unavailable`));
      }, 10000);
      pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      client.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          unavailable();
        }
      });
    });
  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", () => reject(new Error("Known Codex owner unavailable")));
    });
    await request("initialize", {
      clientInfo: { name: "openclaw-pr-closeout", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.send(JSON.stringify({ method: "initialized", params: {} }));
    return await run(request);
  } finally {
    // Only this read-only client is closed; it never starts or stops the daemon.
    client.terminate();
  }
}

async function pages(request, method, params) {
  const rows = [],
    cursors = new Set();
  let cursor = null;
  do {
    const page = await request(method, { ...params, cursor, limit: 100 });
    if (
      !Array.isArray(page?.data) ||
      !(page.nextCursor === null || typeof page.nextCursor === "string") ||
      cursors.has(page.nextCursor)
    ) {
      throw new Error(`Incomplete Codex ${method} census`);
    }
    rows.push(...page.data);
    cursor = page.nextCursor;
    if (cursor !== null) {
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return rows;
}

async function requireNoSessionReferences(plan) {
  const resources = [plan.worktree, ...plan.artifacts.map((entry) => entry.path)].filter(Boolean);
  await withCodex(plan.socket, async (request) => {
    const loaded = await pages(request, "thread/loaded/list", {});
    if (loaded.some((id) => typeof id !== "string" || !id)) {
      throw new Error("Incomplete loaded thread identities");
    }
    const known = new Set([plan.task, ...plan.threads, ...loaded]);
    if (plan.worktree) {
      for (const attachmentType of ["worktree", "archived_worktree"]) {
        for (const owner of await pages(request, "thread/attachmentOwner/list", {
          attachmentType,
          identityKey: plan.worktree,
          archived: null,
        })) {
          if (typeof owner.threadId !== "string" || typeof owner.archived !== "boolean") {
            throw new Error("Incomplete attachment owner metadata");
          }
          known.add(owner.threadId);
        }
      }
    }
    for (const id of known) {
      const { thread } = await request("thread/read", { threadId: id, includeTurns: false });
      if (
        thread?.id !== id ||
        typeof thread.cwd !== "string" ||
        !path.isAbsolute(thread.cwd) ||
        !["notLoaded", "active", "idle", "systemError"].includes(thread.status?.type)
      ) {
        throw new Error(`Incomplete known thread metadata: ${id}`);
      }
      if (thread.status.type !== "notLoaded" && !Array.isArray(thread.environments)) {
        throw new Error(`Unavailable session environment coverage: ${id}`);
      }
      const references = [thread.cwd];
      for (const environment of thread.environments ?? []) {
        if (
          typeof environment.cwd !== "string" ||
          !Array.isArray(environment.runtimeWorkspaceRoots)
        ) {
          throw new Error(`Incomplete thread environment: ${id}`);
        }
        references.push(environment.cwd, ...environment.runtimeWorkspaceRoots);
      }
      for (const attachment of await pages(request, "thread/attachment/list", { threadId: id })) {
        if (!["worktree", "archived_worktree"].includes(attachment.attachmentType)) {
          continue;
        }
        const worktree =
          attachment.attachmentType === "archived_worktree"
            ? attachment.payload?.worktree
            : attachment.payload;
        if (typeof worktree?.root !== "string" || typeof worktree?.workspaceRoot !== "string") {
          throw new Error(`Incomplete worktree attachment: ${id}`);
        }
        references.push(worktree.root, worktree.workspaceRoot);
      }
      // Unloaded historical sessions are not live consumers. Their metadata
      // still must be available. A finalizing owner cannot remove its own cwd.
      if (id === plan.task || thread.status.type !== "notLoaded") {
        for (const reference of references) {
          if (typeof reference !== "string" || !path.isAbsolute(reference)) {
            throw new Error(`Unknown session path coverage: ${id}`);
          }
          if (
            resources.some(
              (resource) =>
                within(resource, path.resolve(reference)) || within(resource, physical(reference)),
            )
          ) {
            throw new Error(
              `Live session ${id} references selected resources; release its cwd/attachment first`,
            );
          }
        }
      }
    }
  });
}

function checkNativeEvidence(plan) {
  const directories = [
    plan.worktree,
    path.join(plan.root, ".worktrees", `pr-${plan.pr}`),
    ...plan.artifacts.map((entry) => entry.path),
  ].filter(Boolean);
  for (const directory of directories) {
    if (stat(directory)?.isSymbolicLink()) {
      continue;
    }
    const local = path.join(directory, ".local");
    if (!stat(local)) {
      continue;
    }
    for (const name of fs.readdirSync(local)) {
      if (/^merge-output(?:\..*)?\.log$/.test(name) || name === "review-transition.json") {
        throw new Error(
          `Native recovery evidence retained: ${path.join(local, name)}; use its recovery owner`,
        );
      }
    }
  }
  if (plan.admin && stat(path.join(plan.admin, "codex-thread.json"))) {
    throw new Error("Codex-managed worktree: use its native owner for removal");
  }
}

function requireLock(plan, ref, oid) {
  if (
    ref !== `refs/openclaw/pr-operation-locks/${plan.pr}` ||
    !oid ||
    git(plan.root, "rev-parse", "--verify", ref).trim() !== oid
  ) {
    throw new Error("Native operation ownership changed");
  }
}

async function verify(plan) {
  inventory(plan);
  checkNativeEvidence(plan);
  await requireNoSessionReferences(plan);
  // Awaited owner reads do not freeze filesystem or process ownership.
  inventory(plan);
  checkNativeEvidence(plan);
  for (const resource of plan.artifacts) {
    requireNoCredentialStores(resource.path);
  }
  requireNoProcessHolders(
    [plan.worktree, ...plan.artifacts.map((entry) => entry.path)].filter(Boolean),
  );
}

try {
  const [action, ...args] = process.argv.slice(2);
  if (action === "merged-pr") {
    const [root, pr, head, input] = args;
    const observation = JSON.parse(input);
    const origin = git(root, "remote", "get-url", "origin").trim();
    const address = new URL(origin.replace(/^git@([^:]+):/, "ssh://git@$1/"));
    const expected = `https://${address.host}${address.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
    if (
      observation.number !== Number(pr) ||
      observation.state !== "MERGED" ||
      observation.headRefOid !== head ||
      observation.baseRepository?.url?.toLowerCase() !== expected.toLowerCase() ||
      observation.url !== `${observation.baseRepository.url}/pull/${pr}`
    ) {
      throw new Error("Repository identity, merged PR state, or expected PR HEAD does not match");
    }
  } else if (action === "inspect") {
    const [rootInput, stateInput, pr, head, task, socket, count, ...selection] = args;
    const state = JSON.parse(stateInput);
    const root = fs.realpathSync(rootInput);
    const worktree = state.path || "";
    const plan = {
      root,
      worktree,
      pr,
      head,
      task,
      socket,
      threads: selection.slice(0, Number(count)),
      common: state.common,
      admin: state.admin,
      worktreeIdentity: state.identity,
      artifacts: selection
        .slice(Number(count))
        .map((input) => selectedArtifact(root, worktree, input)),
    };
    if (
      new Set(plan.artifacts.map((entry) => entry.path)).size !== plan.artifacts.length ||
      plan.artifacts.some((entry, i) =>
        plan.artifacts.some((other, j) => i !== j && within(entry.path, other.path)),
      )
    ) {
      throw new Error("Select each artifact once, without overlapping selections");
    }
    await verify(plan);
    console.log(JSON.stringify(plan));
  } else if (action === "remove-artifacts" || action === "verify") {
    const [input, ref, oid] = args;
    const plan = JSON.parse(input);
    await verify(plan);
    requireLock(plan, ref, oid);
    if (action === "remove-artifacts") {
      for (const resource of plan.artifacts) {
        inventory(plan);
        requireLock(plan, ref, oid);
        if (!stat(resource.path)) {
          console.log(`already absent artifact ${resource.path}`);
          continue;
        }
        requireNoCredentialStores(resource.path);
        requireNoProcessHolders([resource.path]);
        requireLock(plan, ref, oid);
        fs.rmSync(resource.path, { recursive: true });
        if (stat(resource.path)) {
          throw new Error(`Artifact removal incomplete: ${resource.path}`);
        }
        console.log(`removed artifact ${resource.path}`);
      }
    }
  } else {
    throw new Error("Unknown finalized-task operation");
  }
} catch (error) {
  console.error(`Finalized-task closeout incomplete: ${error.message}`);
  process.exitCode = 1;
}
