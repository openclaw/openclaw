import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getAgentWorkspaceAccess as getAccess,
  prepareAgentWorkspaceAttachments as prepareAttachments,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, onTestFinished as onTestComplete, vi } from "vitest";
import {
  createWorkspaceFixture,
  expectMissing,
  workspaceSkillRequest,
  type WorkspaceFixture,
} from "./workspace-fixture.test-support.js";
import { registerNodeWorkspaces } from "./workspace-service.js";
import { createNodeWorkspaceTestTransport as createTransport } from "./workspace-service.test-support.js";

vi.mock("./shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let f: WorkspaceFixture;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function writeSkill(root: string, name: string, file = "SKILL.md") {
  const directory = path.join(root, "skills", name);
  const instructions = `---\nname: ${name}\ndescription: Test resources\n---\nUse supporting files.\n`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, file), instructions);
  return { directory, instructions };
}

async function privateSkill(kind: string) {
  const root = kind === "execution" ? path.join(f.remote, "execution") : f.remote;
  const { directory } = await writeSkill(
    root,
    "private-tool",
    kind === "symlink" ? "private.md" : "SKILL.md",
  );
  const file = path.join(
    directory,
    kind === "symlink" ? "private.md" : kind === "skill card" ? "skill-card.md" : "SKILL.md",
  );
  if (kind === "symlink") {
    await fs.symlink("private.md", path.join(directory, "SKILL.md"));
    f.nodePolicy.followSymlinks = true;
  }
  if (kind === "skill card") {
    await fs.writeFile(file, "Private skill card");
  }
  return { directory, file };
}

async function expectDenied(
  output: Uint8Array[],
  read: () => Promise<unknown>,
  error?: string | RegExp,
) {
  output.length = 0;
  await expect(read()).rejects.toThrow(error);
  expect(output).toEqual([]);
}

const skillRequest = () => workspaceSkillRequest(f.local, true);

function captureOutput() {
  const output: Uint8Array[] = [];
  f.openDuplex = createTransport(f.api, f.remote, undefined, (bytes) => output.push(bytes));
  return output;
}

const pairingChanged = {
  message: "node pairing changed while invocation was active",
  code: "UNAVAILABLE",
  retryable: true,
  details: { code: "PAIRING_CHANGED" },
};

/** Mirrors node.invoke's GatewayClientRequestError after in-process dispatch. */
function gatewayError({ message, ...fields }: typeof pairingChanged) {
  return Object.assign(new Error(message), { name: "GatewayClientRequestError", ...fields });
}

/** Emulates node.invoke's generation fence; output frames advance the pairing generation. */
function fenceSkillInvocations(changes: number, error: Error) {
  let generation = 0;
  let invocations = 0;
  const transport = createTransport(f.api, f.remote, undefined, () => {
    if (generation < changes) {
      generation += 1;
    }
  });
  f.openDuplex = async (request) => {
    if (request.command !== "workspace.skills") {
      return transport(request);
    }
    invocations += 1;
    const startedGeneration = generation;
    const channel = await transport(request);
    return {
      ...channel,
      closed: channel.closed.finally(() => {
        if (generation !== startedGeneration) {
          throw error;
        }
      }),
    };
  };
  return () => invocations;
}

beforeEach(async () => {
  setRuntimeConfigSnapshot({});
  const parent = await fs.realpath(tempDirs.make("node-workspace-test-"));
  f = await createWorkspaceFixture(parent, true);
  f.nodePolicy.allowWritePaths.push(`${f.remote}/AGENTS.md`);
  await fs.writeFile(path.join(f.local, "AGENTS.md"), "Gateway decoy");
  await fs.writeFile(path.join(f.remote, "AGENTS.md"), "Harness instructions");
  registerNodeWorkspaces(f.api);
});

afterEach(async () => {
  f.scheduler.beginClose();
  try {
    await f.service.stop?.(f.context());
  } finally {
    await f.scheduler.stop();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  }
});

