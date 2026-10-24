import { readFile } from "node:fs/promises";
import { asOptionalRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page, WebSocket } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  captureControlUi,
  controlUiPageOptions as pageOptions,
  historyMessages,
  startControlUiGateway,
  stopControlUiGateway,
} from "./control-ui-gateway.e2e.test-support.ts";
import { createQaLiveLaneGateway } from "./live-transports/shared/live-gateway.runtime.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI OpenClaw delegation with a real Gateway",
  startServerBeforeBrowser: true,
});

const prompt = "tool search qa check target=openclaw openclaw_fixture=logging-level-info";
type ProofWindow = Window & {
  __OPENCLAW_APPROVAL_UI_SEQUENCE__?: string[];
  __OPENCLAW_APPROVAL_FALLBACK_OBSERVED__?: boolean;
  __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
};
const fallbackMarkers = [
  "OpenClaw change pending approval",
  "/approve",
  "needsApproval",
  "proposalId",
];

function expectNoFallback(text: string | null, includeHeading = true) {
  for (const marker of fallbackMarkers.slice(includeHeading ? 0 : 1)) {
    expect(text).not.toContain(marker);
  }
}

function startGateway(owner: ReturnType<typeof createQaLiveLaneGateway>, baseUrl: string) {
  return startControlUiGateway(owner, baseUrl, {
    mutateConfig: (cfg) => {
      (cfg.logging ??= {}).level = "debug";
      const agent = (((cfg.agents ??= {}).entries ??= {}).qa ??= {});
      agent.identity = { name: "Approval proof" };
      const tools = (agent.tools ??= {});
      (tools.exec ??= {}).mode = "ask";
      tools.alsoAllow = ["openclaw"];
      return cfg;
    },
  });
}

function observeEvents(page: Page, gatewayUrl: string, sessionKey: string) {
  const events: string[] = [];
  let finals = 0;
  let activeUiSocket: WebSocket | undefined;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).origin !== new URL(gatewayUrl).origin) {
      return;
    }
    // Reload overlaps sockets; the approval case observes only the replacement connection.
    activeUiSocket = socket;
    socket.on("framereceived", ({ payload }) => {
      if (socket !== activeUiSocket) {
        return;
      }
      const frame = asOptionalRecord(JSON.parse(String(payload)));
      if (frame?.type !== "event") {
        return;
      }
      const data = asOptionalRecord(frame.payload);
      if (typeof frame.event === "string" && frame.event.startsWith("openclaw.approval.")) {
        const suffix =
          typeof data?.applicationStatus === "string" ? `:${data.applicationStatus}` : "";
        events.push(`${frame.event}${suffix}`);
      }
      if (frame.event === "chat" && data?.sessionKey === sessionKey && data.state === "final") {
        finals += 1;
        events.push("chat.final");
      }
    });
  });
  return { events, finals: () => finals };
}

async function expandResult(page: Page) {
  const work = page.locator(".chat-work-group > .chat-activity-group__summary").first();
  await work.waitFor();
  if ((await work.getAttribute("aria-expanded")) !== "true") {
    await work.click();
  }
  const summaries = page.locator(".chat-tool-msg-summary");
  await summaries.first().waitFor();
  for (const summary of await summaries.all()) {
    await summary.click();
  }
  const result = page.locator(".chat-tool-msg-body", { hasText: /Updated logging\.level/u });
  await result.waitFor();
}

function loggingLevel(config: unknown): unknown {
  return isRecord(config) && isRecord(config.logging) ? config.logging.level : undefined;
}

