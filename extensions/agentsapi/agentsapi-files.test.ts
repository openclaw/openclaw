import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
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
const signal = new AbortController().signal;
let stateDir: string;
let workspaceDir: string;
let outboundDir: string;

beforeEach(async () => {
  const directory = tempDirs.make("agentsapi-files-");
  stateDir = path.join(directory, "state");
  outboundDir = path.join(stateDir, "media", "outbound");
  workspaceDir = path.join(directory, "workspace");
  await fs.mkdir(workspaceDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  guardedFetch.mockReset();
  vi.restoreAllMocks();
});

function prepare(media: Parameters<typeof prepareInputs>[0]) {
  return prepareInputs(media, workspaceDir, () => {}, signal);
}

function save(bytes: string | Buffer, subdir: "inbound" | "outbound" = "inbound") {
  return saveMediaBuffer(typeof bytes === "string" ? Buffer.from(bytes) : bytes, undefined, subdir);
}

describe("Agents API input attachment custody", () => {
  it("copies managed bytes and keeps untrusted names inside an escaped attachment mapping", async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    const inbound = await save(bytes);
    const outbound = await save("previous output", "outbound");
    const name = '../../deliver\n"escape".bin';

    const prepared = await prepare([
      { url: `media://inbound/${inbound.id}`, fileName: name },
      { path: outbound.path, fileName: "previous.txt" },
    ]);

    expect(decodedFiles(prepared)).toEqual([bytes, Buffer.from("previous output")]);
    expect(prepared.files[0]!.path).toMatch(
      /^\/workspace\/inputs\/[\w.-]+-deliver__escape_\.bin$/u,
    );
    expect(prepared.mappingText.split("\n")).toHaveLength(3);
    expect(JSON.parse(prepared.mappingText.split("\n")[1]!)).toEqual([
      { attachment: 1, name, path: prepared.files[0]!.path },
      { attachment: 2, name: "previous.txt", path: prepared.files[1]!.path },
    ]);
  });

  it.each(["owned", "managed", "project", "unowned", "workspace", "foreign"])(
    "enforces attachment custody: %s",
    async (source) => {
      const fixture = await createStagedInputOwnershipFixture(workspaceDir);
      const stagedBytes = Buffer.from("name,value\nstaged,42\n");
      const originalBytes = Buffer.from("name,value\noriginal,73\n");
      const foreign = source === "foreign";
      const managed = source === "managed" || foreign ? await save(originalBytes) : undefined;
      const accepted = source === "owned" || source === "managed";
      const relativePath =
        source === "project"
          ? "project/input-secret.txt"
          : source === "unowned"
            ? fixture.unownedFiles[2]!
            : foreign
              ? path.join("inbound", managed!.id)
              : fixture.ownedFiles[0]!;
      const filePath = path.join(workspaceDir, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, stagedBytes);
      const prepared = prepare([
        {
          path: filePath,
          workspaceDir: source === "workspace" ? stateDir : workspaceDir,
          ...(managed ? { url: `media://inbound/${managed.id}` } : {}),
          ...(!accepted && !foreign ? { staged: true } : {}),
          ...(foreign ? { sizeBytes: fileLimit + 1 } : {}),
        },
      ]);
      if (accepted) {
        expect(decodedFiles(await prepared)).toEqual([managed ? originalBytes : stagedBytes]);
      } else {
        await expect(prepared).rejects.toThrow(
          foreign
            ? "does not match its managed media identity"
            : source === "workspace"
              ? "requires a host-prepared managed media source"
              : "is not owned by the workspace staging service",
        );
      }
    },
  );

  it("keeps accepted files and explains omissions at actual byte limits, independent of metadata", async () => {
    const bytes = Buffer.alloc(fileLimit, 97);
    const full = await save(bytes);
    const extra = await save("x");
    const fact = { path: full.path, sizeBytes: 1 };
    expect(decodedFiles(await prepare([fact, fact]))).toEqual([bytes, bytes]);

    const smaller = await save(bytes.subarray(1));
    const partial = await prepare([fact, { path: extra.path }, fact, { path: smaller.path }]);
    expect(decodedFiles(partial)).toEqual([bytes, Buffer.from("x"), bytes.subarray(1)]);
    expect(
      JSON.parse(partial.mappingText.split("\n")[1]!).map(
        ({ attachment }: { attachment: number }) => attachment,
      ),
    ).toEqual([1, 2, 4]);
    expect(partial.feedbackText).toContain(
      '{"attachment":3,"reason":"exceeds the remaining 10 MiB total transfer budget"}',
    );

    await fs.appendFile(full.path, "x");
    const oversized = await prepare([fact, { path: extra.path }]);
    expect(decodedFiles(oversized)).toEqual([Buffer.from("x")]);
    expect(oversized.feedbackText).toContain(
      '{"attachment":1,"reason":"exceeds the 5 MiB file limit"}',
    );
  });

  it("transfers only the first 50 candidates and reports the unread remainder", async () => {
    const saved = await save("x");
    const facts = Array.from({ length: 50 }, () => ({ path: saved.path }));
    const prepared = await prepare([...facts, { path: path.join(workspaceDir, "not-read.txt") }]);
    expect(prepared.files).toHaveLength(50);
    expect(new Set(prepared.files.map((file) => file.path)).size).toBe(50);
    expect(prepared.feedbackText).toContain(
      "1 attachment(s) after the first 50 were omitted without reading them",
    );
  });

  it.each([Number.NaN, -1])("rejects invalid size %s, not an omission", async (sizeBytes) => {
    const saved = await save("x");
    await expect(prepare([{ path: saved.path, sizeBytes }])).rejects.toThrow(
      "Agents API input attachment has an invalid size",
    );
  });

  it.each(["cancelled", "revoked"])("stops before reading when %s", async (mode) => {
    const saved = await save("owned bytes");
    const controller = new AbortController();
    const revocation = new Error("fixture authority revoked");
    if (mode === "cancelled") {
      controller.abort(revocation);
    }
    const assertCurrent = () => {
      if (mode === "revoked") {
        throw revocation;
      }
    };
    await expect(
      prepareInputs([{ path: saved.path }], workspaceDir, assertCurrent, controller.signal),
    ).rejects.toBe(revocation);
  });
});

