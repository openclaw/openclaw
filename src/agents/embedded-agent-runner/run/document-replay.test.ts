import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveProviderContext,
  type ProviderContext,
} from "../../../../packages/ai/src/provider-types.js";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { buildForkedChildTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-parent-fork.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { prepareFileContextFromMedia } from "../../../media-understanding/file-context.js";
import { attachRuntimePromptMediaFacts, type MediaFact } from "../../../media/media-facts.js";
import { Agent, type AgentMessage, type StreamFn } from "../../runtime/index.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../../test-helpers/agent-message-fixtures.js";
import {
  installModelPromptTransform,
  normalizeMessagesForLlmBoundary,
} from "./attempt-llm-boundary.js";
import { installHistoryImagePruneContextTransform } from "./history-image-prune.js";
import { materializeProviderContext } from "./images.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";

const extractPdf = vi.hoisted(() => vi.fn());
vi.mock("../../../media/pdf-extract.js", () => ({ extractPdfContent: extractPdf }));
afterEach(() => extractPdf.mockReset());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const model: Parameters<StreamFn>[0] = {
  id: "synthetic",
  name: "Synthetic",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text", "image"],
  contextWindow: 32768,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function user(media: MediaFact[], content = "", timestamp = 1): AgentMessage {
  return castAgentMessage({ role: "user", content, timestamp, __openclaw: { media } });
}
function fixture(workspaceDir: string, config?: OpenClawConfig, assertCurrent?: () => void) {
  const userTranscriptContexts: Array<{
    runtimeMessage: AgentMessage;
    transcriptMessage: AgentMessage;
  }> = [];
  const requests: ProviderContext[] = [];
  const stream: StreamFn = (_model, context, options) => {
    const output = createAssistantMessageEventStream();
    void resolveProviderContext(context, options).then(
      (prepared) => {
        requests.push(prepared);
        output.push({
          type: "done",
          reason: "stop",
          message: makeAgentAssistantMessage({ content: [{ type: "text", text: "Noted." }] }),
        });
        output.end();
      },
      (error: unknown) => {
        output.push({
          type: "error",
          reason: "error",
          error: makeAgentAssistantMessage({
            content: [],
            stopReason: "error",
            errorMessage: String(error),
          }),
        });
        output.end();
      },
    );
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
  const convertToLlm = agent.convertToLlm.bind(agent);
  agent.convertToLlm = (messages) => convertToLlm(normalizeMessagesForLlmBoundary(messages));
  const cleanup = installHistoryImagePruneContextTransform(agent, {
    workspaceDir,
    model,
    workspaceOnly: true,
    config,
    assertCurrent,
    getUserTranscriptContexts: () => userTranscriptContexts,
  });
  return { agent, requests, cleanup, userTranscriptContexts };
}

describe("native document replay", () => {
  it.each(["next turn", "fork"])(
    "restores suppressed paste text at the %s provider boundary without rewriting history",
    async (route) => {
      const workspaceDir = tempDirs.make("openclaw-document-replay-");
      const file = path.join(workspaceDir, "brief.txt");
      await fs.writeFile(file, "Synthetic replay sentinel: remember the blue lighthouse.");
      const original = user([
        {
          path: file,
          contentType: "text/plain",
          kind: "document",
          origin: "paste",
          hydrationSuppressed: true,
        },
      ]);
      const assistant = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Noted." }],
        timestamp: 2,
      });
      const entries = [original, assistant].map((message, index) => ({
        type: "message",
        id: String(index),
        parentId: index ? "0" : null,
        timestamp: "2026-01-01T00:00:00Z",
        message,
      }));
      const fork = buildForkedChildTranscriptEvents({
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
      });
      const history =
        route === "fork"
          ? fork.flatMap((entry) =>
              typeof entry === "object" && entry !== null && "message" in entry
                ? [castAgentMessage(entry.message)]
                : [],
            )
          : [original, assistant];
      const serialized = JSON.stringify(history);
      const { agent, requests, cleanup } = fixture(workspaceDir);
      try {
        agent.state.messages = history.slice();
        await agent.prompt("What did the brief say?");
        const text = JSON.stringify(requests[0]?.messages[0]);
        expect(text).toContain("remember the blue lighthouse");
        expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
        expect(text.match(/remember the blue lighthouse/g)).toHaveLength(1);
        expect(JSON.stringify(history)).toBe(serialized);
        expect(JSON.stringify(agent.state.messages.slice(0, history.length))).toBe(serialized);
      } finally {
        cleanup();
      }
    },
  );

  it.each([
    { pdfFirst: false, video: false, inline: false, photoSuppressed: false },
    { pdfFirst: true, video: false, inline: false, photoSuppressed: false },
    { pdfFirst: false, video: true, inline: false, photoSuppressed: false },
    { pdfFirst: true, video: true, inline: false, photoSuppressed: false },
    { pdfFirst: false, video: false, inline: true, photoSuppressed: false },
    { pdfFirst: true, video: false, inline: true, photoSuppressed: false },
    { pdfFirst: false, video: false, inline: false, photoSuppressed: true },
  ])(
    "preserves photo/PDF identity: PDF first=$pdfFirst, video=$video, inline=$inline, described=$photoSuppressed",
    async ({ pdfFirst, video, inline, photoSuppressed }) => {
      const workspaceDir = tempDirs.make("openclaw-document-pages-");
      const photo = path.join(workspaceDir, "photo.png");
      const pdf = path.join(workspaceDir, "scan.pdf");
      const page = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 0 }).toString("base64");
      await fs.writeFile(photo, Buffer.from(PNG, "base64"));
      await fs.writeFile(pdf, "%PDF-1.4\n");
      extractPdf.mockResolvedValue({
        text: "",
        images: [{ type: "image", data: page, mimeType: "image/png" }],
      });
      const media: MediaFact[] = [
        { path: photo, contentType: "image/png", hydrationSuppressed: photoSuppressed },
        { path: pdf, contentType: "application/pdf", hydrationSuppressed: true },
      ];
      if (pdfFirst) {
        media.reverse();
      }
      if (video) {
        const clip = path.join(workspaceDir, "clip.mp4");
        await fs.writeFile(
          clip,
          Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex"),
        );
        media.splice(1, 0, { path: clip, contentType: "video/mp4" });
      }
      const slots = media.flatMap((fact, factIndex) =>
        fact.contentType === "video/mp4"
          ? []
          : [
              {
                kind: "inline",
                ...(fact.contentType === "image/png" ? { factIndex } : {}),
              },
            ],
      );
      const original = castAgentMessage({
        role: "user",
        content: inline
          ? [
              { type: "text", text: "Compare the attachments" },
              { type: "image", data: PNG, mimeType: "image/png" },
            ]
          : "Compare the attachments",
        timestamp: 1,
        __openclaw: {
          media,
          mediaImageLayout: {
            slots,
            ...(photoSuppressed ? { suppressedFactIndexes: [0] } : {}),
          },
        },
      });
      const serialized = JSON.stringify(original);
      const { agent, requests, cleanup } = fixture(workspaceDir);
      try {
        agent.state.messages = [original, makeAgentAssistantMessage({ content: [] })];
        await agent.prompt("Which one is the photograph?");
        const message = requests[0]?.messages[0];
        if (message?.role !== "user" || !Array.isArray(message.content)) {
          throw new Error("Expected provider user content");
        }
        const bytes = message.content.flatMap((block) =>
          block.type === "image" ? [block.data] : [],
        );
        expect(bytes).toEqual(photoSuppressed ? [page] : pdfFirst ? [page, PNG] : [PNG, page]);
        if (video) {
          expect(
            message.content.filter((block) => block.type !== "text").map((block) => block.type),
          ).toEqual(["image", "video", "image"]);
        }
        expect(JSON.stringify(original)).toBe(serialized);
      } finally {
        cleanup();
      }
    },
  );

  it("preserves captions, runtime mixed-media facts, order, and stable tool-loop bytes", async () => {
    const workspaceDir = tempDirs.make("openclaw-document-mixed-");
    const note = path.join(workspaceDir, "note.txt");
    const image = path.join(workspaceDir, "photo.png");
    await fs.writeFile(note, "first document body");
    await fs.writeFile(image, Buffer.from(PNG, "base64"));
    const message = attachRuntimePromptMediaFacts(
      user([], "caption with <file>literal markup</file>"),
      [
        { path: note, contentType: "text/plain" },
        { path: image, contentType: "image/png" },
      ],
    );
    const { agent, cleanup } = fixture(workspaceDir);
    try {
      const first = await agent.transformContext!([message]);
      await fs.writeFile(note, "changed source must not rewrite the warm prefix");
      const second = await agent.transformContext!([
        message,
        makeAgentAssistantMessage({ content: [] }),
      ]);
      expect(second[0]).toEqual(first[0]);
      const projectedUser = first[0];
      if (projectedUser?.role !== "user") {
        throw new Error("Expected the projected user turn");
      }
      const content = projectedUser.content;
      expect(content).toEqual([
        { type: "text", text: "caption with <file>literal markup</file>" },
        { type: "text", text: expect.stringContaining("first document body") },
        { type: "image", data: PNG, mimeType: "image/png" },
      ]);
    } finally {
      cleanup();
    }
  });

  it("does not duplicate the current live projection or revive pruned documents", async () => {
    const workspaceDir = tempDirs.make("openclaw-document-live-");
    const file = path.join(workspaceDir, "brief.txt");
    await fs.writeFile(file, "live document body");
    const media: MediaFact[] = [
      { path: file, contentType: "text/plain", hydrationSuppressed: true },
    ];
    const live = await prepareFileContextFromMedia({
      media,
      workspaceDir,
      config: {},
      maxChars: 60000,
      assertCurrent: () => {},
    });
    const { agent, requests, cleanup, userTranscriptContexts } = fixture(workspaceDir);
    const restore = installModelPromptTransform({
      session: { agent },
      transcriptPrompt: "caption",
      modelPrompt: "caption\n\n" + live.text,
      shouldCapturePrompt: () => true,
    });
    try {
      await agent.prompt(user(media, "caption"));
      expect(JSON.stringify(requests[0]).match(/live document body/g)).toHaveLength(1);
      restore();
      const steered = attachRuntimePromptMediaFacts(user([], "caption\n\n" + live.text, 2), media);
      userTranscriptContexts.push({
        runtimeMessage: steered,
        transcriptMessage: user(media, "caption", 2),
      });
      const steerProjection = await agent.transformContext!([steered]);
      expect(JSON.stringify(steerProjection).match(/live document body/g)).toHaveLength(1);
      const history = [
        user(media),
        ...Array.from({ length: 4 }, (_, index) => [
          makeAgentAssistantMessage({ content: [] }),
          user([], "later", index + 2),
        ]).flat(),
      ];
      const projected = await agent.transformContext!(history);
      expect(JSON.stringify(projected[0])).not.toContain("live document body");
      expect(JSON.stringify(history[0])).toContain("brief.txt");
    } finally {
      cleanup();
    }
  });

  it("keeps inaccessible, oversized, empty, and policy-rejected outcomes visible", async () => {
    const workspaceDir = tempDirs.make("openclaw-document-outcomes-");
    const outside = tempDirs.make("openclaw-document-outside-");
    await fs.writeFile(path.join(outside, "blocked.txt"), "outside sentinel");
    await fs.writeFile(path.join(workspaceDir, "large.txt"), "x".repeat(80));
    await fs.writeFile(path.join(workspaceDir, "empty.txt"), "");
    const config = { gateway: { http: { endpoints: { responses: { files: { maxBytes: 32 } } } } } };
    const { agent, cleanup } = fixture(workspaceDir, config);
    try {
      const projected = await agent.transformContext!([
        user([
          { path: path.join(outside, "blocked.txt"), contentType: "text/plain" },
          { path: path.join(workspaceDir, "large.txt"), contentType: "text/plain" },
          { path: path.join(workspaceDir, "empty.txt"), contentType: "text/plain" },
        ]),
      ]);
      const text = JSON.stringify(projected);
      expect(text).not.toContain("outside sentinel");
      expect(text).not.toContain("x".repeat(80));
      expect(text.match(/could not be read/g)).toHaveLength(2);
      expect(text).toContain("No extractable text");
    } finally {
      cleanup();
    }
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "policy sentinel");
    const rejected = fixture(workspaceDir, {
      gateway: {
        http: { endpoints: { responses: { files: { allowedMimes: ["application/pdf"] } } } },
      },
    });
    try {
      const projected = await rejected.agent.transformContext!([
        user([{ path: path.join(workspaceDir, "note.txt"), contentType: "text/plain" }]),
      ]);
      expect(JSON.stringify(projected)).not.toContain("policy sentinel");
      expect(JSON.stringify(projected)).toContain("Attachment type not allowed: text/plain");
    } finally {
      rejected.cleanup();
    }
  });

  it("shares the configured document text budget and rejects cancelled projection", async () => {
    const workspaceDir = tempDirs.make("openclaw-document-budget-");
    await fs.writeFile(path.join(workspaceDir, "one.txt"), "a".repeat(32));
    await fs.writeFile(path.join(workspaceDir, "two.txt"), "b".repeat(32));
    const config = { gateway: { http: { endpoints: { responses: { files: { maxChars: 16 } } } } } };
    const { agent, cleanup } = fixture(workspaceDir, config);
    const message = user(
      ["one.txt", "two.txt"].map((name) => ({
        path: path.join(workspaceDir, name),
        contentType: "text/plain",
      })),
    );
    try {
      const projected = await agent.transformContext!([message]);
      expect(JSON.stringify(projected)).toContain("a".repeat(16));
      expect(JSON.stringify(projected)).not.toContain("b".repeat(16));
      expect(JSON.stringify(projected)).not.toContain("a".repeat(17));
      expect(JSON.stringify(projected)).not.toContain("\\n---\\nb");
      expect(JSON.stringify(projected)).toContain("[Partial document: text truncated.]");
      const controller = new AbortController();
      controller.abort(new Error("cancelled replay"));
      await expect(agent.transformContext!([message], controller.signal)).rejects.toThrow(
        "cancelled replay",
      );
      const retained = agent.transformContext!;
      cleanup();
      await expect(retained([message])).rejects.toThrow("no longer active");
    } finally {
      cleanup();
    }
  });
});
