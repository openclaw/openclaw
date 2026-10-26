import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ResolveAcpSessionAvailability =
  (typeof import("openclaw/plugin-sdk/acp-runtime"))["resolveAcpSessionAvailability"];

const acpRuntimeMocks = vi.hoisted(() => ({
  resolveAcpSessionAvailability: vi.fn<ResolveAcpSessionAvailability>(() => ({ available: true })),
}));
const transcriptMocks = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  failAfter: undefined as number | undefined,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  resolveAcpSessionAvailability: acpRuntimeMocks.resolveAcpSessionAvailability,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    withSessionTranscriptWrite: async (
      _params: unknown,
      run: (context: {
        appendMessage: (params: {
          message: Record<string, unknown>;
          idempotencyLookup?: string;
        }) => Promise<void>;
      }) => Promise<void>,
    ) => {
      const pending: Array<Record<string, unknown>> = [];
      await run({
        appendMessage: async ({ message, idempotencyLookup }) => {
          if (transcriptMocks.failAfter === pending.length + 1) {
            throw new Error("transcript append failed");
          }
          const key = message.idempotencyKey;
          if (
            idempotencyLookup === "scan" &&
            typeof key === "string" &&
            [...transcriptMocks.messages, ...pending].some(
              (candidate) => candidate.idempotencyKey === key,
            )
          ) {
            return;
          }
          pending.push(message);
        },
      });
      transcriptMocks.messages.push(...pending);
    },
  };
});

import { capturePiContinuationCatalog, usePiFixtures } from "./pi-session-catalog.test-support.js";

const { createStore, installPi } = usePiFixtures();
let sessionDirectory: string;
let catalog: ReturnType<typeof capturePiContinuationCatalog>;
const continueRequest = { hostId: "gateway", threadId: "pi-session" };

beforeEach(async () => {
  sessionDirectory = await createStore("hi", "Pi catalog session", { command: "pwd" }, true);
  await installPi();
  catalog = capturePiContinuationCatalog();
});

afterEach(() => {
  acpRuntimeMocks.resolveAcpSessionAvailability.mockReset().mockReturnValue({ available: true });
  transcriptMocks.messages.length = 0;
  transcriptMocks.failAfter = undefined;
});

describe("Pi session catalog continuation", () => {
  it("projects only adopted Pi rows with their OpenClaw session key", async () => {
    const { entries, provider } = catalog;
    const sessionEntries = { entriesForAgent: () => entries } as never;

    const before = await provider.list({ hostIds: ["gateway"], sessionEntries });
    expect(before[0]?.sessions[0]).not.toHaveProperty("sessionKey");

    const adopted = await provider.continueSession!(continueRequest);
    const after = await provider.list({ hostIds: ["gateway"], sessionEntries });

    expect(after[0]?.sessions[0]).toMatchObject({
      threadId: "pi-session",
      sessionKey: adopted.sessionKey,
    });
  });

  it("adopts once with the native ACP binding and an exact file baseline", async () => {
    const { createSessionEntry, provider } = catalog;

    const [first, concurrent] = await Promise.all([
      provider.continueSession!(continueRequest),
      provider.continueSession!(continueRequest),
    ]);
    const second = await provider.continueSession!(continueRequest);
    const sessionFile = await fs.realpath(path.join(sessionDirectory, "session.jsonl"));
    const sessionStats = await fs.stat(sessionFile);

    expect(first).toEqual(concurrent);
    expect(second).toEqual(first);
    expect(first.upstream).toEqual({
      kind: "pi-cli",
      ref: { filePath: sessionFile },
      marker: expect.objectContaining({ offset: sessionStats.size }),
    });
    expect(createSessionEntry).toHaveBeenCalledTimes(1);
    const createParams = createSessionEntry.mock.calls[0]?.[0];
    expect(createParams).not.toHaveProperty("label");
    expect(createParams).toMatchObject({
      displayName: "Pi catalog session",
      spawnedCwd: "/workspace",
    });
    expect(createParams?.initialEntry).toEqual({
      acpBackendId: "acpx",
      acpSessionBinding: { acpAgentId: "pi", agentSessionId: "pi-session" },
      pluginExtensions: { acpx: { piSessionCatalog: { sourceThreadId: "pi-session" } } },
    });
    expect(
      transcriptMocks.messages.map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual([
      "hello",
      "Thinking\n\nthinking",
      "hi",
      'Tool call\n\nbash\n{"command":"pwd"}',
      "Tool result\n\nbash\n/workspace",
    ]);
    expect(transcriptMocks.messages[0]?.["__openclaw"]).toEqual({
      mirrorOrigin: "pi-catalog-import",
      catalogDisplay: { type: "userMessage" },
    });

    await createParams?.afterCreate?.(await createSessionEntry.mock.results[0]?.value);
    expect(transcriptMocks.messages).toHaveLength(5);
  });

  it("rolls adoption back when transcript import fails", async () => {
    transcriptMocks.failAfter = 2;
    const { entries, provider } = catalog;

    await expect(provider.continueSession!(continueRequest)).rejects.toThrow(
      "transcript append failed",
    );
    expect(entries).toEqual([]);
    expect(transcriptMocks.messages).toEqual([]);
  });

  it("rejects paired-node and unknown session continuation", async () => {
    const { createSessionEntry, provider } = catalog;

    await expect(
      provider.continueSession!({ hostId: "node:remote", threadId: "pi-session" }),
    ).rejects.toThrow("paired-node Pi session rows are view-only");
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "missing" }),
    ).rejects.toThrow("Pi session is unavailable");
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("keeps legacy-session adoption successful when a safe baseline is unavailable", async () => {
    const sessionFile = path.join(sessionDirectory, "session.jsonl");
    const content = await fs.readFile(sessionFile, "utf8");
    await fs.writeFile(sessionFile, content.replace('"version":3', '"version":2'));
    const { createSessionEntry, provider } = catalog;

    await expect(provider.continueSession!(continueRequest)).resolves.toEqual({
      sessionKey: expect.any(String),
    });
    expect(createSessionEntry).toHaveBeenCalledTimes(1);
  });
});
