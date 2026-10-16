import fs from "node:fs/promises";
import path from "node:path";
import {
  detectAndLoadAgentHarnessPromptImages,
  queueAgentHarnessMessage,
  resolveActiveEmbeddedRunSessionId,
  runAgentHarnessGatewayQuestion,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import { createRemoteShellSandboxFsBridge } from "openclaw/plugin-sdk/sandbox";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { createSandboxTestContext, createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexUserInput } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  bindProductionHarnessHostCapabilitiesForTest,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

type QueueOptions = NonNullable<Parameters<typeof queueAgentHarnessMessage>[2]>;
type Recorder = NonNullable<QueueOptions["userTurnTranscriptRecorder"]>;
type UserMessage = NonNullable<Recorder["message"]>;
type Scenario = "offloaded" | "mixed" | "resolved";
type SteerRequest = {
  clientUserMessageId: string;
  input: CodexUserInput[];
};

setupRunAttemptTestHooks();
const managedFixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    managedFixtures.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createMediaFixture(scenario: Scenario, managed = false) {
  const root = await fs.realpath(tempDir);
  const params = createParams(path.join(root, "session.jsonl"), path.join(root, "workspace"));
  params.modelId = "gpt-5.6-luna";
  params.model = {
    ...params.model,
    id: params.modelId,
    name: params.modelId,
    input: ["text", "image"],
  };
  params.toolAuthorityFingerprint = "steering-media-authority";
  await fs.mkdir(params.workspaceDir, { recursive: true });
  let mediaDir = params.workspaceDir;
  if (managed) {
    const inbound = path.join(getMediaDir(), "inbound");
    await fs.mkdir(inbound, { recursive: true });
    mediaDir = await fs.mkdtemp(path.join(inbound, "steering-"));
    managedFixtures.push(mediaDir);
  }
  const image = async (name: string, r: number, g: number, b: number) => {
    const bytes = createSolidPngBuffer(1, 1, { r, g, b });
    const file = { path: path.join(mediaDir, `${name}.png`), contentType: "image/png" };
    await fs.writeFile(file.path, bytes);
    const data = bytes.toString("base64");
    return { file, data, input: { type: "image", url: `data:image/png;base64,${data}` } };
  };
  const [blue, green, red, document] = await Promise.all([
    image("blue", 0, 0, 255),
    image("green", 0, 255, 0),
    image("red", 255, 0, 0),
    image("document", 255, 0, 0),
  ]);
  const inline = { type: "image" as const, data: red.data, mimeType: "image/png" };
  const mixed = scenario !== "offloaded";
  const canonical = scenario === "resolved";
  const mixedMedia = [blue.file, { kind: "image" as const }, green.file];
  const media: NonNullable<QueueOptions["media"]> = canonical
    ? [{ path: document.file.path, kind: "document" }, red.file, ...mixedMedia]
    : mixed
      ? mixedMedia
      : [blue.file, green.file];
  const staleMedia: NonNullable<QueueOptions["media"]> = [green.file, { kind: "image" }, blue.file];
  const message: UserMessage & { content: string } = {
    role: "user",
    content: "compare these attachments",
    timestamp: 1_750_000_000_000,
    __openclaw: {
      media,
      ...(canonical
        ? {
            mediaImageLayout: {
              slots: [
                { kind: "offloaded", factIndex: 2 },
                { kind: "inline", factIndex: 3 },
                { kind: "offloaded", factIndex: 4 },
              ],
              suppressedFactIndexes: [1],
            },
          }
        : {}),
    },
  };
  const target = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey!,
    storePath: path.join(root, "sessions.sqlite"),
  };
  params.sessionTarget = target;
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: params.sessionId, sessionFile: params.sessionFile, updatedAt: Date.now() },
  });
  let persisted = false;
  const recorder = {
    message: canonical ? { ...message, __openclaw: { media: staleMedia } } : message,
    resolveMessage: vi.fn(async (): Promise<UserMessage> => message),
    getAdmissionReceipt: () => undefined,
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(),
    markBlocked: vi.fn(),
    hasPersisted: () => persisted,
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistApproved: vi.fn(async () => {
      if (!persisted) {
        const result = await appendSessionTranscriptMessageByIdentity({
          ...target,
          message,
          cwd: params.workspaceDir,
        });
        persisted = Boolean(result);
      }
      return undefined;
    }),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  } satisfies Recorder;
  const options: QueueOptions = {
    debounceMs: 0,
    isInboundUserMessage: true,
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    waitForTranscriptCommit: true,
    images: mixed ? [inline] : [],
    // Deliberately disagree with the recorder's canonical facts and layout.
    media: canonical ? staleMedia : media,
    imageOrder: canonical
      ? ["inline", "offloaded", "offloaded"]
      : mixed
        ? ["offloaded", "inline", "offloaded"]
        : ["offloaded", "offloaded"],
    ...(canonical ? { userTurnTranscriptRecorder: recorder } : {}),
  };
  const expectedImages = [blue.input, ...(mixed ? [red.input] : []), green.input];
  const readSteeredMessages = async () =>
    (await readVisibleSessionTranscriptMessageEntries(target))
      .map((entry) => entry.message)
      .filter((entry) => entry.role === "user" && entry.timestamp === message.timestamp);
  return {
    params,
    options,
    message,
    recorder,
    canonicalMedia: media,
    expectedImages,
    readSteeredMessages,
  };
}

