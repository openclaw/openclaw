import { writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { transformMessages } from "../../../packages/ai/src/transcript-transform.ts";
import type { AssistantMessage, Model } from "../../../packages/ai/src/types.ts";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { waitForControlUiGatewayReady } from "../../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  navigateToControlUiSession,
} from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  authenticateControlUi as authenticate,
  captureControlUi,
  controlUiPageOptions,
  historyMessages,
  startControlUiGateway,
  writeControlUiVerdict,
} from "./control-ui-gateway.e2e.test-support.ts";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI media transcript replay with a real Gateway",
  startServerBeforeBrowser: true,
});

const retainedImageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsHeERQyjAWRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0B06OyaOxP7RwAAAAASUVORK5CYII=";
const replayModel: Model<"openai-responses"> = {
  id: "gpt-5.6-luna",
  name: "Mock OpenAI",
  api: "openai-responses",
  provider: "mock-openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

type PersistedAssistantMessage = AssistantMessage & {
  openclawDisplayContent?: Array<Record<string, unknown>>;
};

function startGateway(owner: ReturnType<typeof createQaLiveLaneGateway>) {
  return startControlUiGateway(owner, suite.server.baseUrl, {
    // Reuse the prepared runtime on restart; repository fixtures stage auth directly.
    command: {
      executablePath: process.execPath,
      argsPrefix: [path.join(process.cwd(), "openclaw.mjs")],
      cwd: process.cwd(),
      usePackagedPlugins: false,
    },
  });
}

const pageOptions = () => controlUiPageOptions(suite.artifactDir);
const screenshot = (page: Page, name: string) => captureControlUi(page, suite.artifactDir, name);

async function expectLoadedImage(image: Locator) {
  await image.waitFor({ state: "visible" });
  await expect
    .poll(() =>
      image.evaluate((element) => (element instanceof HTMLImageElement ? element.naturalWidth : 0)),
    )
    .toBe(64);
}

const writeVerdict = (verdict: unknown) => writeControlUiVerdict(suite.artifactDir, verdict);

async function send(page: Page, text: string) {
  await page.locator(".agent-chat__composer-combobox textarea").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function healthyReplay(readHistory: () => Promise<unknown>, text: string) {
  try {
    await expect
      .poll(async () => historyHasAssistantText(await readHistory(), text), {
        timeout: 30_000,
      })
      .toBe(true);
    return true;
  } catch {
    return false;
  }
}

async function createPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  );
  zip.file("ppt/presentation.xml", "<presentation/>");
  return await zip.generateAsync({ type: "nodebuffer" });
}

function historyHasAssistantText(history: unknown, text: string): boolean {
  return historyMessages(history).some(
    (message) =>
      asOptionalRecord(message)?.role === "assistant" &&
      JSON.stringify(asOptionalRecord(message)?.content).includes(text),
  );
}

function omittedCard(pane: Locator) {
  return pane.locator(".chat-assistant-attachment-card", { hasText: "Omitted from history" });
}

function imageInHistory(history: unknown): Record<string, unknown> | undefined {
  return historyMessages(history)
    .flatMap((message) => {
      const content = asOptionalRecord(message)?.content;
      return Array.isArray(content) ? content : [];
    })
    .map(asOptionalRecord)
    .find((block) => block?.type === "image");
}

function readRawAssistantMessages(stateDir: string): PersistedAssistantMessage[] {
  const database = openNodeSqliteDatabase(
    path.join(stateDir, "agents", "qa", "agent", "openclaw-agent.sqlite"),
    { readOnly: true },
  );
  try {
    const rows = database
      .prepare("SELECT event_json FROM transcript_events ORDER BY seq")
      .all() as Array<{ event_json: string }>;
    return rows.flatMap(({ event_json }) => {
      const message = (JSON.parse(event_json) as { message?: unknown }).message;
      return message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "assistant"
        ? [message as PersistedAssistantMessage]
        : [];
    });
  } finally {
    database.close();
  }
}