it.each([
  { kind: "recovers from a pairing change", error: pairingChanged, changes: 1, attempts: 2 },
  {
    kind: "rejects repeated pairing changes",
    error: pairingChanged,
    changes: Infinity,
    attempts: 3,
  },
  {
    kind: "rejects a non-retryable Gateway error",
    error: {
      message: "node command denied",
      code: "INVALID_REQUEST",
      retryable: false,
      details: { code: "INVALID_REQUEST" },
    },
    changes: Infinity,
    attempts: 1,
  },
])("Skill discovery $kind", async ({ error, changes, attempts }) => {
  await writeSkill(f.remote, "local-tool");
  const invocations = fenceSkillInvocations(changes, gatewayError(error));
  const access = await f.start();
  const discovery = access.loadSkills!(skillRequest());
  if (changes === 1) {
    expect((await discovery).entries.map((entry) => entry.skill.name)).toContain("local-tool");
  } else {
    await expect(discovery).rejects.toMatchObject({
      message: "Remote workspace skill discovery failed",
      cause: error,
    });
  }
  expect(invocations()).toBe(attempts);
});

it.each(["execution", "symlink", "skill card", "byte limit"])(
  "does not send denied Skill discovery metadata (%s)",
  async (kind) => {
    const { file: deniedFile } = await privateSkill(kind);
    const output = captureOutput();
    const access = await f.start();
    const request = {
      ...skillRequest(),
      executionWorkspaceDir: kind === "execution" ? path.join(f.local, "execution") : undefined,
      status: kind === "skill card" ? { skillCardKey: "private-tool" } : undefined,
    };
    const loadSkills = access.loadSkills!;
    const allowed = await loadSkills(request);
    const entries = kind === "execution" ? allowed.executionEntries : allowed.entries;
    expect(entries.map((entry) => entry.skill.name)).toContain("private-tool");
    if (kind === "skill card") {
      expect(allowed.status?.files[0]?.skillCard?.content).toBe("Private skill card");
    }
    if (kind === "byte limit") {
      f.nodePolicy.maxBytes = 1;
    } else {
      f.nodePolicy.denyPaths = [deniedFile];
    }
    output.length = 0;
    await expect(loadSkills(request)).rejects.toMatchObject({
      message: "Remote workspace skill discovery failed",
      cause: {
        message: expect.stringContaining(
          kind === "byte limit" ? "response exceeds" : "denied by the node file read policy",
        ),
      },
    });
    expect(output).toEqual([]);
  },
);

it("does not send a Skill bundle containing an alias to a denied child", async () => {
  const { directory: skillDir } = await writeSkill(f.remote, "local-tool");
  const privatePath = path.join(skillDir, "private.txt");
  await fs.writeFile(privatePath, "Private bytes");
  await fs.symlink("private.txt", path.join(skillDir, "alias.txt"));
  f.nodePolicy.followSymlinks = true;
  const output = captureOutput();
  const reader = (await f.start()).skillResources!;
  const skill = await reader.resolveExplicitSkill({
    name: "local-tool",
    path: path.join(skillDir, "SKILL.md"),
  });
  const files = await reader.readSkillFiles(skill!, { allowMissingRoot: false });
  expect(files?.some((file) => file.path === "private.txt")).toBe(true);
  f.nodePolicy.denyPaths = [privatePath];
  await expectDenied(
    output,
    () => reader.readSkillFiles(skill!, { allowMissingRoot: false }),
    "denied by the node file read policy",
  );
});

it.each(["explicit Skill", "Memory maintenance"])(
  "rejects raw parent traversal before native %s access",
  async (operation) => {
    const outside = await fs.realpath(tempDirs.make("node-worker-denied-"));
    await fs.mkdir(path.join(outside, "subdir"));
    await fs.symlink(path.join(outside, "subdir"), path.join(f.remote, "link"), "dir");
    const fileName = operation === "explicit Skill" ? "SKILL.md" : "secret.md";
    const allowed = path.join(f.remote, fileName);
    const denied = path.join(outside, fileName);
    const content =
      "---\nname: allowed-tool\ndescription: Allowed metadata\n---\nAllowed instructions.\n";
    await fs.writeFile(allowed, content);
    await fs.writeFile(
      denied,
      content.replaceAll("Allowed", "Private").replace("allowed-tool", "private-tool"),
    );
    f.nodePolicy.followSymlinks = true;
    f.nodePolicy.denyPaths = [denied];
    const output = captureOutput();
    const access = await f.start();
    const read = (filePath: string) =>
      operation === "explicit Skill"
        ? access.skillResources!.resolveExplicitSkill({ name: "allowed-tool", path: filePath })
        : access.memoryFiles!.maintenance!.readFile(filePath);
    expect(await read(allowed)).toBeTruthy();
    await expectDenied(output, () => read(`${f.remote}/link/../${fileName}`), /parent|\.\./);
  },
);