type MediaFixture = Awaited<ReturnType<typeof createMediaFixture>>;
type StartedHarness = ReturnType<typeof createStartedThreadHarness>;

async function withActiveMediaTurn(
  fixture: MediaFixture,
  exercise: (harness: StartedHarness, controller: AbortController) => Promise<void>,
  onRequest?: Parameters<typeof createStartedThreadHarness>[0],
) {
  const harness = createStartedThreadHarness(onRequest);
  // Drive media/closure ordering without charging filesystem setup to the run budget.
  vi.useFakeTimers();
  const controller = new AbortController();
  const started = createDeferred<void>();
  const run = runCodexAppServerAttempt({
    ...fixture.params,
    abortSignal: controller.signal,
    onAgentEvent: (event) => {
      if (event.stream === "lifecycle" && event.data.phase === "start") {
        started.resolve();
      }
      return fixture.params.onAgentEvent?.(event);
    },
  });
  try {
    // Polling waitFor advances fake time while cold runtime preparation is still loading.
    await started.promise;
    expect(harness.requests.some((entry) => entry.method === "turn/start")).toBe(true);
    expect(resolveActiveEmbeddedRunSessionId(fixture.params.sessionKey!)).toBe(
      fixture.params.sessionId,
    );
    await exercise(harness, controller);
  } finally {
    // Assertions may fail while a steer awaits consumption; always retire its owner.
    controller.abort();
    await run;
  }
}

async function notifyConsumed(harness: StartedHarness, clientId: string, turnId = "turn-1") {
  await harness.notify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId,
      item: { id: `user-${clientId}`, type: "userMessage", clientId },
    },
  });
}

function registerSteeringWorkspace(
  fixture: MediaFixture,
  prepareTurnAttachments?: AgentWorkspaceAccess["prepareTurnAttachments"],
) {
  return registerAgentWorkspaceAccess(fixture.params.workspaceDir, {
    bridge: {
      readFileWithSource: async () => {
        throw Object.assign(new Error("No bootstrap file in remote fixture"), { code: "ENOENT" });
      },
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => {},
      stat: async () => null,
    },
    prepareTurnAttachments,
  });
}

function queueMedia(
  fixture: MediaFixture,
  text = fixture.message.content,
  options = fixture.options,
) {
  const accepted = vi.fn();
  expect(
    queueAgentHarnessMessage(fixture.params.sessionId, text, {
      ...options,
      onQueueAccepted: accepted,
    }),
  ).toBe(true);
  return accepted;
}

function waitForAcceptance(accepted: ReturnType<typeof vi.fn>, value: boolean) {
  return vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith(value), fastWait);
}