function readDelegationResults(history: unknown): Record<string, unknown>[] {
  return historyMessages(history)
    .map(asOptionalRecord)
    .flatMap((message) => {
      if (
        message?.role !== "toolResult" ||
        message.toolName !== "openclaw" ||
        !Array.isArray(message.content)
      ) {
        return [];
      }
      const text = message.content
        .flatMap((block) =>
          isRecord(block) && block.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n");
      const result: unknown = JSON.parse(text);
      return isRecord(result) ? [result] : [];
    });
}

suite.define(() => {
  it("renders one native approval card without exposing fallback approval text", async () => {
    const owner = createQaLiveLaneGateway();
    const proofDir = suite.artifactDir;
    const errors: unknown[] = [];
    try {
      const runtime = await startGateway(owner, suite.server.baseUrl);
      const gateway = runtime.gateway;
      const sessionKey = "agent:qa:dashboard:delegation-approval";
      await gateway.call("sessions.create", {
        key: sessionKey,
        label: "OpenClaw native approval",
      });

      await suite.withPage(pageOptions(proofDir), async ({ page }) => {
        const { events: eventSequence, finals } = observeEvents(page, gateway.wsUrl, sessionKey);
        await page.addInitScript(
          ({ gatewayUrl, token, browserFallbackMarkers }) => {
            const proofWindow = window as ProofWindow;
            proofWindow["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
            proofWindow["__OPENCLAW_APPROVAL_UI_SEQUENCE__"] = [];
            proofWindow["__OPENCLAW_APPROVAL_FALLBACK_OBSERVED__"] = false;
            const containsFallback = (text: string | null) =>
              browserFallbackMarkers.some((marker) => text?.includes(marker));
            new MutationObserver((mutations) => {
              for (const record of mutations) {
                const changedText =
                  record.type === "characterData"
                    ? [record.target.textContent]
                    : [...record.addedNodes].map((node) => node.textContent);
                if (changedText.some(containsFallback)) {
                  proofWindow["__OPENCLAW_APPROVAL_FALLBACK_OBSERVED__"] = true;
                }
              }
            }).observe(document, { childList: true, characterData: true, subtree: true });
            const NativeWebSocket = window.WebSocket;
            window.WebSocket = class extends NativeWebSocket {
              constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols ?? []);
                this.addEventListener("message", (event) => {
                  try {
                    const frame = JSON.parse(String(event.data)) as {
                      event?: unknown;
                      payload?: { applicationStatus?: unknown };
                      type?: unknown;
                    };
                    if (frame.type === "event" && frame.event === "openclaw.approval.resolved") {
                      const applicationStatus =
                        typeof frame.payload?.applicationStatus === "string"
                          ? `:${frame.payload.applicationStatus}`
                          : "";
                      proofWindow["__OPENCLAW_APPROVAL_UI_SEQUENCE__"]?.push(
                        `openclaw.approval.resolved${applicationStatus}`,
                      );
                    }
                  } catch {}
                });
              }
            };
          },
          {
            gatewayUrl: gateway.wsUrl,
            token: gateway.token,
            browserFallbackMarkers: fallbackMarkers,
          },
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();

        const approvalCard = page.locator(
          '.chat-inline-approval [data-approval-id^="system-agent:"]',
        );
        await approvalCard.waitFor();
        const expectPending = async () => {
          await expect.poll(() => approvalCard.count()).toBe(1);
          expect(eventSequence).toEqual(["openclaw.approval.requested"]);
          expect(finals()).toBe(0);
          const history = await gateway.call("chat.history", { sessionKey, limit: 30 });
          expect(readDelegationResults(history)).toEqual([]);
          expectNoFallback(await page.locator("body").textContent());
          return history;
        };
        expect(loggingLevel(JSON.parse(await readFile(gateway.configPath, "utf8")))).toBe("debug");
        expectNoFallback(JSON.stringify(await expectPending()), false);
        await captureControlUi(page, proofDir, "01-native-approval.png");

        const approvalFallbackWasObserved = () =>
          page.evaluate(
            () => (window as ProofWindow)["__OPENCLAW_APPROVAL_FALLBACK_OBSERVED__"] === true,
          );
        expect(await approvalFallbackWasObserved()).toBe(false);
        await page.reload();
        await composer.waitFor();
        await approvalCard.waitFor();
        await expectPending();

        await approvalCard.evaluate((card) => {
          const proofWindow = window as ProofWindow;
          const observer = new MutationObserver(() => {
            if (!card.isConnected) {
              observer.disconnect();
              const sequence = proofWindow["__OPENCLAW_APPROVAL_UI_SEQUENCE__"];
              if (!sequence) {
                throw new Error("Approval proof sequence was not initialized");
              }
              sequence.push("approval.card.removed");
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });

        await approvalCard.getByRole("button", { name: "Allow once" }).click();
        await expect.poll(() => approvalCard.count()).toBe(0);
        await expect.poll(finals, { timeout: 60_000 }).toBe(1);
        expect(eventSequence).toEqual([
          "openclaw.approval.requested",
          "openclaw.approval.resolved",
          "openclaw.approval.resolved:applied",
          "chat.final",
        ]);
        const approvalUiSequence = await page.evaluate(
          () => (window as ProofWindow)["__OPENCLAW_APPROVAL_UI_SEQUENCE__"],
        );
        expect(approvalUiSequence).toHaveLength(3);
        expect(approvalUiSequence).toEqual(
          expect.arrayContaining([
            "openclaw.approval.resolved",
            "approval.card.removed",
            "openclaw.approval.resolved:applied",
          ]),
        );
        expect(approvalUiSequence?.at(-1)).toBe("openclaw.approval.resolved:applied");

        const history = await gateway.call("chat.history", { sessionKey, limit: 30 });
        const results = readDelegationResults(history);
        expect(results).toHaveLength(1);
        expect(results[0]?.needsApproval).not.toBe(true);
        expect(results[0]?.proposalId).toBeUndefined();
        expect(results[0]?.reply).toContain("Updated logging.level");
        expect(JSON.stringify(history)).not.toContain("/approve");
        expect(loggingLevel(JSON.parse(await readFile(gateway.configPath, "utf8")))).toBe("info");
        expect(await approvalFallbackWasObserved()).toBe(false);
        await page.reload();
        await composer.waitFor();
        await page.getByText(prompt, { exact: true }).waitFor();
        await expect.poll(() => approvalCard.count()).toBe(0);
        await expandResult(page);
        expectNoFallback(await page.locator("body").textContent());
        expect(await approvalFallbackWasObserved()).toBe(false);
      });
    } catch (error) {
      errors.push(error);
    }
    await stopControlUiGateway(owner, proofDir, "native OpenClaw approval proof failed", errors);
  }, 180_000);
});