it.each(["whitespace", "home"])(
  "does not list denied Memory extra roots through %s expansion",
  async (kind) => {
    const home = await fs.realpath(tempDirs.make("node-extra-home-"));
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    onTestComplete(() => homeSpy.mockRestore());
    const allowed = path.join(f.remote, "notes");
    const denied = kind === "home" ? path.join(home, "notes") : allowed;
    await fs.mkdir(allowed);
    if (denied !== allowed) {
      await fs.mkdir(denied);
    }
    await fs.writeFile(path.join(denied, "private.md"), "Private memory");
    const output = captureOutput();
    const memory = (await f.start()).memoryFiles!;
    await expect(memory.listFiles(f.local, ["notes"])).resolves.toBeInstanceOf(Array);
    f.nodePolicy.denyPaths = [denied];
    await expectDenied(output, () =>
      memory.listFiles(f.local, [kind === "home" ? "~/notes" : { path: " notes " }]),
    );
  },
);

it("authorizes the trimmed Memory read target before returning any bytes", async () => {
  await fs.mkdir(path.join(f.remote, "memory"));
  const file = path.join(f.remote, "memory", "private.md");
  await fs.writeFile(file, "Private memory");
  const output = captureOutput();
  const memory = (await f.start()).memoryFiles!;
  const request = { workspaceDir: f.local, relPath: "memory/private.md " };
  expect(await memory.readFile(request)).toMatchObject({ text: "Private memory" });
  f.nodePolicy.denyPaths = [file];
  await expectDenied(output, () => memory.readFile(request), /file grant/);
});

it.each(["file", "symlink"])(
  "authorizes the actual explicit Skill instruction %s before returning metadata",
  async (kind) => {
    const { directory: skillDir, file: actual } = await privateSkill(kind);
    const output = captureOutput();
    const reader = (await f.start()).skillResources!;
    const selection = { name: "private-tool", path: path.join(skillDir, "public.txt") };
    if (kind === "file") {
      expect(await reader.resolveExplicitSkill(selection)).toMatchObject({
        name: "private-tool",
      });
    }
    f.nodePolicy.denyPaths = [actual];
    await expectDenied(
      output,
      () => reader.resolveExplicitSkill(selection),
      kind === "file" ? /file grant/ : /resolved location/,
    );
  },
);

it("reads discovered Skill resources when the node root is inside the Gateway path", async () => {
  f.local = path.dirname(f.remote);
  const { instructions } = await writeSkill(f.remote, "overlap-tool");
  f.openDuplex = createTransport(f.api, f.remote);
  const access = await f.start();
  const sources = await access.loadSkills!(skillRequest());
  const skill = sources.entries.find((entry) => entry.skill.name === "overlap-tool")!.skill;
  const reader = access.skillResources!;
  expect(await reader.readInstructions(skill.filePath, {})).toBe(instructions);
  expect(
    await reader.resolveExplicitSkill({ name: skill.name, path: skill.filePath }),
  ).toMatchObject({ filePath: skill.filePath });
  expect(await reader.readSkillFiles(skill, { allowMissingRoot: false })).toContainEqual(
    expect.objectContaining({ path: "SKILL.md" }),
  );
});