function steers(harness: StartedHarness) {
  return harness.requests
    .filter((entry) => entry.method === "turn/steer")
    .map((entry) => entry.params as SteerRequest);
}

async function expectUnpersisted(fixture: MediaFixture, harness: StartedHarness) {
  expect(steers(harness)).toEqual([]);
  expect(fixture.recorder.persistApproved).not.toHaveBeenCalled();
  expect(await fixture.readSteeredMessages()).toEqual([]);
}

it("prepares remote attachments with sandbox access ro without changing images or transcript", async () => {
  const fixture = await createMediaFixture("resolved", true);
  const sandboxRoot = path.join(tempDir, "sandbox");
  await fs.mkdir(sandboxRoot);
  const sandbox = createSandboxTestContext({
    overrides: {
      sessionKey: fixture.params.sessionKey!,
      workspaceDir: sandboxRoot,
      agentWorkspaceDir: fixture.params.workspaceDir,
      workspaceAccess: "ro",
      tools: { allow: [], deny: [] },
    },
    dockerOverrides: { readOnlyRoot: true },
  });
  sandbox.fsBridge = createRemoteShellSandboxFsBridge({
    sandbox,
    runtime: {
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/agent",
      runRemoteShellScript: async () => {
        throw new Error("Gateway originals are not in the sandbox");
      },
    },
  });
  fixture.params.sandbox = sandbox;
  // Deferred originals must be resolved even when the initial snapshot has no file paths.
  fixture.recorder.message = { ...fixture.message, __openclaw: { media: [{ kind: "image" }] } };
  fixture.options.media = [];
  const note = "Attachments are available in /remote/workspace/.inputs/steered-turn.";
  const prepare = vi.fn<NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>>(
    async (_turn, assertCurrent) => {
      assertCurrent();
      return note;
    },
  );
  const release = registerSteeringWorkspace(fixture, prepare);
  try {
    await withActiveMediaTurn(fixture, async (harness) => {
      const accepted = queueMedia(fixture);
      await waitForAcceptance(accepted, true);
      const [steer] = steers(harness);
      expect(steer.input).toEqual([
        { type: "text", text: `${fixture.message.content}\n\n${note}`, text_elements: [] },
        ...fixture.expectedImages,
      ]);
      expect(prepare).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          media: fixture.canonicalMedia.map((fact) => expect.objectContaining(fact)),
          config: fixture.params.config,
          abortSignal: expect.any(AbortSignal),
        }),
        expect.any(Function),
      );
      await notifyConsumed(harness, steer.clientUserMessageId);
      expect(await fixture.readSteeredMessages()).toEqual([fixture.message]);
    });
  } finally {
    release();
  }
});

it.each(["replaced", "host-closed", "hydration-host-closed"] as const)(
  "rejects %s attachment preparation before dispatch or persistence",
  async (failure) => {
    const fixture = await createMediaFixture("resolved");
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(fixture.params);
    const prepared = createDeferred<void>();
    const hydrating = failure === "hydration-host-closed";
    const prepare = vi.fn<NonNullable<AgentWorkspaceAccess["prepareTurnAttachments"]>>(async () => {
      await prepared.promise;
      return "Attachments prepared.";
    });
    if (hydrating) {
      fixture.recorder.resolveMessage.mockImplementation(async () => {
        await prepared.promise;
        return fixture.message;
      });
    }
    const release = hydrating ? () => {} : registerSteeringWorkspace(fixture, prepare);
    let releaseReplacement: (() => void) | undefined;
    try {
      await withActiveMediaTurn(fixture, async (harness) => {
        const accepted = queueMedia(fixture, hydrating ? "delayed image" : fixture.message.content);
        await vi.waitFor(
          () =>
            expect(hydrating ? fixture.recorder.resolveMessage : prepare).toHaveBeenCalledOnce(),
          fastWait,
        );
        expect(steers(harness)).toEqual([]);
        if (hydrating) {
          expect(accepted).not.toHaveBeenCalled();
        }
        if (failure === "replaced") {
          release();
          releaseReplacement = registerSteeringWorkspace(fixture, prepare);
        } else {
          closeHost();
        }
        // Closing the host does not settle hydration: its post-await authority check rejects.
        prepared.resolve();
        await waitForAcceptance(accepted, false);
        await expectUnpersisted(fixture, harness);
      });
    } finally {
      prepared.resolve();
      closeHost();
      release();
      releaseReplacement?.();
    }
  },
);

