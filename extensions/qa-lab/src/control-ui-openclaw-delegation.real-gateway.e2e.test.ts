import { readFile } from "node:fs/promises";
import { asOptionalRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page, WebSocket } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  authenticateControlUi,
  captureControlUi,
  controlUiPageOptions as pageOptions,
  historyMessages,
  startControlUiGateway,
  stopControlUiGateway,
  writeControlUiVerdict,
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

function startGateway(
  owner: ReturnType<typeof createQaLiveLaneGateway>,
  baseUrl: string,
  ask = false,
) {
  return startControlUiGateway(owner, baseUrl, {
    mutateConfig: (cfg) => ({
      ...cfg,
      logging: { ...cfg.logging, level: "debug" },
      ...(!ask ? { tools: { ...cfg.tools, exec: { ...cfg.tools?.exec, mode: "full" } } } : {}),
      agents: {
        ...cfg.agents,
        entries: {
          ...cfg.agents?.entries,
          qa: {
            ...cfg.agents?.entries?.qa,
            identity: { name: "Approval proof" },
            tools: {
              ...cfg.agents?.entries?.qa?.tools,
              ...(ask ? { exec: { ...cfg.agents?.entries?.qa?.tools?.exec, mode: "ask" } } : {}),
              alsoAllow: ["openclaw"],
            },
          },
        },
      },
    }),
  });
}

function observeEvents(page: Page, gatewayUrl: string, sessionKey: string, activeOnly = false) {
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
      if (activeOnly && socket !== activeUiSocket) {
        return;
      }
      const frame = asOptionalRecord(JSON.parse(String(payload)));
      if (frame?.type !== "event") {
        return;
      }
      const data = asOptionalRecord(frame.payload);
      if (typeof frame.event === "string" && frame.event.startsWith("openclaw.approval.")) {
        const suffix =
          activeOnly && typeof data?.applicationStatus === "string"
            ? `:${data.applicationStatus}`
            : "";
        events.push(`${frame.event}${suffix}`);
      }
      if (frame.event === "chat" && data?.sessionKey === sessionKey && data.state === "final") {
        finals += 1;
        if (activeOnly) {
          events.push("chat.final");
        }
      }
    });
  });
  return { events, finals: () => finals };
}

async function expandResult(page: Page, onlyCollapsed: boolean) {
  const work = page.locator(".chat-work-group > .chat-activity-group__summary").first();
  await work.waitFor();
  if ((await work.getAttribute("aria-expanded")) !== "true") {
    await work.click();
  }
  const summaries = page.locator(".chat-tool-msg-summary");
  await summaries.first().waitFor();
  for (const summary of await summaries.all()) {
    if (!onlyCollapsed || (await summary.getAttribute("aria-expanded")) !== "true") {
      await summary.click();
    }
  }
  const result = page.locator(".chat-tool-msg-body", { hasText: /Updated logging\.level/u });
  await result.waitFor();
  return result;
}

function expectApplied(result: Record<string, unknown> | undefined) {
  expect(result?.needsApproval).not.toBe(true);
  expect(result?.proposalId).toBeUndefined();
  expect(result?.reply).toContain("Updated logging.level");
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
      const runtime = await startGateway(owner, suite.server.baseUrl, true);
      const gateway = runtime.gateway;
      const sessionKey = "agent:qa:dashboard:delegation-approval";
      await gateway.call("sessions.create", {
        key: sessionKey,
        label: "OpenClaw native approval",
      });

      await suite.withPage(pageOptions(proofDir), async ({ page }) => {
        const { events: eventSequence, finals } = observeEvents(
          page,
          gateway.wsUrl,
          sessionKey,
          true,
        );
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
        expectApplied(results[0]);
        expect(JSON.stringify(history)).not.toContain("/approve");
        expect(loggingLevel(JSON.parse(await readFile(gateway.configPath, "utf8")))).toBe("info");
        expect(await approvalFallbackWasObserved()).toBe(false);
        await page.reload();
        await composer.waitFor();
        await page.getByText(prompt, { exact: true }).waitFor();
        await expect.poll(() => approvalCard.count()).toBe(0);
        await expandResult(page, false);
        expectNoFallback(await page.locator("body").textContent());
        expect(await approvalFallbackWasObserved()).toBe(false);
      });
    } catch (error) {
      errors.push(error);
    }
    await stopControlUiGateway(owner, proofDir, "native OpenClaw approval proof failed", errors);
  }, 180_000);
});

const fullAccessOwner = createQaLiveLaneGateway();
let fullAccessRuntime: Awaited<ReturnType<typeof fullAccessOwner.start>>;
let fullAccessProofDir: string;
let fullAccessGatewayUsed = false;
const stopFullAccess = (message: string) =>
  stopControlUiGateway(fullAccessOwner, fullAccessProofDir, message);