it("reads and maintains Harness Memory through the shared client and native worker", async () => {
  vi.stubEnv("HOME", tempDirs.make("node-memory-home-"));
  await fs.mkdir(path.join(f.remote, "memory"));
  await fs.mkdir(path.join(f.local, "memory"));
  const file = path.join(f.local, "memory", "note.md");
  const remoteFile = path.join(f.remote, "memory", "note.md");
  await fs.writeFile(file, "Gateway decoy");
  await fs.writeFile(remoteFile, "Harness memory");
  f.nodePolicy.allowWritePaths.push(`${f.remote}/memory/**`);
  f.openDuplex = createTransport(f.api, f.remote);
  const memory = (await f.start()).memoryFiles!;
  expect(await memory.listFiles(f.local)).toContain(file);
  expect(await memory.readForIndexing(file)).toMatchObject({ content: "Harness memory" });
  await memory.maintenance!.commitContent({
    filePath: file,
    content: "Updated memory",
    expectedContent: "Harness memory",
    tempPrefix: ".memory-test-",
  });
  expect(await fs.readFile(remoteFile, "utf8")).toBe("Updated memory");
  expect(await fs.readFile(file, "utf8")).toBe("Gateway decoy");
  const controller = new AbortController();
  const changes: string[] = [];
  const watching = memory.watch(
    {
      agentId: "main",
      settings: {
        extraPaths: [],
        multimodal: { enabled: false, modalities: [], maxFileBytes: 1024 },
        sync: { watchDebounceMs: 10 },
      },
    },
    (event) => changes.push(event),
    controller.signal,
  );
  void watching.catch(() => {});
  try {
    await vi.waitFor(
      async () => {
        await fs.writeFile(remoteFile, "New Harness memory");
        expect(changes).toContain("change");
      },
      { timeout: 5_000, interval: 200 },
    );
  } finally {
    controller.abort();
    await watching.catch(() => {});
  }
  f.nodePolicy.allowReadPaths = [`${f.remote}/AGENTS.md`];
  await expect(memory.readForIndexing(file)).rejects.toThrow(/file grant/);
}, 30_000);

it("retries a structured unary size refusal through bounded binary file.fetch", async () => {
  const bytes = Buffer.alloc(32 * 1024 * 1024, 0x6d);
  await fs.writeFile(path.join(f.remote, "output.bin"), bytes);
  await fs.writeFile(path.join(f.local, "output.bin"), "Gateway decoy");
  f.openDuplex = createTransport(f.api, f.remote);
  const duplex = vi.fn(f.openDuplex!);
  f.openDuplex = duplex;
  const media = (await f.start()).outboundMedia!;
  const data = await media.readFile(path.join(f.local, "output.bin"), bytes.length);
  expect(sha256(data)).toBe(sha256(bytes));
  expect(f.invoke.mock.calls[0]?.[0]).toMatchObject({
    command: "file.fetch",
    params: { maxBytes: 16 * 1024 * 1024 },
  });
  expect(duplex).toHaveBeenCalledOnce();
  expect(duplex.mock.calls[0]?.[0]).toMatchObject({
    command: "file.fetch",
    params: { transport: "binary", maxBytes: bytes.length },
  });
  f.nodePolicy.maxBytes = 20 * 1024 * 1024;
  await expect(media.readFile(path.join(f.local, "output.bin"), bytes.length)).rejects.toThrow();
  expect(await fs.readFile(path.join(f.local, "output.bin"), "utf8")).toBe("Gateway decoy");
});

it("keeps unary small reads with a larger budget and never retries policy denial", async () => {
  f.openDuplex = vi.fn();
  const media = (await f.start()).outboundMedia!;
  expect(await media.readFile(path.join(f.local, "AGENTS.md"), 32 * 1024 * 1024)).toEqual(
    Buffer.from("Harness instructions"),
  );
  f.nodePolicy.allowReadPaths = [];
  await expect(media.readFile(path.join(f.local, "AGENTS.md"), 32 * 1024 * 1024)).rejects.toThrow();
  expect(f.openDuplex).not.toHaveBeenCalled();
});

it("preserves structured node refusals for file growth and symlinks", async () => {
  const bridge = (await f.start()).bridge;
  const filePath = path.join(f.local, "AGENTS.md");
  await fs.writeFile(path.join(f.remote, "AGENTS.md"), "x".repeat(33));
  await expect(bridge.readFile({ filePath, maxBytes: 32 })).rejects.toMatchObject({
    code: "FILE_TOO_LARGE",
  });
  await fs.symlink("AGENTS.md", path.join(f.remote, "link.md"));
  await expect(bridge.stat({ filePath: path.join(f.local, "link.md") })).rejects.toMatchObject({
    code: "SYMLINK_REDIRECT",
  });
});