it("keeps consumed question answers accepted when their host closes during the response", async () => {
  const fixture = await createMediaFixture("offloaded");
  const onAttemptTimeout = vi.fn();
  fixture.params.onAttemptTimeout = onAttemptTimeout;
  const closeHost = await bindProductionHarnessHostCapabilitiesForTest(fixture.params);
  await withActiveMediaTurn(fixture, async (harness, controller) => {
    const result = { status: "answered" as const, answers: { answers: { choice: ["yes"] } } };
    const answer = createDeferred<typeof result>();
    const onBlockReply = vi.fn();
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const gatewayCall = vi.fn(async (method: string) => {
      if (method === "question.request") {
        return { id: questionId };
      }
      if (method === "question.waitAnswer") {
        return await answer.promise;
      }
      if (method === "question.resolve") {
        answer.resolve(result);
        closeHost();
        return {};
      }
      throw new Error(`unexpected question method: ${method}`);
    });
    const question = runAgentHarnessGatewayQuestion({
      questionId,
      questions: [{ id: "choice", header: "Choice", question: "Continue?", options: [] }],
      sessionKey: fixture.params.sessionKey!,
      timeoutMs: 60_000,
      gatewayCall,
      delivery: { onBlockReply },
      signal: controller.signal,
    });
    try {
      await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledOnce(), fastWait);
      expect(onAttemptTimeout).not.toHaveBeenCalled();
      const accepted = queueMedia(fixture, "yes", {
        debounceMs: 0,
        isInboundUserMessage: true,
        toolAuthorityFingerprint: fixture.params.toolAuthorityFingerprint,
      });
      await expect(question).resolves.toEqual(result);
      await waitForAcceptance(accepted, true);
      expect(onAttemptTimeout).not.toHaveBeenCalled();
      expect(steers(harness)).toEqual([]);
    } finally {
      closeHost();
      answer.resolve(result);
      await question;
    }
  });
});

it("rejects a outside-workspace structured image before dispatch or persistence", async () => {
  const fixture = await createMediaFixture("offloaded");
  fixture.params.config = { ...fixture.params.config, tools: { fs: { workspaceOnly: true } } };
  const imagePath = path.join(await fs.realpath(tempDir), "unavailable.png");
  await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 }));
  fixture.options.media = [{ path: imagePath, contentType: "image/png" }];
  fixture.options.imageOrder = ["offloaded"];
  fixture.message["__openclaw"] = { media: fixture.options.media };
  fixture.options.userTurnTranscriptRecorder = fixture.recorder;
  await withActiveMediaTurn(fixture, async (harness) => {
    const accepted = queueMedia(fixture, "inspect this");
    await waitForAcceptance(accepted, false);
    await expectUnpersisted(fixture, harness);
  });
});

it("keeps later text behind the reserved image preparation slot", async () => {
  const fixture = await createMediaFixture("resolved");
  const prepared = createDeferred<UserMessage>();
  fixture.recorder.resolveMessage.mockImplementation(() => prepared.promise);
  await withActiveMediaTurn(fixture, async (harness) => {
    try {
      const firstAccepted = queueMedia(fixture, "first image");
      await vi.waitFor(
        () => expect(fixture.recorder.resolveMessage).toHaveBeenCalledOnce(),
        fastWait,
      );
      const secondAccepted = queueMedia(fixture, "later text", { debounceMs: 0 });
      expect(steers(harness)).toEqual([]);
      prepared.resolve(fixture.message);
      await waitForAcceptance(secondAccepted, true);
      expect(firstAccepted).toHaveBeenCalledExactlyOnceWith(true);
      const requests = steers(harness);
      expect(requests.map((entry) => entry.input)).toEqual([
        [{ type: "text", text: "first image", text_elements: [] }, ...fixture.expectedImages],
        [{ type: "text", text: "later text", text_elements: [] }],
      ]);
      expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
      for (const steer of requests) {
        await notifyConsumed(harness, steer.clientUserMessageId);
      }
      expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
    } finally {
      prepared.resolve(fixture.message);
    }
  });
});