function decodedFiles(prepared: Awaited<ReturnType<typeof prepareInputs>>) {
  return prepared.files.map((file) => Buffer.from(file.data, "base64"));
}

describe("Agents API output attachment publication", () => {
  let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>;
  beforeEach(async () => {
    host = await createAdmittedHostCapabilityTestFixture({
      runId: "run-output-files",
      workspaceDir,
    });
  });
  afterEach(() => {
    host.closeHost();
    host.closeAdmission();
  });

  function collect(client: AgentsApiClient, guard = () => {}, abortSignal = signal) {
    return collectOutputs(
      client,
      "session-files",
      "turn-files",
      guard,
      abortSignal,
      host.hostCapabilities.prepareReplyMedia,
    );
  }

  it("persists current-turn deliverables as managed outbound media with the downloaded bytes", async () => {
    const binary = Buffer.from([255, 0, 127, 10]);
    const text = Buffer.from("completed result\n");
    const client = outputClient(
      [
        outputArtifact("binary", "report.bin", binary),
        outputArtifact("text", "nested/report.txt", text),
        artifact({ id: "input", path: "/workspace/inputs/private.txt" }),
        artifact({ id: "sibling", path: "/workspace/outputs-other/private.txt" }),
        artifact({ id: "old", turn_id: "old-turn" }),
      ],
      { binary, text },
    );

    const output = await collect(client);

    expect(await Promise.all(output.map((file) => fs.readFile(file)))).toEqual([binary, text]);
    expect(output.map((file) => path.dirname(file))).toEqual(Array(2).fill(outboundDir));
    expect((await outboundFiles()).toSorted()).toEqual(
      output.map((file) => path.basename(file)).toSorted(),
    );
  });

  const incompleteTurn = "requires a completed root turn and idle session";
  it.each<{
    options?: Parameters<typeof outputClient>[2];
    patch?: Partial<AgentsApiArtifact>;
    artifacts?: AgentsApiArtifact[];
    error?: string;
  }>([
    { options: { turnStatus: "in_progress" }, error: incompleteTurn },
    { options: { turnError: "generation failed" }, error: incompleteTurn },
    { options: { sessionStatus: "in_progress" }, error: incompleteTurn },
    { patch: { environment_id: "foreign-environment" } },
    { patch: { path: "/workspace/outputs/../private.txt" } },
    { patch: { path: "/workspace/outputs/file\0.txt" } },
    { patch: { size_bytes: fileLimit + 1 } },
    {
      artifacts: Array.from({ length: 51 }, (_, index) => artifact({ id: `file-${index}` })),
      error: "at most 50 artifacts",
    },
    {
      artifacts: [
        artifact({ size_bytes: fileLimit }),
        artifact({ id: "second", size_bytes: fileLimit }),
        artifact({ id: "third" }),
      ],
      error: "10 MiB total",
    },
  ])("rejects invalid output inventory %j", async ({ options, patch, artifacts, error }) => {
    const inventory = artifacts ?? [
      artifact(),
      ...(patch ? [artifact({ id: "invalid", ...patch })] : []),
    ];
    await expect(collect(outputClient(inventory, {}, options))).rejects.toThrow(
      error ?? "exceeds its hosted path or 5 MiB file bounds",
    );
    expect(await outboundFiles()).toEqual([]);
  });

  it.each([
    ["host", "save"],
    ["binding", "save"],
    ["abort", "save"],
    ["binding", "download"],
  ] as const)("revalidates %s during %s", async (revocation, point) => {
    const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
    const controller = new AbortController();
    const revoked = new Error("fixture transfer authority revoked");
    let bindingCurrent = true;
    let reachedSave = false;
    const assertCurrent = () => {
      if (!bindingCurrent) {
        throw revoked;
      }
    };
    const revoke = {
      host: () => host.closeHost(),
      binding: () => {
        bindingCurrent = false;
      },
      abort: () => controller.abort(revoked),
    }[revocation];
    const client = outputClient(
      [outputArtifact("output", "result.pdf", bytes)],
      { output: bytes },
      { onContent: point === "download" ? revoke : undefined },
    );
    const detectMime = mediaMime.detectMime;
    vi.spyOn(mediaMime, "detectMime").mockImplementation(async (params) => {
      const mime = await detectMime(params);
      // Revoke inside saveMediaBuffer's awaited MIME preparation, before its final write.
      if (params.filePath === "result.pdf") {
        reachedSave = true;
        revoke();
      }
      return mime;
    });
    const collecting = collect(client, assertCurrent, controller.signal);
    if (revocation === "host") {
      await expect(collecting).rejects.toMatchObject({ name: "AbortError", code: 20 });
    } else {
      await expect(collecting).rejects.toBe(revoked);
    }
    expect(reachedSave).toBe(point === "save");
    expect(await outboundFiles()).toEqual([]);
  });

  it("refuses output publication without the host capability", async () => {
    const client = outputClient([artifact()], { output: Buffer.from("x") });
    await expect(
      collectOutputs(client, "session-files", "turn-files", () => {}, signal, undefined),
    ).rejects.toThrow("requires host reply media preparation");
    expect(await outboundFiles()).toEqual([]);
  });
});