const fullAccessSuite = createControlUiE2eSuite({
  name: "Control UI OpenClaw delegation with a real Gateway",
  startServerBeforeBrowser: true,
  setupTimeoutMs: 180_000,
  resources: {
    retainedState: () => fullAccessRuntime?.gateway.tempRoot,
    run: async (signal) => {
      // Suite logs span both cases; per-case artifact directories rotate before each test.
      fullAccessProofDir = fullAccessSuite.artifactDir;
      signal.throwIfAborted();
      fullAccessRuntime = await startGateway(fullAccessOwner, fullAccessSuite.server.baseUrl);
      signal.throwIfAborted();
    },
    close: () => stopFullAccess("Full Access Gateway cleanup failed"),
  },
});

fullAccessSuite.define(() => {
  it.for(["default", "full"] as const)(
    "%s Full Access saves a delegated config change without a system-agent approval",
    { timeout: 180_000 },
    async (mode, context) => {
      let completed = false;
      await fullAccessSuite.runScenario(context, {
        run: async (signal) => {
          signal.throwIfAborted();
          const proofDir = fullAccessSuite.artifactDir;
          const gateway = fullAccessRuntime.gateway;
          if (fullAccessGatewayUsed) {
            // The previous turn finished; reset only its persisted logging change.
            const current = await gateway.call("config.get", {});
            if (!isRecord(current) || typeof current.hash !== "string") {
              throw new Error("Gateway did not return a config revision");
            }
            expect(loggingLevel(current.config)).toBe("info");
            await gateway.call("config.patch", {
              raw: JSON.stringify({ logging: { level: "debug" } }),
              baseHash: current.hash,
            });
          }
          fullAccessGatewayUsed = true;
          signal.throwIfAborted();
          const initialConfig = await gateway.call("config.get", {});
          expect(isRecord(initialConfig) && loggingLevel(initialConfig.config)).toBe("debug");
          const sessionKey = `agent:qa:dashboard:delegation-${mode}`;
          const created = await gateway.call("sessions.create", {
            key: sessionKey,
            label: mode === "full" ? "Full Access delegation" : "Default Full Access delegation",
            ...(mode === "full" ? { permissionMode: "full" } : {}),
          });
          expect(created).toMatchObject({ key: sessionKey });
          const entry = isRecord(created) && isRecord(created.entry) ? created.entry : undefined;
          expect(entry?.permissionMode).toBe(mode === "full" ? "full" : undefined);
          expect(loggingLevel(JSON.parse(await readFile(gateway.configPath, "utf8")))).toBe(
            "debug",
          );

          await fullAccessSuite.withPage(pageOptions(proofDir), async ({ page }) => {
            const { events: approvalEvents, finals } = observeEvents(
              page,
              gateway.wsUrl,
              sessionKey,
            );
            await authenticateControlUi(page, gateway);
            await page.goto(controlUiSessionUrl(fullAccessSuite.server.baseUrl, sessionKey));
            const composer = page.locator(".agent-chat__composer-combobox textarea");
            await composer.fill(prompt);
            await captureControlUi(page, proofDir, "01-request.png");
            await page.getByRole("button", { name: "Send message" }).click();

            await expect.poll(finals, { timeout: 60_000 }).toBeGreaterThan(0);
            const history = await gateway.call("chat.history", { sessionKey, limit: 30 });
            const result = readDelegationResults(history).at(-1);
            expect(result).toBeDefined();
            expectApplied(result);
            expect(approvalEvents).toEqual([]);

            const savedConfig: unknown = JSON.parse(await readFile(gateway.configPath, "utf8"));
            expect(loggingLevel(savedConfig)).toBe("info");
            const configSnapshot = await gateway.call("config.get", {});
            expect(isRecord(configSnapshot) && loggingLevel(configSnapshot.config)).toBe("info");
            const finalMessage = historyMessages(history).findLast(
              (message) => isRecord(message) && message.role === "assistant",
            );
            const finalMeta = isRecord(finalMessage) ? finalMessage["__openclaw"] : undefined;
            const finalEntryId = isRecord(finalMeta) ? finalMeta.id : undefined;
            if (typeof finalEntryId !== "string") {
              throw new Error("chat.history returned no persisted assistant entry id");
            }
            // History replaces the live final and its work-group key. Expand the persisted row.
            await page.locator(`.chat-bubble[data-entry-id="${finalEntryId}"]`).waitFor();
            const appliedResult = await expandResult(page, true);
            await appliedResult.scrollIntoViewIfNeeded();
            expect(await page.locator(".chat-inline-approval [data-approval-id]").count()).toBe(0);
            await captureControlUi(page, proofDir, "02-applied.png");
            // Keep public proof independent of runtime tokens, paths, model metadata, and run ids.
            await writeControlUiVerdict(proofDir, {
              mode,
              initialLoggingLevel: "debug",
              savedLoggingLevel: loggingLevel(savedConfig),
              finalDelegateResultObserved: true,
              finalChatObserved: finals() > 0,
              needsApproval: result?.needsApproval === true,
              systemAgentApprovalEvents: approvalEvents,
            });
          });
          completed = true;
        },
        close: async () => {
          if (completed && !context.signal.aborted) {
            return;
          }
          // Failed or cancelled cases close admission before another case can reuse state.
          await stopFullAccess(`Full Access cleanup failed (${mode})`);
        },
      });
    },
  );
});