it.each([false, true])("rejects large reads with absent or stopped duplex: %s", async (stop) => {
  await fs.writeFile(path.join(f.remote, "output.bin"), Buffer.alloc(17 * 1024 * 1024));
  if (stop) {
    f.openDuplex = createTransport(f.api, f.remote, () => {
      void f.service.stop?.(f.context());
    });
  }
  const media = (await f.start()).outboundMedia!;
  await expect(media.readFile(path.join(f.local, "output.bin"), 32 * 1024 * 1024)).rejects.toThrow(
    stop ? undefined : "FILE_TOO_LARGE",
  );
});

it.each(["same", "node", "root"])("validates %s mappings for one workspace", async (kind) => {
  f.api.config.plugins!.entries!["file-transfer"]!.config = {
    workspaces: {
      main: { nodeId: "node-1", remoteRoot: f.remote },
      other: {
        nodeId: kind === "node" ? "node-2" : "node-1",
        remoteRoot: kind === "root" ? `${f.remote}/other` : `${f.remote}/.`,
      },
    },
  };
  if (kind === "same") {
    const bridge = (await f.start()).bridge;
    expect(await bridge.readFile({ filePath: "AGENTS.md" })).toEqual(
      Buffer.from("Harness instructions"),
    );
  } else {
    await expect(f.service.start(f.context())).rejects.toThrow(
      "Conflicting node workspace mappings",
    );
    expect(() => getAccess(f.local)).toThrow(/not ready/);
    expect(f.invoke).not.toHaveBeenCalled();
  }
});

it("requires service-owned access instead of borrowing the caller's runtime authority", async () => {
  await expect(f.service.start({ ...f.context(), invokeNode: undefined })).rejects.toThrow(
    "Gateway service node access",
  );
  expect(f.invoke).not.toHaveBeenCalled();
  expect(() => getAccess(f.local)).toThrow(/not ready/);
});
it("reads and writes the Harness workspace through existing policy and commands", async () => {
  expect(() => getAccess(f.local)).toThrow(/not ready/);
  const access = await f.start();
  const filePath = path.join(f.local, "AGENTS.md");
  expect(await access.bridge.readFileWithSource!({ filePath })).toEqual({
    data: Buffer.from("Harness instructions"),
    canonicalPath: path.join(f.remote, "AGENTS.md"),
    workspaceRelativePath: "AGENTS.md",
  });
  expect(await access.bridge.stat({ filePath })).toMatchObject({ type: "file", size: 20 });
  expect(await access.bridge.stat({ filePath: path.join(f.local, "missing") })).toBeNull();
  await expect(access.bridge.readFile({ filePath: "missing" })).rejects.toMatchObject({
    code: "ENOENT",
  });
  await fs.symlink("AGENTS.md", path.join(f.remote, "link.md"));
  expect(await access.bridge.readDirectory!({ filePath: f.local })).toMatchObject([
    {
      name: "AGENTS.md",
      isDirectory: false,
      isFile: true,
      size: 20,
      mtimeMs: expect.any(Number),
    },
    { name: "link.md", isDirectory: false, isFile: false, size: 9 },
  ]);
  await expect(access.bridge.readFile({ filePath: "link.md" })).rejects.toThrow(/SYMLINK/);
  await access.bridge.writeFile({ filePath, data: "Live owner edit" });
  expect(await fs.readFile(path.join(f.remote, "AGENTS.md"), "utf8")).toBe("Live owner edit");
  expect(await fs.readFile(filePath, "utf8")).toBe("Gateway decoy");
});

it("does not turn workspace placement into a broader write grant", async () => {
  const bridge = (await f.start()).bridge;
  await expect(bridge.writeFile({ filePath: "project.txt", data: "denied" })).rejects.toThrow();
  expect(await fs.readdir(f.remote)).toEqual(["AGENTS.md"]);
  f.invoke.mockClear();
  await expect(bridge.readFile({ filePath: "../outside" })).rejects.toThrow(/outside/);
  expect(f.invoke).not.toHaveBeenCalled();
});