function outputArtifact(id: string, name: string, bytes: Buffer) {
  return artifact({ id, path: `/workspace/outputs/${name}`, size_bytes: bytes.length });
}

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
    const json: Record<string, unknown> = {
      [`${sessionPath}/turns/turn-files`]: {
        id: "turn-files",
        session_id: "session-files",
        subagent_id: null,
        status: options.turnStatus ?? "completed",
        error: options.turnError ?? null,
      },
      [sessionPath]: {
        id: "session-files",
        status: options.sessionStatus ?? "idle",
        environment: { type: "openai_hosted", id: "environment-files" },
      },
      [`${sessionPath}/artifacts`]: { data: artifacts, has_more: false },
    };
    let response: Response;
    if (Object.hasOwn(json, pathname)) {
      response = Response.json(json[pathname]);
    } else {
      const id = pathname.match(/\/artifacts\/([^/]+)\/content$/u)?.[1];
      const bytes = id ? content[id] : undefined;
      if (!bytes || pathname !== `${sessionPath}/artifacts/${id}/content`) {
        throw new Error(`Unexpected fixture request: ${pathname}`);
      }
      options.onContent?.();
      response = new Response(new Uint8Array(bytes));
    }
    return { response, finalUrl: url, release: async () => {} };
  });
  return new AgentsApiClient("fixture-not-a-real-api-key", () => {});
}

function outboundFiles(): Promise<string[]> {
  return fs.readdir(outboundDir).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
}
