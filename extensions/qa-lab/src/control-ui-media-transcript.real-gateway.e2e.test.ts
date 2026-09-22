import { writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { transformMessages } from "../../../packages/ai/src/transcript-transform.ts";
import type { AssistantMessage, Model } from "../../../packages/ai/src/types.ts";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { waitForControlUiGatewayReady } from "../../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  navigateToControlUiSession,
} from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { resolveQaGatewayChildCommand } from "./gateway-child-command.ts";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI media transcript replay with a real Gateway",
  startServerBeforeBrowser: true,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
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
  const messages = (history as { messages?: unknown[] } | undefined)?.messages ?? [];
  return messages.some((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { role?: unknown }).role !== "assistant"
    ) {
      return false;
    }
    const content = (message as { content?: unknown }).content;
    return JSON.stringify(content).includes(text);
  });
}

function imageInHistory(history: unknown): Record<string, unknown> | undefined {
  const messages = asOptionalRecord(history)?.messages;
  return Array.isArray(messages)
    ? messages
        .flatMap((message) => {
          const content = asOptionalRecord(message)?.content;
          return Array.isArray(content) ? content : [];
        })
        .map(asOptionalRecord)
        .find((block) => block?.type === "image")
    : undefined;
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
    const gateway = await gatewayOwner.start({
      repoRoot: process.cwd(),
      command: {
        ...resolveQaGatewayChildCommand(process.cwd()),
        usePackagedPlugins: false,
      },
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
      transportBaseUrl: "http://127.0.0.1",
      controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
      controlUiEnabled: false,
    });
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(gateway.gateway.tempRoot, "state"),
    };
    const seed = async (sessionKey: string, sessionId: string, content: unknown[]) => {
      const storePath = resolveStorePath(undefined, { agentId: "qa", env });
      await upsertSessionEntry({
        agentId: "qa",
        env,
        sessionKey,
        storePath,
        entry: { sessionId, updatedAt: Date.now() },
      });
      await appendSessionTranscriptMessageByIdentity({
        agentId: "qa",
        env,
        sessionId,
        sessionKey,
        storePath,
        message: { role: "user", timestamp: Date.now(), content },
      });
    };
    const omittedSessionKey = "agent:qa:omitted-image-history";
    const recoveredSessionKey = "agent:qa:recovered-image-history";
    const retainedSessionKey = "agent:qa:retained-image-history";
    const retainedImageUrl = "https://example.invalid/retained-history-image.png";
    try {
      // Startup admits the fixture rows into the child Gateway's resident projection.
      await gateway.gateway.restartAfterStateMutation(async () => {
        await seed(omittedSessionKey, "omitted-image-history", [
          { type: "image", mimeType: "image/png", omitted: true, bytes: 12 * 1024 },
        ]);
        await seed(recoveredSessionKey, "recovered-image-history", [
          { type: "image", mimeType: "image/png", data: retainedImageBase64 },
        ]);
        await seed(retainedSessionKey, "retained-image-history", [
          {
            type: "image",
            mimeType: "image/png",
            source: { type: "url", url: retainedImageUrl },
          },
        ]);
      });
      const omittedHistory = await gateway.gateway.call("chat.history", {
        sessionKey: omittedSessionKey,
        limit: 10,
      });
      const recoveredHistory = await gateway.gateway.call("chat.history", {
        sessionKey: recoveredSessionKey,
        limit: 10,
      });
      const retainedHistory = await gateway.gateway.call("chat.history", {
        sessionKey: retainedSessionKey,
        limit: 10,
      });
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

      await suite.withPage(
        {
          locale: "en-US",
          ...(captureUiProof
            ? { recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } } }
            : {}),
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
        },
        async ({ page }) => {
          await page.route(retainedImageUrl, (route) =>
            route.fulfill({
              contentType: "image/png",
              body: Buffer.from(retainedImageBase64, "base64"),
            }),
          );
          await page.addInitScript(
            ({ gatewayUrl, token }) => {
              (
                window as Window & {
                  __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
                }
              )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
            },
            { gatewayUrl: gateway.gateway.wsUrl, token: gateway.gateway.token },
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, omittedSessionKey));
          const visiblePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          const omittedCard = visiblePane.locator(".chat-assistant-attachment-card", {
            hasText: "Omitted from history",
          });
          await omittedCard.waitFor({ state: "visible" });
          const omittedCardText = await omittedCard.textContent();
          const omittedInteractiveDescendantCount = await omittedCard
            .locator("a, button, img, audio, video")
            .count();
          expect(omittedInteractiveDescendantCount).toBe(0);
          if (captureUiProof) {
            await page.screenshot({ path: path.join(suite.artifactDir, "01-omitted-image.png") });
          }

          await navigateToControlUiSession(page, recoveredSessionKey);
          const recoveredPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          const preview = recoveredPane.locator("img.chat-message-image");
          await preview.waitFor({ state: "visible" });
          await expect
            .poll(() =>
              preview.evaluate((image) =>
                image instanceof HTMLImageElement ? image.naturalWidth : 0,
              ),
            )
            .toBe(64);
          expect(
            await recoveredPane
              .locator(".chat-assistant-attachment-card", { hasText: "Omitted from history" })
              .count(),
          ).toBe(0);
          if (captureUiProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, "02-recovered-image.png"),
            });
          }
          await recoveredPane.locator(".chat-message-image-button").press("Enter");
          const expanded = page.locator("openclaw-image-lightbox .image");
          await expanded.waitFor({ state: "visible" });
          await expect
            .poll(() =>
              expanded.evaluate((image) =>
                image instanceof HTMLImageElement ? image.naturalWidth : 0,
              ),
            )
            .toBe(64);
          if (captureUiProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, "03-recovered-lightbox.png"),
            });
          }
          await page.getByRole("button", { name: "Close image preview" }).click();
          await page.reload();
          await preview.waitFor({ state: "visible" });
          await expect
            .poll(() =>
              preview.evaluate((image) =>
                image instanceof HTMLImageElement ? image.naturalWidth : 0,
              ),
            )
            .toBe(64);

          await navigateToControlUiSession(page, retainedSessionKey);
          const retainedPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          const retainedPreview = retainedPane.locator(
            `img.chat-message-image[src="${retainedImageUrl}"]`,
          );
          await retainedPreview.waitFor({ state: "visible" });
          await expect
            .poll(() =>
              retainedPreview.evaluate((image) =>
                image instanceof HTMLImageElement ? image.naturalWidth : 0,
              ),
            )
            .toBe(64);
          expect(
            await retainedPane
              .locator(".chat-assistant-attachment-card", { hasText: "Omitted from history" })
              .count(),
          ).toBe(0);
          await writeFile(
            path.join(suite.artifactDir, "verdict.json"),
            `${JSON.stringify(
              {
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
                  retainedImageSrc: await retainedPane
                    .locator(`img.chat-message-image[src="${retainedImageUrl}"]`)
                    .getAttribute("src"),
                  retainedOmittedCardCount: await retainedPane
                    .locator(".chat-assistant-attachment-card", {
                      hasText: "Omitted from history",
                    })
                    .count(),
                },
              },
              null,
              2,
            )}\n`,
          );
          if (captureUiProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, "04-retained-image.png"),
            });
          }
        },
      );
    } finally {
      await gatewayOwner.stop({ preserveToDir: path.join(suite.artifactDir, "gateway") });
    }
  });

  it(
    "delivers PowerPoint and keeps persisted attachment failures replay-safe",
    { timeout: 180_000 },
    async () => {
      const gatewayOwner = createQaLiveLaneGateway();
      const proofDir = suite.artifactDir;
      const errors: unknown[] = [];
      try {
        const gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          command: resolveQaGatewayChildCommand(process.cwd()),
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
          transportBaseUrl: "http://127.0.0.1",
          controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
          controlUiEnabled: false,
        });
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

        await suite.withPage(
          {
            locale: "en-US",
            ...(captureUiProof
              ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } }
              : {}),
            serviceWorkers: "block",
            viewport: { width: 1280, height: 900 },
          },
          async ({ page }) => {
            await page.addInitScript(
              ({ gatewayUrl, token }) => {
                (
                  window as Window & {
                    __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
                  }
                )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
              },
              { gatewayUrl: gateway.gateway.wsUrl, token: gateway.gateway.token },
            );
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
            const composer = page.locator(".agent-chat__composer-combobox textarea");
            await composer.fill("Reply exactly `Slides ready\nMEDIA:./slides.pptx`");
            await page.getByRole("button", { name: "Send message" }).click();
            const card = page.locator(".chat-assistant-attachment-card", {
              hasText: "slides.pptx",
            });
            await card.waitFor();
            const firstCardText = (await card.textContent()) ?? "";
            if (captureUiProof) {
              await page.screenshot({ path: path.join(proofDir, "01-pptx-result.png") });
            }
            const firstHistory = await gateway.gateway.call("chat.history", {
              sessionKey: "agent:qa:main",
              limit: 20,
            });

            await composer.fill("Reply exactly `Session healthy`");
            await page.getByRole("button", { name: "Send message" }).click();
            let successPathHealthy = false;
            try {
              await expect
                .poll(
                  async () => {
                    const history = await gateway.gateway.call("chat.history", {
                      sessionKey: "agent:qa:main",
                      limit: 20,
                    });
                    return historyHasAssistantText(history, "Session healthy");
                  },
                  { timeout: 30_000 },
                )
                .toBe(true);
              successPathHealthy = true;
            } catch {}
            let failureCardVisible = firstCardText.includes("Not sent");
            let failurePathHealthy = false;
            if (successPathHealthy) {
              await composer.fill("Reply exactly `Missing file\nMEDIA:./missing-proof.txt`");
              await page.getByRole("button", { name: "Send message" }).click();
              const failureCard = page.locator(".chat-assistant-attachment-card", {
                hasText: "missing-proof.txt",
              });
              await failureCard.waitFor();
              failureCardVisible = ((await failureCard.textContent()) ?? "").includes("Not sent");
              await composer.fill("Reply exactly `Session recovered`");
              await page.getByRole("button", { name: "Send message" }).click();
              try {
                await expect
                  .poll(
                    async () => {
                      const history = await gateway.gateway.call("chat.history", {
                        sessionKey: "agent:qa:main",
                        limit: 30,
                      });
                      return historyHasAssistantText(history, "Session recovered");
                    },
                    { timeout: 30_000 },
                  )
                  .toBe(true);
                failurePathHealthy = true;
              } catch {}
            }
            const secondHistory = await gateway.gateway.call("chat.history", {
              sessionKey: "agent:qa:main",
              limit: 30,
            });
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
            if (captureUiProof) {
              await page.screenshot({ path: path.join(proofDir, "02-next-turn-result.png") });
            }
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
            await writeFile(
              path.join(proofDir, "verdict.json"),
              `${JSON.stringify(verdict, null, 2)}\n`,
            );
            expect(verdict).toMatchObject({
              displayHistoryHasAttachmentError: true,
              failureCardVisible: true,
              failurePathHealthy: true,
              modelHistoryHasAttachmentError: false,
              modelReplayError: null,
              pptxDelivered: true,
              successPathHealthy: true,
            });
          },
        );
      } catch (error) {
        errors.push(error);
      }
      const stopped = await gatewayOwner.stop({ preserveToDir: path.join(proofDir, "gateway") });
      errors.push(...stopped.errors);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Control UI media transcript proof failed");
      }
    },
  );
});
