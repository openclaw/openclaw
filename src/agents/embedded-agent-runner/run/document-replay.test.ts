import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  resolveProviderContext,
  type ProviderContext,
} from "../../../../packages/ai/src/provider-types.js";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { buildForkedChildTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-parent-fork.js";
import type { OpenClawConfig } from "../../../config/types.js";
import * as fsSafe from "../../../infra/fs-safe.js";
import { prepareFileContextFromMedia } from "../../../media-understanding/file-context.js";
import { attachRuntimePromptMediaFacts, type MediaFact } from "../../../media/media-facts.js";
import { saveMediaBuffer } from "../../../media/store.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { bindHarnessContextMedia } from "../../harness/context-media.js";
import { Agent, type AgentMessage, type StreamFn } from "../../runtime/index.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import {
  installModelPromptTransform,
  normalizeMessagesForLlmBoundary,
} from "./attempt-llm-boundary.js";
import { installHistoryImagePruneContextTransform } from "./history-image-prune.js";
import { materializeProviderContext } from "./images.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";

const extractPdf = vi.hoisted(() => vi.fn());
vi.mock("../../../media/pdf-extract.js", () => ({ extractPdfContent: extractPdf }));
afterEach(() => {
  extractPdf.mockReset();
  vi.restoreAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PNG = createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 }).toString("base64");
const PAGE = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 0 }).toString("base64");
const SECOND_PAGE = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 }).toString("base64");
const model = makeProviderModelFixture({
  id: "synthetic",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  input: ["text", "image"],
});
const replayRoutes = ["native", "plugin-host"] as const;
const assistant = () => makeAgentAssistantMessage({ content: [], timestamp: 2 });
function user(media: MediaFact[], text = "", timestamp = 1): AgentMessage {
  return castAgentMessage(buildPersistedUserTurnMessage({ media, text, timestamp }));
}
async function writeMedia(
  root: string,
  name: string,
  data: string | Buffer,
  contentType = "text/plain",
) {
  const file = path.join(root, name);
  await fs.writeFile(file, data);
  return { path: file, contentType };
}
async function prepareHostMedia(workspaceDir: string, message: AgentMessage, maxChars = 60000) {
  const prepare = bindHarnessContextMedia({
    attempt: { workspaceDir, model },
    config: {},
    assertActive: () => {},
  });
  if (!prepare) {
    throw new Error("Expected the host media capability");
  }
  const original = structuredClone(message);
  const context = await prepare({ message, maxChars });
  expect(message).toEqual(original);
  return context;
}
function fixture(
  workspaceDir = tempDirs.make("openclaw-document-replay-"),
  config?: OpenClawConfig,
) {
  const userTranscriptContexts: Array<{
    runtimeMessage: AgentMessage;
    transcriptMessage: AgentMessage;
  }> = [];
  const requests: ProviderContext[] = [];
  const stream: StreamFn = async (_model, context, options) => {
    requests.push(await resolveProviderContext(context, options));
    const output = createAssistantMessageEventStream();
    output.push({ type: "done", reason: "stop", message: assistant() });
    output.end();
    return output;
  };
  const agent = new Agent({
    initialState: { model },
    transformContext: async (messages) => messages,
    streamFn: wrapStreamFnWithMessageTransform(
      stream,
      (messages) => messages,
      (input) => materializeProviderContext({ ...input, workspaceDir, workspaceOnly: true }),
    ),
  });
  const convert = agent.convertToLlm.bind(agent);
  agent.convertToLlm = (messages) => convert(normalizeMessagesForLlmBoundary(messages));
  const cleanup = installHistoryImagePruneContextTransform(agent, {
    workspaceDir,
    model,
    workspaceOnly: true,
    config,
    getUserTranscriptContexts: () => userTranscriptContexts,
  });
  onTestFinished(cleanup);
  const project = agent.transformContext;
  if (!project) {
    throw new Error("Replay transform was not installed");
  }
  return {
    agent,
    requests,
    cleanup,
    project,
    userTranscriptContexts,
    workspaceDir,
    file: (name: string, data: string | Buffer, mime?: string) =>
      writeMedia(workspaceDir, name, data, mime),
    async replay(history: AgentMessage[]) {
      const serialized = JSON.stringify(history);
      agent.state.messages = history.slice();
      await agent.prompt("Read the attachments");
      expect(JSON.stringify(history)).toBe(serialized);
      expect(JSON.stringify(agent.state.messages.slice(0, history.length))).toBe(serialized);
      const message = requests.at(-1)?.messages[0];
      if (message?.role !== "user" || !Array.isArray(message.content)) {
        throw new Error("Expected provider user content");
      }
      return message.content;
    },
  };
}