it("lists a workspace directory across node result pages", async () => {
  for (let start = 0; start < 4100; start += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, offset) =>
        fs.writeFile(path.join(f.remote, `${String(start + offset).padStart(4, "0")}.txt`), ""),
      ),
    );
  }
  const bridge = (await f.start()).bridge;
  const entries = await bridge.readDirectory!({ filePath: "." });
  expect(entries).toHaveLength(4101);
  expect(new Set(entries.map((entry) => entry.name))).toEqual(new Set(await fs.readdir(f.remote)));
});

it("rejects a directory continuation that makes no progress", async () => {
  const bridge = (await f.start()).bridge;
  f.invoke.mockResolvedValue({
    payload: { ok: true, path: f.remote, entries: [], truncated: true, nextPageToken: "0" },
  });
  await expect(bridge.readDirectory!({ filePath: "." })).rejects.toThrow(
    "Invalid dir.list continuation",
  );
});

it("preserves bootstrap reads through in-workspace parent aliases", async () => {
  const nested = path.join(f.remote, "nested");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "MEMORY.md"), "Nested memory");
  await fs.symlink(nested, path.join(f.remote, "alias"), "dir");
  f.nodePolicy.followSymlinks = true;
  const bridge = (await f.start()).bridge;
  expect(await bridge.readFileWithSource!({ filePath: "alias/MEMORY.md" })).toEqual({
    data: Buffer.from("Nested memory"),
    canonicalPath: path.join(nested, "MEMORY.md"),
    workspaceRelativePath: "nested/MEMORY.md",
  });
  await fs.symlink(f.remote, path.join(f.remote, "root-alias"), "dir");
  expect(await bridge.readFileWithSource!({ filePath: "root-alias/AGENTS.md" })).toMatchObject({
    canonicalPath: path.join(f.remote, "AGENTS.md"),
    workspaceRelativePath: "AGENTS.md",
  });
  // Ordinary document access keeps its stricter no-alias behavior.
  await expect(bridge.readFile({ filePath: "alias/MEMORY.md" })).rejects.toThrow();
});

it.each(["outside", "leaf", "policy"])(
  "does not expand bootstrap reads through a %s alias",
  async (kind) => {
    f.nodePolicy.followSymlinks = kind !== "policy";
    const outside = await fs.realpath(tempDirs.make("node-workspace-read-outside-"));
    await fs.writeFile(path.join(outside, "AGENTS.md"), "Outside instructions");
    // Even a broader node grant must not let the workspace reader escape.
    f.nodePolicy.allowReadPaths.push(`${outside}/**`);
    const target = kind === "outside" ? outside : f.remote;
    const alias = path.join(f.remote, "alias");
    const filePath = kind === "leaf" ? "alias" : "alias/AGENTS.md";
    await fs.symlink(kind === "leaf" ? path.join(f.remote, "AGENTS.md") : target, alias);
    const bridge = (await f.start()).bridge;
    await expect(bridge.readFileWithSource!({ filePath })).rejects.toThrow();
  },
);

it("rejects owner document writes through a hard link outside the workspace", async () => {
  const outside = path.join(path.dirname(f.remote), "outside.md");
  await fs.link(path.join(f.remote, "AGENTS.md"), outside);
  const bridge = (await f.start()).bridge;
  await expect(bridge.writeFile({ filePath: "AGENTS.md", data: "Must not write" })).rejects.toThrow(
    "HARDLINK_TARGET_DENIED",
  );
  expect(await fs.readFile(outside, "utf8")).toBe("Harness instructions");
  expect(await fs.readFile(path.join(f.remote, "AGENTS.md"), "utf8")).toBe("Harness instructions");
});

it.each(["parent", "root"])(
  "rejects a symlinked %s before writing outside the workspace",
  async (kind) => {
    const outside = await fs.realpath(tempDirs.make("node-workspace-outside-"));
    const target = path.join(outside, "AGENTS.md");
    await fs.writeFile(target, "Outside instructions");
    f.nodePolicy.followSymlinks = true;
    f.nodePolicy.allowWritePaths = [`${f.remote}/**`, `${outside}/**`];
    let filePath = "redirect/AGENTS.md";
    if (kind === "root") {
      await fs.rename(f.remote, `${f.remote}-original`);
      await fs.symlink(outside, f.remote);
      filePath = "AGENTS.md";
    } else {
      await fs.symlink(outside, path.join(f.remote, "redirect"));
    }
    const bridge = (await f.start()).bridge;
    await expect(bridge.writeFile({ filePath, data: "Must not write" })).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("Outside instructions");
  },
);

