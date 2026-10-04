import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";

const outputDir = path.resolve(process.argv[2] ?? "proof/pr-123122");
const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sessionKey = "agent:main:main";
const maxPayloadBytes = 280_000;
const attachmentBytes = 10_000;
const oversizedDraft = `keep this draft\n${"x".repeat(300_000)}`;
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({
  colorScheme: "dark",
  locale: "en-US",
  reducedMotion: "reduce",
  serviceWorkers: "block",
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(60_000);

try {
  const gateway = await installMockGateway(page, {
    maxPayload: maxPayloadBytes,
    attachmentMaxBytes: 100_000,
    sessionKey,
    historyMessages: [],
  });
  await page.goto(`${server.baseUrl}chat`);
  await gateway.waitForRequest("chat.startup");
  const composer = page.locator(".agent-chat__input");
  await composer.waitFor({ state: "visible" });
  const textarea = composer.locator(".agent-chat__composer-combobox textarea");
  await textarea.fill(oversizedDraft);
  await composer.locator(".agent-chat__file-input").setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(attachmentBytes, "x"),
  });
  const preview = page.locator(".chat-attachments-preview");
  await preview.waitFor({ state: "visible" });
  const attachment = preview.locator(".chat-attachment-thumb", { hasText: "note.txt" });
  await attachment.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.querySelector('.chat-attachment-thumb[aria-busy="true"]') === null,
  );
  await page.screenshot({ path: path.join(outputDir, "payload-before.png"), fullPage: true });

  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .getByText("gateway request chat.send exceeds negotiated max payload", { exact: false })
    .first()
    .waitFor({ state: "visible" });
  if ((await textarea.inputValue()) !== oversizedDraft) {
    throw new Error("oversized draft was not preserved exactly after the rejected send");
  }
  const preservedDraftCharacters = (await textarea.inputValue()).length;
  await attachment.waitFor({ state: "visible" });
  const rejectedSendCount = (await gateway.getRequests("chat.send")).length;
  if (rejectedSendCount !== 0) {
    throw new Error(`oversized request reached the mock Gateway: ${rejectedSendCount}`);
  }
  await page.screenshot({ path: path.join(outputDir, "payload-after-error.png"), fullPage: true });

  await page.getByRole("button", { name: "Remove note.txt" }).click();
  await textarea.fill("small follow-up");
  await page.getByRole("button", { name: "Send message" }).click();
  const sent = await gateway.waitForRequest("chat.send");
  const runId =
    typeof sent.params === "object" && sent.params !== null && "idempotencyKey" in sent.params
      ? String((sent.params as { idempotencyKey: unknown }).idempotencyKey)
      : "payload-proof-run";
  await gateway.emitChatFinal({ runId, sessionKey, text: "smaller follow-up accepted" });
  await page
    .locator(".chat-thread")
    .getByText("smaller follow-up accepted", { exact: true })
    .first()
    .waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(outputDir, "payload-after-retry.png"), fullPage: true });
  console.log(
    JSON.stringify(
      {
        headSha,
        maxPayloadBytes,
        oversizedDraftCharacters: oversizedDraft.length,
        attachmentBytes,
        rejectedSendCount,
        successfulSendCount: (await gateway.getRequests("chat.send")).length,
        preservedDraftPrefix: oversizedDraft.slice(0, 17),
        preservedDraftCharacters,
        preservedAttachment: "note.txt",
        retryMessage: "smaller follow-up accepted",
        outputDir,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
