import fs from "node:fs/promises";
import path from "node:path";
import * as mediaMime from "@openclaw/media-core/mime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  createStagedInputOwnershipFixture,
  useAutoCleanupTempDirTracker,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsApiClient, type AgentsApiArtifact } from "./agentsapi-client.js";
import { collectOutputs, prepareInputs } from "./agentsapi-files.js";

const { guardedFetch } = vi.hoisted(() => ({
  guardedFetch: vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fileLimit = 5 * 1024 * 1024;
let stateDir: string;
let workspaceDir: string;
let signal: AbortSignal;

beforeEach(async () => {
  const directory = tempDirs.make("agentsapi-files-");
  stateDir = path.join(directory, "state");
  workspaceDir = path.join(directory, "workspace");
  await fs.mkdir(workspaceDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  signal = new AbortController().signal;
});

afterEach(() => {
  vi.unstubAllEnvs();
  guardedFetch.mockReset();
  vi.restoreAllMocks();
});

describe("Agents API input attachment custody", () => {
  it("copies managed bytes and keeps untrusted names inside an escaped attachment mapping", async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    const inbound = await saveMediaBuffer(bytes, undefined, "inbound");
    const outbound = await saveMediaBuffer(Buffer.from("previous output"), undefined, "outbound");
    const name = '../../deliver\n"escape".bin';

    const prepared = await prepareInputs(
      [
        { url: `media://inbound/${inbound.id}`, fileName: name },
        { path: outbound.path, fileName: "previous.txt" },
      ],
      workspaceDir,
      () => {},
      signal,
    );

    expect(prepared.files).toHaveLength(2);
    expect(Buffer.from(prepared.files[0]!.data, "base64")).toEqual(bytes);
    expect(Buffer.from(prepared.files[1]!.data, "base64").toString()).toBe("previous output");
    expect(path.posix.dirname(prepared.files[0]!.path)).toBe("/workspace/inputs");
    expect(path.posix.basename(prepared.files[0]!.path)).toMatch(
      /^[a-zA-Z0-9._-]+-deliver__escape_\.bin$/u,
    );
    expect(prepared.mappingText.split("\n")).toHaveLength(3);
    expect(JSON.parse(prepared.mappingText.split("\n")[1]!)).toEqual([
      { attachment: 1, name, path: prepared.files[0]!.path },
      { attachment: 2, name: "previous.txt", path: prepared.files[1]!.path },
    ]);
  });

  it("reads staged bytes only from a directory established by the staging owner", async () => {
    const fixture = await createStagedInputOwnershipFixture(workspaceDir);
    const stagedPath = path.join(workspaceDir, fixture.ownedFiles[0]!);
    const bytes = Buffer.from("name,value\nfixture,42\n");
    await fs.writeFile(stagedPath, bytes);

    const prepared = await prepareInputs(
      [{ path: stagedPath, workspaceDir }],
      workspaceDir,
      () => {},
      signal,
    );

    expect(prepared.files).toHaveLength(1);
    expect(Buffer.from(prepared.files[0]!.data, "base64")).toEqual(bytes);
  });

  it.each(["project file", "unowned staging directory", "different workspace"])(
    "rejects a %s without granting custody from attachment metadata",
    async (source) => {
      const fixture = await createStagedInputOwnershipFixture(workspaceDir);
      const relativePath =
        source === "project file"
          ? "project/input-secret.txt"
          : source === "different workspace"
            ? fixture.ownedFiles[0]!
            : fixture.unownedFiles[2]!;
      const filePath = path.join(workspaceDir, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "private project bytes");

      await expect(
        prepareInputs(
          [
            {
              path: filePath,
              workspaceDir: source === "different workspace" ? stateDir : workspaceDir,
              staged: true,
            },
          ],
          workspaceDir,
          () => {},
          signal,
        ),
      ).rejects.toThrow(
        source === "different workspace"
          ? "requires a host-prepared managed media source"
          : "is not owned by the workspace staging service",
      );
    },
  );

  it("rejects a foreign absolute path even when it names an existing managed media ID", async () => {
    const saved = await saveMediaBuffer(Buffer.from("managed bytes"), undefined, "inbound");
    const foreignPath = path.join(workspaceDir, "inbound", saved.id);
    await fs.mkdir(path.dirname(foreignPath));
    await fs.writeFile(foreignPath, "foreign bytes");

    await expect(
      prepareInputs(
        [{ path: foreignPath, url: `media://inbound/${saved.id}` }],
        workspaceDir,
        () => {},
        signal,
      ),
    ).rejects.toThrow("does not match its managed media identity");
  });

  it("enforces the file and aggregate budgets against actual bytes, independent of metadata", async () => {
    const bytes = Buffer.alloc(fileLimit, 97);
    const full = await saveMediaBuffer(bytes, undefined, "inbound");
    const extra = await saveMediaBuffer(Buffer.from("x"), undefined, "inbound");
    const fact = { path: full.path, sizeBytes: 1 };
    const prepared = await prepareInputs([fact, fact], workspaceDir, () => {}, signal);
    expect(prepared.files).toHaveLength(2);
    for (const [index, file] of prepared.files.entries()) {
      expect(Buffer.from(file.data, "base64").equals(bytes), `attachment ${index + 1} bytes`).toBe(
        true,
      );
    }

    await expect(
      prepareInputs([fact, fact, { path: extra.path }], workspaceDir, () => {}, signal),
    ).rejects.toThrow(/readMediaBuffer: media ID/u);

    await fs.appendFile(full.path, "x");
    await expect(prepareInputs([fact], workspaceDir, () => {}, signal)).rejects.toThrow(
      /readMediaBuffer: media ID/u,
    );
  });

  it("admits 50 small attachments and rejects a fifty-first", async () => {
    const saved = await saveMediaBuffer(Buffer.from("x"), undefined, "inbound");
    const facts = Array.from({ length: 50 }, () => ({ path: saved.path }));
    const prepared = await prepareInputs(facts, workspaceDir, () => {}, signal);
    expect(prepared.files).toHaveLength(50);
    expect(new Set(prepared.files.map((file) => file.path)).size).toBe(50);
    await expect(
      prepareInputs([...facts, facts[0]!], workspaceDir, () => {}, signal),
    ).rejects.toThrow("at most 50 input attachments");
  });

  it("stops before reading attachments when the attempt is already cancelled or revoked", async () => {
    const saved = await saveMediaBuffer(Buffer.from("owned bytes"), undefined, "inbound");
    const cancelled = new AbortController();
    const cancellation = new Error("fixture cancellation");
    cancelled.abort(cancellation);
    await expect(
      prepareInputs([{ path: saved.path }], workspaceDir, () => {}, cancelled.signal),
    ).rejects.toBe(cancellation);
    const revocation = new Error("fixture authority revoked");
    await expect(
      prepareInputs(
        [{ path: saved.path }],
        workspaceDir,
        () => {
          throw revocation;
        },
        signal,
      ),
    ).rejects.toBe(revocation);
  });
});

describe("Agents API output attachment publication", () => {
  let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>;
  beforeEach(async () => {
    host = await createAdmittedHostCapabilityTestFixture({
      runId: "run-output-files",
      agentId: "main",
      sessionId: "session-output-files",
      sessionKey: "agent:main:session-output-files",
      workspaceDir,
      cwd: workspaceDir,
      config: {},
    });
  });
  afterEach(() => {
    host.closeHost();
    host.closeAdmission();
  });
  it("persists current-turn deliverables as managed outbound media with the downloaded bytes", async () => {
    const binary = Buffer.from([255, 0, 127, 10]);
    const text = Buffer.from("completed result\n");
    const client = outputClient(
      [
        artifact({
          id: "binary",
          path: "/workspace/outputs/report.bin",
          size_bytes: binary.length,
        }),
        artifact({
          id: "text",
          path: "/workspace/outputs/nested/report.txt",
          size_bytes: text.length,
        }),
        artifact({ id: "input", path: "/workspace/inputs/private.txt" }),
        artifact({ id: "sibling", path: "/workspace/outputs-other/private.txt" }),
        artifact({ id: "old", turn_id: "old-turn" }),
      ],
      { binary, text },
    );

    const output = await collectOutputs(
      client,
      "session-files",
      "turn-files",
      () => {},
      signal,
      host.hostCapabilities.prepareReplyMedia,
    );

    expect(output.toolMediaUrls).toHaveLength(2);
    expect(output.hostOwnedToolMediaUrls).toEqual(output.toolMediaUrls);
    expect(output.toolTrustedLocalMedia).toBe(true);
    expect(await Promise.all(output.toolMediaUrls.map((file) => fs.readFile(file)))).toEqual([
      binary,
      text,
    ]);
    for (const file of output.toolMediaUrls) {
      expect(path.dirname(file)).toBe(path.join(stateDir, "media", "outbound"));
    }
    expect((await fs.readdir(path.join(stateDir, "media", "outbound"))).toSorted()).toEqual(
      output.toolMediaUrls.map((file) => path.basename(file)).toSorted(),
    );
  });

  it.each([
    { name: "an unfinished turn", turnStatus: "in_progress" },
    { name: "a turn error", turnError: "generation failed" },
    { name: "a busy session", sessionStatus: "in_progress" },
  ])("does not publish artifacts from $name", async (options) => {
    const client = outputClient([artifact()], {}, options);
    await expect(
      collectOutputs(
        client,
        "session-files",
        "turn-files",
        () => {},
        signal,
        host.hostCapabilities.prepareReplyMedia,
      ),
    ).rejects.toThrow("requires a completed root turn and idle session");
    expect(await outboundFiles()).toEqual([]);
  });

  it.each([
    { name: "another environment", change: { environment_id: "foreign-environment" } },
    { name: "parent traversal", change: { path: "/workspace/outputs/../private.txt" } },
    { name: "a NUL path", change: { path: "/workspace/outputs/file\0.txt" } },
    { name: "an oversized file", change: { size_bytes: fileLimit + 1 } },
  ])("rejects $name before persisting any output", async ({ change }) => {
    const client = outputClient([artifact(), artifact({ id: "invalid", ...change })]);
    await expect(
      collectOutputs(
        client,
        "session-files",
        "turn-files",
        () => {},
        signal,
        host.hostCapabilities.prepareReplyMedia,
      ),
    ).rejects.toThrow("exceeds its hosted path or 5 MiB file bounds");
    expect(await outboundFiles()).toEqual([]);
  });

  it.each([
    {
      name: "count",
      artifacts: Array.from({ length: 51 }, (_, index) => artifact({ id: `file-${index}` })),
      message: "at most 50 artifacts",
    },
    {
      name: "bytes",
      artifacts: [
        artifact({ size_bytes: fileLimit }),
        artifact({ id: "second", size_bytes: fileLimit }),
        artifact({ id: "third" }),
      ],
      message: "10 MiB total",
    },
  ])(
    "rejects a complete output inventory exceeding the $name budget",
    async ({ artifacts, message }) => {
      const client = outputClient(artifacts);
      await expect(
        collectOutputs(
          client,
          "session-files",
          "turn-files",
          () => {},
          signal,
          host.hostCapabilities.prepareReplyMedia,
        ),
      ).rejects.toThrow(message);
      expect(await outboundFiles()).toEqual([]);
    },
  );

  it.each(["host", "binding", "abort"])(
    "rejects %s revocation during media-save preparation before writing output",
    async (revocation) => {
      const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
      const client = outputClient(
        [artifact({ path: "/workspace/outputs/result.pdf", size_bytes: bytes.length })],
        { output: bytes },
      );
      const controller = new AbortController();
      let bindingCurrent = true;
      let reachedSave = false;
      const assertCurrent = () => {
        if (!bindingCurrent) {
          throw new Error("fixture binding lease revoked");
        }
      };
      const detectMime = mediaMime.detectMime;
      vi.spyOn(mediaMime, "detectMime").mockImplementation(async (params) => {
        const mime = await detectMime(params);
        // Revoke inside saveMediaBuffer's awaited MIME preparation, before its final write.
        if (params.filePath === "result.pdf") {
          reachedSave = true;
          if (revocation === "host") {
            host.closeHost();
          } else if (revocation === "binding") {
            bindingCurrent = false;
          } else {
            controller.abort(new Error("fixture transfer aborted"));
          }
        }
        return mime;
      });
      await expect(
        collectOutputs(
          client,
          "session-files",
          "turn-files",
          assertCurrent,
          controller.signal,
          host.hostCapabilities.prepareReplyMedia,
        ),
      ).rejects.toThrow(
        /no longer active|binding lease revoked|transfer aborted|This operation was aborted/,
      );
      expect(reachedSave).toBe(true);
      expect(await outboundFiles()).toEqual([]);
    },
  );

  it("refuses output publication without the host capability", async () => {
    const client = outputClient([artifact()], { output: Buffer.from("x") });
    await expect(
      collectOutputs(client, "session-files", "turn-files", () => {}, signal, undefined),
    ).rejects.toThrow("requires host reply media preparation");
    expect(await outboundFiles()).toEqual([]);
  });

  it("revalidates attempt custody after the artifact download and before saving outbound bytes", async () => {
    let current = true;
    const revoked = new Error("fixture attempt revoked");
    // The client remains usable; publication still belongs to the calling attempt.
    const client = outputClient(
      [artifact()],
      { output: Buffer.from("x") },
      {
        onContent: () => {
          current = false;
        },
      },
    );
    await expect(
      collectOutputs(
        client,
        "session-files",
        "turn-files",
        () => {
          if (!current) {
            throw revoked;
          }
        },
        signal,
        host.hostCapabilities.prepareReplyMedia,
      ),
    ).rejects.toBe(revoked);
    expect(await outboundFiles()).toEqual([]);
  });
});

function artifact(overrides: Partial<AgentsApiArtifact> = {}): AgentsApiArtifact {
  return {
    object: "agent.session.artifact",
    id: "output",
    session_id: "session-files",
    environment_id: "environment-files",
    turn_id: "turn-files",
    path: "/workspace/outputs/result.txt",
    size_bytes: 1,
    ...overrides,
  };
}

function outputClient(
  artifacts: AgentsApiArtifact[],
  content: Record<string, Buffer> = {},
  options: {
    turnStatus?: string;
    turnError?: string;
    sessionStatus?: string;
    onContent?: () => void;
  } = {},
): AgentsApiClient {
  guardedFetch.mockImplementation(async ({ url }) => {
    const pathname = new URL(url).pathname;
    const sessionPath = "/v1/agents/sessions/session-files";
    let response: Response;
    if (pathname === `${sessionPath}/turns/turn-files`) {
      response = Response.json({
        id: "turn-files",
        session_id: "session-files",
        subagent_id: null,
        status: options.turnStatus ?? "completed",
        error: options.turnError ?? null,
      });
    } else if (pathname === sessionPath) {
      response = Response.json({
        id: "session-files",
        status: options.sessionStatus ?? "idle",
        environment: { type: "openai_hosted", id: "environment-files" },
      });
    } else if (pathname === `${sessionPath}/artifacts`) {
      response = Response.json({ data: artifacts, has_more: false });
    } else {
      const id = pathname.match(/\/artifacts\/([^/]+)\/content$/u)?.[1];
      const bytes = id ? content[id] : undefined;
      if (!bytes) {
        throw new Error(`Unexpected fixture request: ${pathname}`);
      }
      options.onContent?.();
      response = new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    return { response, finalUrl: url, release: async () => {} };
  });
  return new AgentsApiClient("fixture-not-a-real-api-key", () => {});
}

async function outboundFiles(): Promise<string[]> {
  try {
    return await fs.readdir(path.join(stateDir, "media", "outbound"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