it("returns no local fallback after service shutdown", async () => {
  const bridge = (await f.start()).bridge;
  await f.service.stop?.(f.context());
  f.invoke.mockClear();
  await expect(bridge.readFile({ filePath: "AGENTS.md" })).rejects.toThrow(/stopped/);
  expect(() => getAccess(f.local)).toThrow(/not ready/);
  expect(f.invoke).not.toHaveBeenCalled();
});

it("cancels an in-flight request when the service stops", async () => {
  const bridge = (await f.start()).bridge;
  const response = createDeferred<unknown>();
  f.invoke.mockImplementationOnce(async () => response.promise);
  const pending = bridge.readFile({ filePath: "AGENTS.md" });
  const signal = f.invoke.mock.calls[0]?.[0]?.signal;
  await f.service.stop?.(f.context());
  expect(signal?.aborted).toBe(true);
  response.resolve({ payload: {} });
  await expect(pending).rejects.toThrow(/stopped/);
});

async function attachmentInput(sizeMiB: number) {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(f.local, "state"));
  const bytes = Buffer.alloc(sizeMiB * 1024 * 1024, 0x6d);
  const saved = await saveMediaBuffer(
    bytes,
    "application/octet-stream",
    "inbound",
    bytes.length,
    "report.bin",
  );
  expect(saved.path.startsWith(f.local + path.sep)).toBe(true);
  const inputDirectory = `media/inbound/openclaw-staged-${sha256(Buffer.from(saved.path))}`;
  const target = path.join(f.remote, inputDirectory, `input-${path.basename(saved.path)}`);
  f.nodePolicy.allowReadPaths = [
    `${f.remote}/AGENTS.md`,
    `${f.remote}/media/inbound/openclaw-staged-*`,
    `${f.remote}/media/inbound/openclaw-staged-*/**`,
  ];
  f.nodePolicy.allowWritePaths.push(`${f.remote}/media/inbound/openclaw-staged-*/**`);
  return { bytes, target, turn: { media: [{ path: saved.path }], timeoutMs: 60_000 } };
}

it("transfers 17 MiB through registered access and retains Harness edits", async () => {
  const input = await attachmentInput(17);
  f.openDuplex = createTransport(f.api, f.remote);
  await f.service.start(f.context());
  const params = { workspaceDir: f.local, turn: input.turn, assertCurrent: () => {} };
  const original = JSON.stringify(input.turn);
  const note = await prepareAttachments(params);
  expect(note).toBe(`[media attached: ${input.target}]`);
  expect(sha256(await fs.readFile(input.target))).toBe(sha256(input.bytes));
  expect(JSON.stringify(input.turn)).toBe(original);
  expect(await fs.readFile(path.join(f.local, "AGENTS.md"), "utf8")).toBe("Gateway decoy");
  await expectMissing(path.join(f.local, "media"));
  await fs.writeFile(input.target, "Harness edit");
  expect(await prepareAttachments(params)).toBe(note);
  expect(await fs.readFile(input.target, "utf8")).toBe("Harness edit");
});

it("requires explicit input-path permission without widening owner document writes", async () => {
  const input = await attachmentInput(1);
  f.nodePolicy.allowWritePaths = [`${f.remote}/AGENTS.md`];
  f.openDuplex = createTransport(f.api, f.remote);
  await f.service.start(f.context());
  await expect(
    prepareAttachments({
      workspaceDir: f.local,
      turn: input.turn,
      assertCurrent: () => {},
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(f.remote)).toEqual(["AGENTS.md"]);
});

it("revokes a turn during transfer without publishing partial input", async () => {
  const input = await attachmentInput(17);
  let current = true;
  f.openDuplex = createTransport(f.api, f.remote, () => {
    current = false;
  });
  await f.service.start(f.context());
  await expect(
    prepareAttachments({
      workspaceDir: f.local,
      turn: input.turn,
      assertCurrent() {
        if (!current) {
          throw new Error("turn ended");
        }
      },
    }),
  ).rejects.toThrow("turn ended");
  await expectMissing(input.target);
});