it("leaves rejected steering intact for a caller-owned fallback consumer", async () => {
  const fixture = await createMediaFixture("mixed");
  await withActiveMediaTurn(
    fixture,
    async (harness) => {
      const originalText = "  preserve this caption\n";
      const originalOptions = { ...fixture.options, userTurnTranscriptRecorder: fixture.recorder };
      const copyPayload = (text: string, { images, imageOrder, media }: QueueOptions) =>
        structuredClone({ text, images, imageOrder, media });
      const expectedPayload = copyPayload(originalText, originalOptions);
      // The SDK exposes eligibility plus acceptance, not the Gateway fallback dispatcher.
      // Consume the actual retained inputs after rejection; do not compare an object to itself.
      const fallback = vi.fn(async (text: string, options: QueueOptions) => ({
        payload: copyPayload(text, options),
        recorder: options.userTurnTranscriptRecorder,
        hydrated: await detectAndLoadAgentHarnessPromptImages({
          prompt: text,
          existingImages: options.images,
          imageOrder: options.imageOrder,
          media: options.media,
          workspaceDir: fixture.params.workspaceDir,
          model: fixture.params.model,
          workspaceOnly: true,
        }),
      }));
      let fallbackResult: ReturnType<typeof fallback> | undefined;
      const accepted = vi.fn((value: boolean) => {
        if (!value) {
          fallbackResult = fallback(originalText, originalOptions);
        }
      });
      expect(
        queueAgentHarnessMessage(fixture.params.sessionId, originalText, {
          ...originalOptions,
          onQueueAccepted: accepted,
        }),
      ).toBe(true);
      await waitForAcceptance(accepted, false);
      const result = await fallbackResult;
      expect(result?.payload).toEqual(expectedPayload);
      expect(result?.recorder).toBe(fixture.recorder);
      expect(
        result?.hydrated.images.map((image) => ({
          type: image.type,
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ).toEqual(fixture.expectedImages);
      expect(result?.hydrated.loadedCount).toBe(2);
      expect(fallback).toHaveBeenCalledOnce();
      const [steer] = steers(harness);
      await notifyConsumed(harness, steer.clientUserMessageId);
      expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
      expect(await fixture.readSteeredMessages()).toEqual([fixture.message]);
      await result?.recorder?.persistApproved();
      expect(await fixture.readSteeredMessages()).toEqual([fixture.message]);
    },
    async (method) => {
      if (method === "turn/steer") {
        throw new Error("no active turn to steer");
      }
    },
  );
});

it("does not consume an offloaded image caption as a pending text-only answer", async () => {
  const fixture = await createMediaFixture("offloaded");
  fixture.params.onBlockReply = vi.fn();
  await withActiveMediaTurn(fixture, async (harness) => {
    const response = harness.handleServerRequest({
      id: "request-image-answer",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "ask-image-answer",
        isBlocking: true,
        questions: [
          {
            id: "answer",
            header: "Answer",
            question: "Enter an answer",
            isSecret: true,
            isOther: false,
            options: null,
          },
        ],
      },
    });
    await vi.waitFor(() => expect(fixture.params.onBlockReply).toHaveBeenCalledOnce(), fastWait);
    const accepted = queueMedia(fixture, "image caption");
    await waitForAcceptance(accepted, true);
    await expect(response).resolves.toEqual({ answers: {} });
    const [steer] = steers(harness);
    expect(steer?.input).toEqual([
      { type: "text", text: "image caption", text_elements: [] },
      ...fixture.expectedImages,
    ]);
    await notifyConsumed(harness, steer.clientUserMessageId);
  });
});
