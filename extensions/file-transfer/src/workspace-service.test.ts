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
import { afterEach, assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

const local = (...parts: string[]) => path.join(f.local, ...parts);
const remote = (...parts: string[]) => path.join(f.remote, ...parts);
const textFile = (file: string) => fs.readFile(file, "utf8");
async function put(file: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
async function startStream() {
  f.openDuplex = createTransport(f.api, f.remote);
  return f.start();
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function writeSkill(root: string, name: string, file = "SKILL.md") {
  const directory = path.join(root, "skills", name);
  const instructions = `---\nname: ${name}\ndescription: Test resources\n---\nUse supporting files.\n`;
  await put(path.join(directory, file), instructions);
  return { directory, instructions };
}

async function privateSkill(kind: string) {
  const root = kind === "execution" ? remote("execution") : f.remote;
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

/** Complete real dispatch, then emulate node.invoke's pairing-generation refusal. */
function fenceSkillInvocations(changes: number, error: Error) {
  let invocations = 0;
  const transport = createTransport(f.api, f.remote);
  f.openDuplex = async (request) => {
    const channel = await transport(request);
    if (request.command !== "workspace.skills") {
      return channel;
    }
    const attempt = ++invocations;
    return {
      ...channel,
      closed: channel.closed.then((result) => {
        if (attempt <= changes) {
          throw error;
        }
        return result;
      }),
    };
  };
  return () => invocations;
}

async function setupWorkspace(unary: boolean) {
  f = await createWorkspaceFixture(await fs.realpath(tempDirs.make("node-workspace-")), unary);
}
afterEach(async () => {
  f.scheduler.beginClose();
  try {
    await f.service.stop?.(f.context());
  } finally {
    try {
      await f.scheduler.stop();
    } finally {
      clearRuntimeConfigSnapshot();
      vi.unstubAllEnvs();
    }
  }
});

describe("workspace service", () => {
  beforeEach(async () => {
    setRuntimeConfigSnapshot({});
    await setupWorkspace(true);
    f.nodePolicy.allowWritePaths.push(`${f.remote}/AGENTS.md`);
    await put(local("AGENTS.md"), "Gateway decoy");
    await put(remote("AGENTS.md"), "Harness instructions");
    registerNodeWorkspaces(f.api);
  });

  it.each([
    [1, 2, true],
    [Infinity, 3, true],
    [Infinity, 1, false],
  ] as const)(
    "bounds retries for %s changes (%s attempts, retryable=%s)",
    async (changes, attempts, retryable) => {
      const fields = {
        code: retryable ? "UNAVAILABLE" : "INVALID_REQUEST",
        retryable,
        details: { code: retryable ? "PAIRING_CHANGED" : "INVALID_REQUEST" },
      };
      const message = retryable
        ? "node pairing changed while invocation was active"
        : "node command denied";
      const error = Object.assign(new Error(message), {
        name: "GatewayClientRequestError",
        ...fields,
      });
      await writeSkill(f.remote, "local-tool");
      const invocations = fenceSkillInvocations(changes, error);
      const access = await f.start();
      const discovery = access.loadSkills!(skillRequest());
      if (changes === 1) {
        expect((await discovery).entries.map((entry) => entry.skill.name)).toContain("local-tool");
      } else {
        await expect(discovery).rejects.toMatchObject({
          message: "Remote workspace skill discovery failed",
          cause: { message, ...fields },
        });
      }
      expect(invocations()).toBe(attempts);
    },
  );

  it.each(["execution", "symlink", "skill card", "byte limit"])(
    "denies %s Skill metadata without output",
    async (kind) => {
      const { file: deniedFile } = await privateSkill(kind);
      const output = captureOutput();
      const access = await f.start();
      const request = {
        ...skillRequest(),
        executionWorkspaceDir: kind === "execution" ? local("execution") : undefined,
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

  it.each(["explicit Skill", "Memory maintenance"])(
    "rejects raw traversal for %s",
    async (operation) => {
      const outside = await fs.realpath(tempDirs.make("node-worker-denied-"));
      await fs.mkdir(path.join(outside, "subdir"));
      await fs.symlink(path.join(outside, "subdir"), remote("link"), "dir");
      const fileName = operation === "explicit Skill" ? "SKILL.md" : "secret.md";
      const allowed = remote(fileName);
      const denied = path.join(outside, fileName);
      const content =
        "---\nname: allowed-tool\ndescription: Allowed metadata\n---\nAllowed instructions.\n";
      await fs.writeFile(allowed, content);
      await put(
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

  it.each(["whitespace", "home"])("denies Memory roots after %s expansion", async (kind) => {
    const home = await fs.realpath(tempDirs.make("node-extra-home-"));
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    onTestFinished(() => homeSpy.mockRestore());
    const allowed = remote("notes");
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
  });

  it.each(["file", "symlink"])("authorizes explicit Skill instructions (%s)", async (kind) => {
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
  });

  it("reads overlapping-root Skills and denies aliased private resources", async () => {
    f.local = path.dirname(f.remote);
    const { directory, instructions } = await writeSkill(f.remote, "overlap-tool");
    const privatePath = path.join(directory, "private.txt");
    await fs.writeFile(privatePath, "Private bytes");
    await fs.symlink("private.txt", path.join(directory, "alias.txt"));
    f.nodePolicy.followSymlinks = true;
    const output = captureOutput();
    const access = await f.start();
    const sources = await access.loadSkills!(skillRequest());
    const skill = sources.entries.find((entry) => entry.skill.name === "overlap-tool")!.skill;
    const reader = access.skillResources!;
    expect(await reader.readInstructions(skill.filePath, {})).toBe(instructions);
    const explicit = await reader.resolveExplicitSkill({ name: skill.name, path: skill.filePath });
    expect(explicit).toMatchObject({ filePath: skill.filePath });
    expect(await reader.readSkillFiles(skill, { allowMissingRoot: false })).toContainEqual(
      expect.objectContaining({ path: "SKILL.md" }),
    );
    const readFiles = () => reader.readSkillFiles(explicit!, { allowMissingRoot: false });
    expect((await readFiles())?.some((file) => file.path === "private.txt")).toBe(true);
    f.nodePolicy.denyPaths = [privatePath];
    await expectDenied(output, readFiles, "denied by the node file read policy");
  });

  it("reads, maintains and watches remote Memory", async () => {
    vi.stubEnv("HOME", tempDirs.make("node-memory-home-"));
    const file = local("memory", "note.md");
    const remoteFile = remote("memory", "note.md");
    await put(file, "Gateway decoy");
    await put(remoteFile, "Harness memory");
    f.nodePolicy.allowWritePaths.push(`${f.remote}/memory/**`);
    const output = captureOutput();
    const memory = (await f.start()).memoryFiles!;
    const request = { workspaceDir: f.local, relPath: "memory/note.md " };
    expect(await memory.readFile(request)).toMatchObject({ text: "Harness memory" });
    expect(await memory.listFiles(f.local)).toContain(file);
    expect(await memory.readForIndexing(file)).toMatchObject({ content: "Harness memory" });
    await memory.maintenance!.commitContent({
      filePath: file,
      content: "Updated memory",
      expectedContent: "Harness memory",
      tempPrefix: ".memory-test-",
    });
    expect(await textFile(remoteFile)).toBe("Updated memory");
    expect(await textFile(file)).toBe("Gateway decoy");
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
    await expectDenied(output, () => memory.readFile(request), /file grant/);
  }, 30_000);

  it("falls back to binary reads only for unary size refusal", async () => {
    const bytes = Buffer.alloc(32 * 1024 * 1024, 0x6d);
    await fs.writeFile(remote("output.bin"), bytes);
    await fs.writeFile(local("output.bin"), "Gateway decoy");
    f.openDuplex = createTransport(f.api, f.remote);
    const media = (await f.start()).outboundMedia!;
    const data = await media.readFile(local("output.bin"), bytes.length);
    expect(sha256(data)).toBe(sha256(bytes));
    f.nodePolicy.maxBytes = 20 * 1024 * 1024;
    await expect(media.readFile(local("output.bin"), bytes.length)).rejects.toThrow();
    expect(await textFile(local("output.bin"))).toBe("Gateway decoy");
  });

  it("keeps small reads and policy refusals unary", async () => {
    f.openDuplex = vi.fn();
    const media = (await f.start()).outboundMedia!;
    expect(await media.readFile(local("AGENTS.md"), 32 * 1024 * 1024)).toEqual(
      Buffer.from("Harness instructions"),
    );
    f.nodePolicy.allowReadPaths = [];
    await expect(media.readFile(local("AGENTS.md"), 32 * 1024 * 1024)).rejects.toThrow();
    expect(f.openDuplex).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects large reads without live duplex (%s)", async (stop) => {
    await fs.writeFile(remote("output.bin"), Buffer.alloc(17 * 1024 * 1024));
    if (stop) {
      f.openDuplex = createTransport(f.api, f.remote, () => {
        void f.service.stop?.(f.context());
      });
    }
    const media = (await f.start()).outboundMedia!;
    await expect(media.readFile(local("output.bin"), 32 * 1024 * 1024)).rejects.toThrow(
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

  it("requires service-owned node authority", async () => {
    await expect(f.service.start({ ...f.context(), invokeNode: undefined })).rejects.toThrow(
      "Gateway service node access",
    );
    expect(f.invoke).not.toHaveBeenCalled();
    expect(() => getAccess(f.local)).toThrow(/not ready/);
  });
  it("reads and writes the remote workspace under policy", async () => {
    expect(() => getAccess(f.local)).toThrow(/not ready/);
    const access = await f.start();
    const bridge = access.bridge;
    await expect(bridge.writeFile({ filePath: "project.txt", data: "denied" })).rejects.toThrow();
    expect(await fs.readdir(f.remote)).toEqual(["AGENTS.md"]);
    f.invoke.mockClear();
    await expect(bridge.readFile({ filePath: "../outside" })).rejects.toThrow(/outside/);
    expect(f.invoke).not.toHaveBeenCalled();
    const filePath = local("AGENTS.md");
    expect(await bridge.readFileWithSource!({ filePath })).toEqual({
      data: Buffer.from("Harness instructions"),
      canonicalPath: remote("AGENTS.md"),
      workspaceRelativePath: "AGENTS.md",
    });
    expect(await bridge.stat({ filePath })).toMatchObject({ type: "file", size: 20 });
    expect(await bridge.stat({ filePath: local("missing") })).toBeNull();
    await expect(bridge.readFile({ filePath: "missing" })).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.symlink("AGENTS.md", remote("link.md"));
    await expect(bridge.stat({ filePath: local("link.md") })).rejects.toMatchObject({
      code: "SYMLINK_REDIRECT",
    });
    expect(await bridge.readDirectory!({ filePath: f.local })).toMatchObject([
      {
        name: "AGENTS.md",
        isDirectory: false,
        isFile: true,
        size: 20,
        mtimeMs: expect.any(Number),
      },
      { name: "link.md", isDirectory: false, isFile: false, size: 9 },
    ]);
    await expect(bridge.readFile({ filePath: "link.md" })).rejects.toThrow(/SYMLINK/);
    await bridge.writeFile({ filePath, data: "Live owner edit" });
    expect(await textFile(remote("AGENTS.md"))).toBe("Live owner edit");
    expect(await textFile(filePath)).toBe("Gateway decoy");
    await fs.writeFile(remote("AGENTS.md"), "x".repeat(33));
    await expect(bridge.readFile({ filePath, maxBytes: 32 })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("paginates directory listings and rejects non-progressing pages", async () => {
    for (let start = 0; start < 4100; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          fs.writeFile(remote(`${String(start + offset).padStart(4, "0")}.txt`), ""),
        ),
      );
    }
    const bridge = (await f.start()).bridge;
    const entries = await bridge.readDirectory!({ filePath: "." });
    expect(entries).toHaveLength(4101);
    expect(new Set(entries.map((entry) => entry.name))).toEqual(
      new Set(await fs.readdir(f.remote)),
    );
    f.invoke.mockResolvedValue({
      payload: { ok: true, path: f.remote, entries: [], truncated: true, nextPageToken: "0" },
    });
    await expect(bridge.readDirectory!({ filePath: "." })).rejects.toThrow(
      "Invalid dir.list continuation",
    );
  });

  it("resolves in-workspace bootstrap aliases", async () => {
    const nested = remote("nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "MEMORY.md"), "Nested memory");
    await fs.symlink(nested, remote("alias"), "dir");
    f.nodePolicy.followSymlinks = true;
    const bridge = (await f.start()).bridge;
    expect(await bridge.readFileWithSource!({ filePath: "alias/MEMORY.md" })).toEqual({
      data: Buffer.from("Nested memory"),
      canonicalPath: path.join(nested, "MEMORY.md"),
      workspaceRelativePath: "nested/MEMORY.md",
    });
    await fs.symlink(f.remote, remote("root-alias"), "dir");
    expect(await bridge.readFileWithSource!({ filePath: "root-alias/AGENTS.md" })).toMatchObject({
      canonicalPath: remote("AGENTS.md"),
      workspaceRelativePath: "AGENTS.md",
    });
    // Ordinary document access keeps its stricter no-alias behavior.
    await expect(bridge.readFile({ filePath: "alias/MEMORY.md" })).rejects.toThrow();
  });

  it.each(["outside", "leaf", "policy"])("rejects unsafe %s bootstrap aliases", async (kind) => {
    f.nodePolicy.followSymlinks = kind !== "policy";
    const outside = await fs.realpath(tempDirs.make("node-workspace-read-outside-"));
    await fs.writeFile(path.join(outside, "AGENTS.md"), "Outside instructions");
    // Even a broader node grant must not let the workspace reader escape.
    f.nodePolicy.allowReadPaths.push(`${outside}/**`);
    const target = kind === "outside" ? outside : f.remote;
    const alias = remote("alias");
    const filePath = kind === "leaf" ? "alias" : "alias/AGENTS.md";
    await fs.symlink(kind === "leaf" ? remote("AGENTS.md") : target, alias);
    const bridge = (await f.start()).bridge;
    await expect(bridge.readFileWithSource!({ filePath })).rejects.toThrow();
  });

  it("rejects external hardlinks on owner writes", async () => {
    const outside = path.join(path.dirname(f.remote), "outside.md");
    await fs.link(remote("AGENTS.md"), outside);
    const bridge = (await f.start()).bridge;
    await expect(
      bridge.writeFile({ filePath: "AGENTS.md", data: "Must not write" }),
    ).rejects.toThrow("HARDLINK_TARGET_DENIED");
    expect(await textFile(outside)).toBe("Harness instructions");
    expect(await textFile(remote("AGENTS.md"))).toBe("Harness instructions");
  });

  it.each(["parent", "root"])("rejects external writes through %s symlinks", async (kind) => {
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
      await fs.symlink(outside, remote("redirect"));
    }
    const bridge = (await f.start()).bridge;
    await expect(bridge.writeFile({ filePath, data: "Must not write" })).rejects.toThrow();
    expect(await textFile(target)).toBe("Outside instructions");
  });

  it("stops pending and new reads without local fallback", async () => {
    const bridge = (await f.start()).bridge;
    const response = createDeferred<unknown>();
    f.invoke.mockImplementationOnce(async () => response.promise);
    const pending = bridge.readFile({ filePath: "AGENTS.md" });
    const signal = f.invoke.mock.calls[0]?.[0]?.signal;
    await f.service.stop?.(f.context());
    expect(signal?.aborted).toBe(true);
    response.resolve({ payload: {} });
    await expect(pending).rejects.toThrow(/stopped/);
    f.invoke.mockClear();
    await expect(bridge.readFile({ filePath: "AGENTS.md" })).rejects.toThrow(/stopped/);
    expect(() => getAccess(f.local)).toThrow(/not ready/);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  async function attachmentInput(sizeMiB: number) {
    vi.stubEnv("OPENCLAW_STATE_DIR", local("state"));
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
    const target = remote(inputDirectory, `input-${path.basename(saved.path)}`);
    f.nodePolicy.allowReadPaths = [
      `${f.remote}/AGENTS.md`,
      `${f.remote}/media/inbound/openclaw-staged-*`,
      `${f.remote}/media/inbound/openclaw-staged-*/**`,
    ];
    f.nodePolicy.allowWritePaths.push(`${f.remote}/media/inbound/openclaw-staged-*/**`);
    return {
      bytes,
      target,
      params: {
        workspaceDir: f.local,
        turn: { media: [{ path: saved.path }], timeoutMs: 60_000 },
        assertCurrent: () => {},
      },
    };
  }

  it("stages large attachments without overwriting remote edits", async () => {
    const input = await attachmentInput(17);
    await startStream();
    const { params } = input;
    const original = JSON.stringify(params.turn);
    const note = await prepareAttachments(params);
    expect(note).toBe(`[media attached: ${input.target}]`);
    expect(sha256(await fs.readFile(input.target))).toBe(sha256(input.bytes));
    expect(JSON.stringify(params.turn)).toBe(original);
    expect(await textFile(local("AGENTS.md"))).toBe("Gateway decoy");
    await expectMissing(local("media"));
    await fs.writeFile(input.target, "Harness edit");
    expect(await prepareAttachments(params)).toBe(note);
    expect(await textFile(input.target)).toBe("Harness edit");
  });

  it("requires explicit attachment write grants", async () => {
    const input = await attachmentInput(1);
    f.nodePolicy.allowWritePaths = [`${f.remote}/AGENTS.md`];
    await startStream();
    await expect(prepareAttachments(input.params)).rejects.toThrow();
    expect(await fs.readdir(f.remote)).toEqual(["AGENTS.md"]);
  });

  it("revokes attachment uploads without partial publication", async () => {
    const input = await attachmentInput(17);
    let current = true;
    f.openDuplex = createTransport(f.api, f.remote, () => {
      current = false;
    });
    await f.service.start(f.context());
    await expect(
      prepareAttachments({
        ...input.params,
        assertCurrent() {
          if (!current) {
            throw new Error("turn ended");
          }
        },
      }),
    ).rejects.toThrow("turn ended");
    await expectMissing(input.target);
  });
});

describe("workspace Skill lifecycle", () => {
  const slug = "lifecycle-proof";
  function assertCurrent(current: boolean, message: string) {
    if (!current) {
      throw new Error(message);
    }
  }
  beforeEach(async () => {
    await setupWorkspace(false);
    f.nodePolicy.allowWritePaths.push(
      `${f.remote}/skills`,
      `${f.remote}/skills/**`,
      `${f.remote}/.openclaw/skill-installs/**`,
    );
    setRuntimeConfigSnapshot(f.api.config);
    registerNodeWorkspaces(f.api);
  });

  it("installs, tracks, updates and removes paired-host Skills", async () => {
    f.nodePolicy.allowWritePaths.push(`${f.remote}/.clawhub/**`, `${f.remote}/.clawdhub/**`);
    let publicationsBeforeRevocation = 0;
    let current = true;
    f.openDuplex = createTransport(f.api, f.remote, undefined, (bytes) => {
      if (
        publicationsBeforeRevocation > 0 &&
        Buffer.from(bytes).toString("utf8").includes('"phase":"apply"') &&
        --publicationsBeforeRevocation === 0
      ) {
        current = false;
      }
    });
    const access = await f.start();
    const apply = access.applySkillRoot!;
    const tracking = access.clawHubSkills!;
    const identity = { workspaceDir: f.local, slug };
    const targetDir = remote("skills", slug);
    const skillFile = path.join(targetDir, "SKILL.md");
    const source = local("download");
    const skill = (version: string) =>
      `---\nname: lifecycle-proof\ndescription: Skill lifecycle proof\n---\nPrint ${version}.\n`;
    await put(path.join(source, "SKILL.md"), skill("v1"));
    await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\necho lifecycle-proof\n", {
      mode: 0o755,
    });
    const install = {
      ...identity,
      extractedRoot: source,
      mode: "install" as const,
    };
    // The real worker reaches publication only after the Gateway answers this checkpoint.
    const denied = await apply({
      ...install,
      beforeInstall: async () => ({
        error: "Policy denies this source",
        failureKind: "invalid-request",
      }),
    });
    expect(denied).toMatchObject({ ok: false, error: "Policy denies this source" });
    await expectMissing(targetDir);
    const approved = vi.fn(async () => undefined);
    const installed = await apply({ ...install, beforeInstall: approved });
    expect(installed).toMatchObject({ ok: true, mode: "install", targetDir });
    expect(approved).toHaveBeenCalledWith("install");
    expect((await fs.stat(path.join(targetDir, "run.sh"))).mode & 0o111).toBe(0o111);
    await access.recordSkillSourceInstall!({
      workspaceDir: f.local,
      targetDir,
      origin: { version: 1, source: "path", spec: source, slug, installedAt: 1 },
    });
    expect(
      JSON.parse(await textFile(path.join(targetDir, ".openclaw/source-origin.json"))),
    ).toMatchObject({ slug });
    // ClawHub metadata lives with the real workspace and drives native update/removal guards.
    const record = async (version: string) => {
      const files = await tracking.readInstalledClawHubSkillFiles({ skillDir: targetDir });
      await tracking.recordClawHubSkillInstall({
        workspaceDir: f.local,
        skillDir: targetDir,
        origin: {
          version: 1,
          slug,
          registry: "https://example.test",
          installedVersion: version,
          installedAt: 1,
          ...files,
        },
      });
    };
    await record("1.0.0");
    const verify = () => tracking.resolveClawHubSkillVerificationTarget(identity);
    f.nodePolicy.denyPaths = [targetDir];
    await expect(verify()).rejects.toThrow("POLICY_DENIED");
    delete f.nodePolicy.denyPaths;
    const moved = `${targetDir}-moved`;
    await fs.rename(targetDir, moved);
    await fs.symlink(moved, targetDir);
    await expect(verify()).rejects.toThrow("resolved location");
    await fs.unlink(targetDir);
    await fs.rename(moved, targetDir);

    expect((await tracking.readClawHubSkillsLockfile(f.local)).skills[slug]?.version).toBe("1.0.0");
    expect(
      (await access.loadSkills!(workspaceSkillRequest(f.local))).entries.some(
        (entry) => entry.skill.name === slug,
      ),
    ).toBe(true);
    await expectMissing(local("skills", slug));
    const guardRequest = { ...identity, previousVersion: "1.0.0" };
    await fs.writeFile(skillFile, skill("owner edit"));
    expect(await tracking.guardTrackedSkillLocalState(guardRequest)).toMatchObject({ ok: false });
    await fs.writeFile(skillFile, skill("v1"));
    const guard = await tracking.guardTrackedSkillLocalState(guardRequest);
    assert(guard.ok, JSON.stringify(guard));
    await fs.writeFile(path.join(source, "SKILL.md"), skill("v2"));
    // Revoke after the old target has moved to backup, before publishing its replacement.
    // Native rollback must preserve the old Skill even though the initial policy check passed.
    publicationsBeforeRevocation = 2;
    const update = {
      ...install,
      mode: "update" as const,
      expectedClawHubState: guard.plan,
      beforeInstall: approved,
    };
    expect(
      await apply({
        ...update,
        beforePersistentApply: () => assertCurrent(current, "upload permission revoked"),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("upload permission revoked") });
    expect(await textFile(skillFile)).toBe(skill("v1"));
    current = true;
    expect(await apply(update)).toMatchObject({ ok: true, mode: "update" });
    await record("2.0.0");
    expect(await textFile(skillFile)).toBe(skill("v2"));
    const removal = await tracking.planClawHubSkillUninstall({
      ...identity,
      expectedVersion: "2.0.0",
    });
    assert(removal.ok, JSON.stringify(removal));
    const authorize = vi.fn();
    const changed = vi.fn(async () => {});
    expect(
      await tracking.applyClawHubSkillUninstall(removal.plan, {
        beforePersistentApply: authorize,
        onCommittedChange: changed,
      }),
    ).toEqual({ ok: true });
    expect(authorize).toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: f.local, action: "removed" }),
    );
    await expectMissing(targetDir);
    expect((await tracking.readClawHubSkillsLockfile(f.local)).skills).toEqual({});
    expect(await fs.readdir(remote(".openclaw/skill-installs"))).toEqual([]);
  });

  it("retires uploads revoked before installation", async () => {
    let current = true;
    let operationClosed: Promise<unknown> | undefined;
    const transport = createTransport(f.api, f.remote);
    f.openDuplex = async (request) => {
      const channel = await transport(request);
      if (request.command === "workspace.skills") {
        operationClosed = channel.closed.catch(() => {});
      }
      return request.command === "file.create"
        ? {
            ...channel,
            closed: channel.closed.then((result) => {
              current = false;
              return result;
            }),
          }
        : channel;
    };
    const access = await f.start();
    const source = local("download");
    await put(path.join(source, "SKILL.md"), "---\nname: interrupted\n---\nDo nothing.\n");
    await expect(
      access.applySkillRoot!({
        workspaceDir: f.local,
        extractedRoot: source,
        slug: "interrupted",
        mode: "install",
        beforePersistentApply: () => assertCurrent(current, "install authority ended"),
      }),
    ).rejects.toThrow("install authority ended");
    await operationClosed;
    expect(await fs.readdir(remote(".openclaw/skill-installs"))).toEqual([]);
    await expectMissing(remote("skills/interrupted"));
  });
});
