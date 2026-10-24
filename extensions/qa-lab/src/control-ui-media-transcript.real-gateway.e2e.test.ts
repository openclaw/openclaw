import { writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { waitForControlUiGatewayReady } from "../../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  authenticateControlUi,
  captureControlUi,
  controlUiPageOptions,
  startControlUiGateway,
  stopControlUiGateway,
  writeControlUiVerdict,
} from "./control-ui-gateway.e2e.test-support.ts";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI PowerPoint delivery with a real Gateway",
  startServerBeforeBrowser: true,
});

async function createPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  );
  zip.file("ppt/presentation.xml", "<presentation/>");
  return zip.generateAsync({ type: "nodebuffer" });
}

suite.define(() => {
  it("delivers PowerPoint through the real Gateway", { timeout: 180_000 }, async () => {
    const owner = createQaLiveLaneGateway();
    const errors: unknown[] = [];
    try {
      const { gateway } = await startControlUiGateway(owner, suite.server.baseUrl, {
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(process.cwd(), "openclaw.mjs")],
          cwd: process.cwd(),
          usePackagedPlugins: false,
        },
      });
      await writeFile(path.join(gateway.workspaceDir, "slides.pptx"), await createPptx());
      await suite.withPage(controlUiPageOptions(suite.artifactDir), async ({ page }) => {
        await authenticateControlUi(page, gateway);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:qa:main"));
        await waitForControlUiGatewayReady(page);
        // Cold startup can replace a draft until the target session owns its composer.
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
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Reply exactly `Slides ready\nMEDIA:./slides.pptx`");
        await page.getByRole("button", { name: "Send message" }).click();
        const card = page.locator(".chat-assistant-attachment-card", { hasText: "slides.pptx" });
        await card.waitFor();
        const firstCardText = (await card.textContent()) ?? "";
        expect(firstCardText).not.toContain("Not sent");
        await captureControlUi(page, suite.artifactDir, "01-pptx-result.png");
        await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor({
          state: "hidden",
        });
        await writeControlUiVerdict(suite.artifactDir, { firstCardText });
      });
    } catch (error) {
      errors.push(error);
    }
    await stopControlUiGateway(
      owner,
      suite.artifactDir,
      "Control UI PowerPoint proof failed",
      errors,
    );
  });
});
