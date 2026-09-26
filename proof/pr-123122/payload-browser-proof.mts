import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";

const outputDir = path.resolve(process.argv[2] ?? "proof/pr-123122");
const sessionKey = "agent:main:main";
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
    maxPayload: 4096,
    attachmentMaxBytes: 100_000,
    sessionKey,
    historyMessages: [],
  });
  await page.goto(`${server.baseUrl}chat`);
  await page.locator(".agent-chat__input").waitFor({ state: "visible" });
  const textarea = page.locator(".agent-chat__composer-combobox textarea");
  await textarea.fill("keep this draft");
  await page.locator("input.agent-chat__file-input").setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(12_000, "x"),
  });
  const attachment = page.locator(".chat-attachment-file__name").filter({ hasText: "note.txt" });
  await attachment.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(outputDir, "payload-before.png"), fullPage: true });

  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .getByText("gateway request chat.send exceeds negotiated max payload", { exact: false })
    .first()
    .waitFor({ state: "visible" });
  if ((await textarea.inputValue()) !== "keep this draft") {
    throw new Error(`draft was not preserved: ${await textarea.inputValue()}`);
  }
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
        maxPayloadBytes: 4096,
        attachmentBytes: 12_000,
        rejectedSendCount,
        successfulSendCount: (await gateway.getRequests("chat.send")).length,
        preservedDraft: "keep this draft",
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