function readModelReplayError(messages: AssistantMessage[]): string | null {
  try {
    transformMessages(messages, replayModel);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

suite.define(() => {
  it("renders recoverable and omitted image history", { timeout: 180_000 }, async () => {
    const gatewayOwner = createQaLiveLaneGateway();
    const gateway = await startGateway(gatewayOwner);
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(gateway.gateway.tempRoot, "state"),
    };
    const seed = async (sessionId: string, image: Record<string, unknown>) => {
      const sessionKey = `agent:qa:${sessionId}`;
      const storePath = resolveStorePath(undefined, { agentId: "qa", env });
      const identity = { agentId: "qa", env, sessionKey, storePath };
      await upsertSessionEntry({
        ...identity,
        entry: { sessionId, updatedAt: Date.now() },
      });
      await appendSessionTranscriptMessageByIdentity({
        ...identity,
        sessionId,
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "image", mimeType: "image/png", ...image }],
        },
      });
    };
    const omittedSessionKey = "agent:qa:omitted-image-history";
    const recoveredSessionKey = "agent:qa:recovered-image-history";
    const retainedSessionKey = "agent:qa:retained-image-history";
    const retainedImageUrl = "https://example.invalid/retained-history-image.png";
    try {
      // Startup admits the fixture rows into the child Gateway's resident projection.
      await gateway.gateway.restartAfterStateMutation(async () => {
        await seed("omitted-image-history", { omitted: true, bytes: 12 * 1024 });
        await seed("recovered-image-history", { data: retainedImageBase64 });
        await seed("retained-image-history", { source: { type: "url", url: retainedImageUrl } });
      });
      const history = (sessionKey: string) =>
        gateway.gateway.call("chat.history", { sessionKey, limit: 10 });
      const omittedHistory = await history(omittedSessionKey);
      const recoveredHistory = await history(recoveredSessionKey);
      const retainedHistory = await history(retainedSessionKey);
      const omittedImage = imageInHistory(omittedHistory);
      const recoveredImage = imageInHistory(recoveredHistory);
      expect(omittedImage).toMatchObject({ omitted: true, bytes: 12 * 1024 });
      expect(omittedImage).not.toHaveProperty("artifactId");
      expect(recoveredImage).toMatchObject({ omitted: true, mimeType: "image/png" });
      expect(recoveredImage).not.toHaveProperty("data");
      expect(JSON.stringify(recoveredHistory)).not.toContain(retainedImageBase64);
      const artifactId = recoveredImage?.artifactId;
      if (typeof artifactId !== "string") {
        throw new Error("Persisted image history is missing its artifact reference");
      }
      const download = await gateway.gateway.call("artifacts.download", {
        sessionKey: recoveredSessionKey,
        artifactId,
      });
      expect(download).toMatchObject({
        artifact: { id: artifactId, type: "image", mimeType: "image/png" },
        encoding: "base64",
        data: retainedImageBase64,
      });
      expect(JSON.stringify(retainedHistory)).toContain(retainedImageUrl);

      await suite.withPage(pageOptions(), async ({ page }) => {
        await page.route(retainedImageUrl, (route) =>
          route.fulfill({
            contentType: "image/png",
            body: Buffer.from(retainedImageBase64, "base64"),
          }),
        );
        await authenticate(page, gateway.gateway);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, omittedSessionKey));
        const visiblePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const card = omittedCard(visiblePane);
        await card.waitFor({ state: "visible" });
        const omittedCardText = await card.textContent();
        const omittedInteractiveDescendantCount = await card
          .locator("a, button, img, audio, video")
          .count();
        expect(omittedInteractiveDescendantCount).toBe(0);
        await screenshot(page, "01-omitted-image.png");

        await navigateToControlUiSession(page, recoveredSessionKey);
        const recoveredPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const preview = recoveredPane.locator("img.chat-message-image");
        await expectLoadedImage(preview);
        expect(await omittedCard(recoveredPane).count()).toBe(0);
        await screenshot(page, "02-recovered-image.png");
        await recoveredPane.locator(".chat-message-image-button").press("Enter");
        const expanded = page.locator("openclaw-image-lightbox .image");
        await expectLoadedImage(expanded);
        await screenshot(page, "03-recovered-lightbox.png");
        await page.getByRole("button", { name: "Close image preview" }).click();
        await page.reload();
        await expectLoadedImage(preview);

        await navigateToControlUiSession(page, retainedSessionKey);
        const retainedPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const retainedPreview = retainedPane.locator(
          `img.chat-message-image[src="${retainedImageUrl}"]`,
        );
        await expectLoadedImage(retainedPreview);
        expect(await omittedCard(retainedPane).count()).toBe(0);
        await writeVerdict({
          gateway: {
            omittedHasMarker: JSON.stringify(omittedHistory).includes('"omitted":true'),
            recoveredArtifactId: artifactId,
            recoveredExcludesInlinePayload:
              !JSON.stringify(recoveredHistory).includes(retainedImageBase64),
            downloadedPixelsMatch: asOptionalRecord(download)?.data === retainedImageBase64,
            retainedIncludesUrl: JSON.stringify(retainedHistory).includes(retainedImageUrl),
          },
          ui: {
            omittedCardText,
            omittedInteractiveDescendantCount,
            retainedImageSrc: await retainedPreview.getAttribute("src"),
            retainedOmittedCardCount: await omittedCard(retainedPane).count(),
          },
        });
        await screenshot(page, "04-retained-image.png");
      });
    } finally {
      await gatewayOwner.stop({ preserveToDir: path.join(suite.artifactDir, "gateway") });
    }
  });

  it(
    "delivers PowerPoint and keeps persisted attachment failures replay-safe",
    { timeout: 180_000 },
    async () => {
      const startedAt = performance.now();
      // A suite deadline can expire without a Playwright locator stack.
      const reportPhase = (phase: string) => {
        console.info("[media-transcript]", {
          phase,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      };
      const gatewayOwner = createQaLiveLaneGateway();
      const proofDir = suite.artifactDir;
      const errors: unknown[] = [];
      try {
        reportPhase("gateway-starting");
        const gateway = await startGateway(gatewayOwner);
        await writeFile(path.join(gateway.gateway.workspaceDir, "slides.pptx"), await createPptx());
        expect(await gateway.gateway.call("config.get", {})).toMatchObject({
          config: {
            agents: {
              entries: {
                qa: { model: { primary: "mock-openai/gpt-5.6-luna" } },
              },
            },
          },
        });

        await suite.withPage(pageOptions(), async ({ page }) => {
          const history = (limit: number) =>
            gateway.gateway.call("chat.history", { sessionKey: "agent:qa:main", limit });
          await authenticate(page, gateway.gateway);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:qa:main"));
          await waitForControlUiGatewayReady(page);
          // Exercise media delivery only after the target session owns its composer;
          // cold startup can still replace the initial empty draft before this point.
          await page.waitForFunction(() => {
            const pane = document.querySelector<
              HTMLElement & {
                state?: { connected: boolean; sessionKey: string; chatLoading: boolean };
              }
            >("openclaw-chat-pane.chat-pane-cache__pane--visible");
            return (
              pane?.state?.connected === true &&
              pane.state.sessionKey === "agent:qa:main" &&
              !pane.state.chatLoading
            );
          });
          const stop = page.getByRole("button", { name: "Stop generating", exact: true });
          await send(page, "Reply exactly `Slides ready\nMEDIA:./slides.pptx`");
          reportPhase("powerpoint-request-sent");
          const card = page.locator(".chat-assistant-attachment-card", {
            hasText: "slides.pptx",
          });
          await card.waitFor();
          const firstCardText = (await card.textContent()) ?? "";
          await screenshot(page, "01-pptx-result.png");
          const firstHistory = await history(20);

          // Persisted replies can precede the browser's terminal event.
          await stop.waitFor({ state: "hidden" });
          await send(page, "Reply exactly `Session healthy`");
          const successPathHealthy = await healthyReplay(() => history(20), "Session healthy");
          reportPhase("success-replay-checked");
          let failureCardVisible = firstCardText.includes("Not sent");
          let failurePathHealthy = false;
          if (successPathHealthy) {
            await stop.waitFor({ state: "hidden" });
            await send(page, "Reply exactly `Missing file\nMEDIA:./missing-proof.txt`");
            const failureCard = page.locator(".chat-assistant-attachment-card", {
              hasText: "missing-proof.txt",
            });
            await failureCard.waitFor();
            failureCardVisible = ((await failureCard.textContent()) ?? "").includes("Not sent");
            await stop.waitFor({ state: "hidden" });
            await send(page, "Reply exactly `Session recovered`");
            failurePathHealthy = await healthyReplay(() => history(30), "Session recovered");
            reportPhase("failure-replay-checked");
          }
          const secondHistory = await history(30);
          const stateDir = gateway.gateway.runtimeEnv.OPENCLAW_STATE_DIR;
          if (!stateDir) {
            throw new Error("QA Gateway state directory is unavailable");
          }
          const rawAssistantMessages = readRawAssistantMessages(stateDir);
          const rawModelContent = rawAssistantMessages.flatMap((message) =>
            Array.isArray(message.content) ? message.content : [],
          );
          const rawDisplayContent = rawAssistantMessages.flatMap((message) =>
            Array.isArray(message.openclawDisplayContent) ? message.openclawDisplayContent : [],
          );
          await screenshot(page, "02-next-turn-result.png");
          const verdict = {
            failureCardVisible,
            failurePathHealthy,
            firstCardText,
            modelHistoryHasAttachmentError:
              JSON.stringify(rawModelContent).includes("attachment_error"),
            modelReplayError: readModelReplayError(rawAssistantMessages),
            displayHistoryHasAttachmentError:
              JSON.stringify(rawDisplayContent).includes("attachment_error"),
            pptxDelivered: !firstCardText.includes("Not sent"),
            successPathHealthy,
            firstHistory,
            secondHistory,
          };
          await writeVerdict(verdict);
          expect(verdict).toMatchObject({
            displayHistoryHasAttachmentError: true,
            failureCardVisible: true,
            failurePathHealthy: true,
            modelHistoryHasAttachmentError: false,
            modelReplayError: null,
            pptxDelivered: true,
            successPathHealthy: true,
          });
          reportPhase("verdict-checked");
        });
      } catch (error) {
        errors.push(error);
      }
      reportPhase("gateway-stopping");
      const stopped = await gatewayOwner.stop({ preserveToDir: path.join(proofDir, "gateway") });
      reportPhase("gateway-stopped");
      errors.push(...stopped.errors);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Control UI media transcript proof failed");
      }
    },
  );
});