function forkHistory(history: AgentMessage[]): AgentMessage[] {
  const entries = history.map((message, index) => ({
    type: "message",
    id: String(index),
    parentId: index ? String(index - 1) : null,
    timestamp: "2026-01-01T00:00:00Z",
    message,
  }));
  return buildForkedChildTranscriptEvents({
    parentSessionFile: "synthetic-parent",
    targetSessionId: "synthetic-child",
    source: {
      version: 4,
      branchEntries: entries,
      appendParentId: "1",
      leafId: "1",
      labelsToWrite: [],
      preserveLeafControl: false,
    },
  }).flatMap((entry) =>
    typeof entry === "object" && entry !== null && "message" in entry
      ? [castAgentMessage(entry.message)]
      : [],
  );
}

describe("native document replay", () => {
  it.each(
    [
      { fork: false, relocated: false, alias: false },
      { fork: true, relocated: false, alias: false },
      { fork: false, relocated: true, alias: false },
      { fork: true, relocated: true, alias: false },
      { fork: true, relocated: true, alias: true },
    ].flatMap((scenario) => replayRoutes.map((route) => ({ ...scenario, route }))),
  )(
    "authorizes saved documents via $route (fork=$fork, relocated=$relocated, alias=$alias)",
    async ({ fork, relocated, alias, route }) => {
      const f = fixture();
      const source = relocated ? tempDirs.make("openclaw-former-workspace-") : f.workspaceDir;
      const file = await writeMedia(source, "brief.txt", "remember the blue lighthouse");
      if (relocated) {
        await f.file("brief.txt", "current-workspace decoy must not replace the saved file");
      }
      const recorded = alias
        ? path.join(tempDirs.make("openclaw-former-alias-"), "workspace")
        : source;
      if (alias) {
        await fs.symlink(source, recorded, process.platform === "win32" ? "junction" : "dir");
      }
      const history = [
        user([
          {
            path: "brief.txt",
            workspaceDir: recorded,
            contentType: "text/plain",
            kind: "document",
            origin: "paste",
            hydrationSuppressed: true,
          },
        ]),
        assistant(),
      ];
      const open = vi.spyOn(fsSafe, "openLocalFileSafely");
      const retained = fork ? forkHistory(history) : history;
      const [message] = retained;
      if (!message) {
        throw new Error("Expected the retained user message");
      }
      const text = JSON.stringify(
        route === "plugin-host"
          ? await prepareHostMedia(f.workspaceDir, message)
          : await f.replay(retained),
      );
      const opened = open.mock.calls.map(([input]) => input.filePath);
      if (relocated) {
        expect(open).not.toHaveBeenCalled();
        expect(text).not.toContain("remember the blue lighthouse");
        expect(text).toContain("could not be read");
      } else {
        expect(opened).toContain(file.path);
        expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
        expect(text.match(/remember the blue lighthouse/g)).toHaveLength(1);
      }
    },
  );

  it.each(replayRoutes)(
    "keeps managed uploads readable without a former workspace grant (%s)",
    async (route) => {
      const stateDir = tempDirs.make("openclaw-managed-document-");
      const workspaceDir = path.join(stateDir, "sandboxes", "current");
      const formerWorkspace = path.join(stateDir, "sandboxes", "former");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(formerWorkspace, { recursive: true });
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      onTestFinished(() => env.restore());
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const saved = await saveMediaBuffer(Buffer.from("admitted upload sentinel"), "text/plain");
      const open = vi.spyOn(fsSafe, "openLocalFileSafely");
      const message = user([
        {
          url: `media://inbound/${saved.id}`,
          workspaceDir: formerWorkspace,
          contentType: "text/plain",
          hydrationSuppressed: true,
        },
      ]);
      const content =
        route === "plugin-host"
          ? await prepareHostMedia(workspaceDir, message)
          : await fixture(workspaceDir).replay([message, assistant()]);
      expect(JSON.stringify(content)).toContain("admitted upload sentinel");
      expect(open.mock.calls.map(([input]) => input.filePath)).toContain(saved.path);
    },
  );

  it.each([
    { pdfFirst: false, video: false, inline: false, described: false, exhausted: false },
    { pdfFirst: true, video: false, inline: false, described: false, exhausted: false },
    { pdfFirst: false, video: true, inline: false, described: false, exhausted: false },
    { pdfFirst: true, video: true, inline: false, described: false, exhausted: false },
    { pdfFirst: false, video: false, inline: true, described: false, exhausted: false },
    { pdfFirst: true, video: false, inline: true, described: false, exhausted: false },
    { pdfFirst: false, video: false, inline: false, described: true, exhausted: false },
    { pdfFirst: false, video: false, inline: false, described: false, exhausted: true },
  ])(
    "preserves photo/PDF identity: $pdfFirst/$video/$inline/$described/$exhausted",
    async ({ pdfFirst, video, inline, described, exhausted }) => {
      const f = fixture(
        undefined,
        exhausted
          ? { gateway: { http: { endpoints: { responses: { files: { maxChars: 4 } } } } } }
          : undefined,
      );
      const photo = await f.file("photo.png", Buffer.from(PNG, "base64"), "image/png");
      const pdf = await f.file("scan.pdf", "%PDF-1.4\n", "application/pdf");
      const pages = exhausted ? [PAGE, SECOND_PAGE] : [PAGE];
      extractPdf.mockResolvedValue({
        text: "",
        images: pages.map((data) => ({ type: "image", data, mimeType: "image/png" })),
      });
      const media: MediaFact[] = [
        { ...photo, hydrationSuppressed: described },
        { ...pdf, hydrationSuppressed: true },
      ];
      if (pdfFirst) {
        media.reverse();
      }
      if (video) {
        media.splice(
          1,
          0,
          await f.file(
            "clip.mp4",
            Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex"),
            "video/mp4",
          ),
        );
      }
      if (exhausted) {
        media.unshift(await f.file("before.txt", "full"));
      }
      const slots = media.flatMap((fact, factIndex) =>
        fact.contentType === "image/png" || fact.contentType === "application/pdf"
          ? [{ kind: "inline", ...(fact.contentType === "image/png" ? { factIndex } : {}) }]
          : [],
      );
      const original = castAgentMessage({
        ...user(media, "Compare the attachments"),
        ...(inline
          ? {
              content: [
                { type: "text", text: "Compare the attachments" },
                { type: "image", data: PNG, mimeType: "image/png" },
              ],
            }
          : {}),
        __openclaw: {
          media,
          mediaImageLayout: { slots, ...(described ? { suppressedFactIndexes: [0] } : {}) },
        },
      });
      const content = await f.replay([original, assistant()]);
      expect(content.flatMap((block) => (block.type === "image" ? [block.data] : []))).toEqual(
        described ? pages : pdfFirst ? [...pages, PNG] : [PNG, ...pages],
      );
      if (video) {
        expect(content.filter((block) => block.type !== "text").map((block) => block.type)).toEqual(
          ["image", "video", "image"],
        );
      }
      if (exhausted) {
        expect(JSON.stringify(content)).toContain("full");
      }
    },
  );

  it("preserves runtime media, captions, and stable tool-loop bytes", async () => {
    const f = fixture();
    const note = await f.file("note.txt", "first document body");
    const photo = await f.file("photo.png", Buffer.from(PNG, "base64"), "image/png");
    const message = attachRuntimePromptMediaFacts(
      user([], "caption with <file>literal markup</file>"),
      [note, photo],
    );
    const first = await f.project([message]);
    await fs.writeFile(note.path, "changed source must not rewrite the warm prefix");
    expect((await f.project([message, assistant()]))[0]).toEqual(first[0]);
    const projectedUser = first[0];
    if (projectedUser?.role !== "user") {
      throw new Error("Expected projected user content");
    }
    expect(projectedUser.content).toEqual([
      { type: "text", text: "caption with <file>literal markup</file>" },
      { type: "text", text: expect.stringContaining("first document body") },
      { type: "image", data: PNG, mimeType: "image/png" },
    ]);
  });

  it.each([false, true])(
    "deduplicates live/steering context and prunes documents (blocks=%s)",
    async (blocks) => {
      const f = fixture();
      const media = [
        { ...(await f.file("brief.txt", "live document body")), hydrationSuppressed: true },
      ];
      const live = await prepareFileContextFromMedia({
        media,
        workspaceDir: f.workspaceDir,
        config: {},
        maxChars: 60000,
        assertCurrent: () => {},
      });
      const restore = installModelPromptTransform({
        session: { agent: f.agent },
        transcriptPrompt: "caption",
        modelPrompt: "caption\n\n" + live.text,
        shouldCapturePrompt: () => true,
      });
      onTestFinished(restore);
      await f.agent.prompt(user(media, "caption"));
      expect(JSON.stringify(f.requests[0]).match(/live document body/g)).toHaveLength(1);
      restore();
      const steered = attachRuntimePromptMediaFacts(
        Object.assign(user([], "", 2), {
          content: blocks
            ? [
                { type: "text" as const, text: "caption" },
                { type: "text" as const, text: live.text },
              ]
            : "caption\n\n" + live.text,
        }),
        media,
      );
      f.userTranscriptContexts.push({
        runtimeMessage: steered,
        transcriptMessage: user(media, "caption", 2),
      });
      expect(JSON.stringify(await f.project([steered])).match(/live document body/g)).toHaveLength(
        1,
      );
      const history = [
        user(media),
        ...Array.from({ length: 4 }, (_, index) => [
          assistant(),
          user([], "later", index + 2),
        ]).flat(),
      ];
      expect(JSON.stringify((await f.project(history))[0])).not.toContain("live document body");
      expect(JSON.stringify(history[0])).toContain("brief.txt");
    },
  );

  it("surfaces read, size, empty-file, and MIME policy outcomes", async () => {
    const f = fixture(undefined, {
      gateway: { http: { endpoints: { responses: { files: { maxBytes: 32 } } } } },
    });
    const media = [
      await writeMedia(
        tempDirs.make("openclaw-document-outside-"),
        "blocked.txt",
        "outside sentinel",
      ),
      await f.file("large.txt", "x".repeat(80)),
      await f.file("empty.txt", ""),
    ];
    const text = JSON.stringify(await f.project([user(media)]));
    expect(text).not.toContain("outside sentinel");
    expect(text).not.toContain("x".repeat(80));
    expect(text.match(/could not be read/g)).toHaveLength(2);
    expect(text).toContain("No extractable text");
    const rejected = fixture(f.workspaceDir, {
      gateway: {
        http: { endpoints: { responses: { files: { allowedMimes: ["application/pdf"] } } } },
      },
    });
    const projected = JSON.stringify(
      await rejected.project([user([await f.file("note.txt", "policy sentinel")])]),
    );
    expect(projected).not.toContain("policy sentinel");
    expect(projected).toContain("Attachment type not allowed: text/plain");
  });

  it("keeps the plugin host character limit per file", async () => {
    const workspaceDir = tempDirs.make("openclaw-harness-documents-");
    const message = user([
      await writeMedia(workspaceDir, "one.txt", "aaaaX"),
      await writeMedia(workspaceDir, "two.txt", "bbbbY"),
    ]);
    const context = await prepareHostMedia(workspaceDir, message, 4);
    expect(context.text).toContain("\n---\naaaa\n");
    expect(context.text).toContain("\n---\nbbbb\n");
    expect(context.text).not.toContain("aaaaX");
    expect(context.text).not.toContain("bbbbY");
  });

  it("shares the text budget and rejects cancelled or disposed projection", async () => {
    const f = fixture(undefined, {
      gateway: { http: { endpoints: { responses: { files: { maxChars: 16 } } } } },
    });
    const message = user([
      await f.file("one.txt", "a".repeat(32)),
      await f.file("two.txt", "b".repeat(32)),
    ]);
    const text = JSON.stringify(await f.project([message]));
    expect(text).toContain("a".repeat(16));
    expect(text).not.toContain("b".repeat(16));
    expect(text).not.toContain("a".repeat(17));
    expect(text).not.toContain("\\n---\\nb");
    expect(text).toContain("[Partial document: text truncated.]");
    await expect(
      f.project([message], AbortSignal.abort(new Error("cancelled replay"))),
    ).rejects.toThrow("cancelled replay");
    f.cleanup();
    await expect(f.project([message])).rejects.toThrow("no longer active");
  });
});
