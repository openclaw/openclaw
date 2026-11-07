import assert from "node:assert/strict";
import type { Page, WebSocket } from "playwright";

export type FirstRunMeasure = (
  name: string,
  action: () => Promise<unknown>,
  readySelector: string,
) => Promise<void>;

const wizard = ".model-setup-wizard";
const baseUrlInput = `${wizard} input[placeholder="https://api.example.com/v1"]`;
const keyMode = `${wizard} [role="group"][aria-label="How do you want to provide this API key?"]`;
const keyInput = `${wizard} input[type="password"][placeholder="API key"]`;
const compatibility = `${wizard} button[aria-label^="Endpoint compatibility"]`;
const modelChoices = `${wizard} [role="group"][aria-label="Model ID"]`;
const endpointInput = `${wizard} input[placeholder="custom"]`;
const aliasInput = `${wizard} input[placeholder="e.g. local, ollama"]`;
const imageChoice = `${wizard} .wizard-step__message + openclaw-modal-actions button`;
const setupConsent = '.custodian__option-card [data-option-value="Yes — set it up"]';
const agentHandoff = '.custodian__option-card [data-option-value="Talk to my agent"]';
const composer = '.chat-pane-cache__pane--active textarea[aria-label="Chat composer"]';
const send = '.chat-pane-cache__pane--active button[aria-label="Send message"]';
const reply = ".chat-pane-cache__pane--active .chat-group.assistant .chat-text";

export type FirstRunRestartObservation =
  | { status: "not-required"; reason: "configured-handoff" }
  | {
      status: "observed";
      waitStartedAtMs: number;
      shutdownAtMs: number;
      reconnectedAtMs: number;
      composerReadyAtMs: number;
      waitMs: number;
      shutdownToHelloMs: number;
      initialBootId: string;
      reconnectedBootId: string;
      reason: string;
      restartExpectedMs: number;
      documentReplaced: boolean;
    };

/** Real Gateway driver: every answer follows the product's visible, named prompt. */
export async function runControlUiFirstRunFlow(
  page: Page,
  options: { url: string; providerUrl: string; measure: FirstRunMeasure },
): Promise<{
  onboarding: "apply-setup" | "configured-handoff";
  onboardingRestart: FirstRunRestartObservation;
  requestCounts: Record<string, number>;
}> {
  const { measure } = options;
  const journeyStartedAt = performance.now();
  const methods: string[] = [];
  type SocketFrame = { payload: string | Buffer };
  const observers = new Map<
    WebSocket,
    { sent: (frame: SocketFrame) => void; received: (frame: SocketFrame) => void }
  >();
  let initialBootId: string | undefined;
  let shutdown: { at: number; reason: string; restartExpectedMs: number } | undefined;
  let reconnected: { at: number; bootId: string } | undefined;
  let notifyRestart: (() => void) | undefined;
  const observeSocket = (socket: WebSocket) => {
    const sent = ({ payload }: SocketFrame) => {
      const frame: unknown = JSON.parse(payload.toString());
      if (
        frame &&
        typeof frame === "object" &&
        "type" in frame &&
        frame.type === "req" &&
        "method" in frame &&
        typeof frame.method === "string"
      ) {
        methods.push(frame.method);
      }
    };
    const received = ({ payload }: SocketFrame) => {
      const frame: unknown = JSON.parse(payload.toString());
      if (!frame || typeof frame !== "object" || !("payload" in frame)) {
        return;
      }
      const body = frame.payload;
      if (!body || typeof body !== "object") {
        return;
      }
      if (
        "event" in frame &&
        frame.event === "shutdown" &&
        "reason" in body &&
        typeof body.reason === "string" &&
        "restartExpectedMs" in body &&
        typeof body.restartExpectedMs === "number"
      ) {
        shutdown = {
          at: performance.now() - journeyStartedAt,
          reason: body.reason,
          restartExpectedMs: body.restartExpectedMs,
        };
      } else if (
        "type" in body &&
        body.type === "hello-ok" &&
        "server" in body &&
        body.server &&
        typeof body.server === "object" &&
        "bootId" in body.server &&
        typeof body.server.bootId === "string"
      ) {
        const bootId = body.server.bootId;
        if (initialBootId === undefined) {
          initialBootId = bootId;
        } else if (shutdown && bootId !== initialBootId) {
          reconnected = { at: performance.now() - journeyStartedAt, bootId };
        }
      }
      notifyRestart?.();
    };
    observers.set(socket, { sent, received });
    socket.on("framesent", sent);
    socket.on("framereceived", received);
  };
  page.on("websocket", observeSocket);
  const submit = () =>
    page.locator(wizard).getByRole("button", { name: "Submit", exact: true }).click();
  const wait = (selector: string) => page.locator(selector).first().waitFor({ state: "visible" });
  try {
    const choice = 'openclaw-model-setup-page [data-auth-choice="custom-api-key"] button';
    await measure(
      "first-load",
      async () => {
        await page.goto(options.url, { waitUntil: "domcontentloaded" });
        await wait(choice);
        const location = new URL(page.url());
        assert.equal(location.pathname, "/settings/model-setup");
        assert.equal(location.searchParams.get("firstRun"), "1");
        assert(methods.includes("openclaw.setup.detect"), "Fresh setup must use real detection");
        assert.deepEqual(
          methods.filter((method) =>
            /^openclaw\.setup\.(?:auto|verify|(?:auth|activate|prepare)\.start)$/u.test(method),
          ),
          [],
          "A fresh visit must not activate or verify a model without consent",
        );
        const nativeDiscovery = page.getByRole("checkbox", {
          name: "Show existing sessions",
          exact: true,
        });
        if (await nativeDiscovery.count()) {
          assert.equal(await nativeDiscovery.isChecked(), false);
        }
      },
      `${choice}:not([disabled])`,
    );
    const initialDocument = await page.evaluate(() => performance.timeOrigin);

    await measure(
      "provider-open",
      async () => {
        await page.locator(choice).click();
        await wait(baseUrlInput);
      },
      baseUrlInput,
    );
    await measure(
      "provider-endpoint",
      async () => {
        await page.locator(baseUrlInput).fill(`${options.providerUrl.replace(/\/$/u, "")}/v1`);
        await submit();
        await wait(keyMode);
      },
      `${keyMode} button:not([disabled])`,
    );
    await measure(
      "provider-key-storage",
      async () => {
        await page.locator(keyMode).getByRole("button", { name: "Paste API key now" }).click();
        await wait(keyInput);
      },
      keyInput,
    );
    await measure(
      "provider-key",
      async () => {
        await page.locator(keyInput).fill("synthetic-first-run-key");
        await submit();
        await wait(compatibility);
      },
      compatibility,
    );
    await measure(
      "provider-compatibility",
      async () => {
        await page.locator(compatibility).click();
        await page.getByRole("option", { name: /^OpenAI-compatible(?:\s|$)/u }).click();
        await page.locator(wizard).getByRole("button", { name: "Continue", exact: true }).click();
        await wait(modelChoices);
      },
      `${modelChoices} button:not([disabled])`,
    );
    await measure(
      "provider-model",
      async () => {
        await page
          .locator(modelChoices)
          .getByRole("button", { name: "synthetic-model", exact: true })
          .click();
        await wait(endpointInput);
      },
      endpointInput,
    );
    await measure(
      "provider-id",
      async () => {
        await page.locator(endpointInput).fill("synthetic-first-run");
        await submit();
        await wait(aliasInput);
      },
      aliasInput,
    );
    await measure(
      "provider-alias",
      async () => {
        await page.locator(aliasInput).fill("");
        await submit();
        await page
          .locator(wizard)
          .getByText("Does this model support image input?", { exact: true })
          .waitFor();
      },
      imageChoice,
    );
    await measure(
      "provider-verify-and-activate",
      async () => {
        await page.locator(wizard).getByRole("button", { name: "No", exact: true }).click();
        await wait(`${setupConsent}, ${agentHandoff}`);
        assert.equal(new URL(page.url()).pathname, "/custodian");
        assert.equal(new URL(page.url()).searchParams.get("onboarding"), "1");
      },
      `${setupConsent}, ${agentHandoff}`,
    );

    const onboarding = (await page.locator(setupConsent).count())
      ? "apply-setup"
      : "configured-handoff";
    await measure(
      "onboarding-consent-and-handoff",
      async () => {
        await page.locator(onboarding === "apply-setup" ? setupConsent : agentHandoff).click();
        await wait(composer);
        assert.match(new URL(page.url()).pathname, /^\/chat(?:\/|$)/u);
      },
      composer,
    );
    let onboardingRestart: FirstRunRestartObservation = {
      status: "not-required",
      reason: "configured-handoff",
    };
    if (onboarding === "apply-setup") {
      assert(initialBootId, "Fresh Gateway hello must identify its boot before setup");
      const waitStartedAtMs = performance.now() - journeyStartedAt;
      // This seed has no authored Gateway settings. Applying setup writes them,
      // so observe its announced restart before testing another first visit.
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          notifyRestart = undefined;
          page.off("close", closed);
        };
        const closed = () => {
          cleanup();
          reject(new Error("Page closed while observing the onboarding Gateway restart"));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Setup did not announce a restart and reconnect with a new boot ID"));
        }, 120_000);
        notifyRestart = () => {
          if (shutdown && reconnected) {
            cleanup();
            resolve();
          }
        };
        page.on("close", closed);
        notifyRestart();
      });
      assert(shutdown && reconnected);
      await page.waitForFunction(
        () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
        undefined,
        { timeout: 120_000 },
      );
      await wait(`${composer}:not([disabled])`);
      const composerReadyAtMs = performance.now() - journeyStartedAt;
      onboardingRestart = {
        status: "observed",
        waitStartedAtMs,
        shutdownAtMs: shutdown.at,
        reconnectedAtMs: reconnected.at,
        composerReadyAtMs,
        waitMs: composerReadyAtMs - waitStartedAtMs,
        shutdownToHelloMs: reconnected.at - shutdown.at,
        initialBootId,
        reconnectedBootId: reconnected.bootId,
        reason: shutdown.reason,
        restartExpectedMs: shutdown.restartExpectedMs,
        documentReplaced: (await page.evaluate(() => performance.timeOrigin)) !== initialDocument,
      };
    }
    const assistantPanel = "openclaw-assistant-panel .assistant-panel";
    const composerCoveredByAssistant = await page.locator(composer).evaluate((element) => {
      const panel = document.querySelector("openclaw-assistant-panel .assistant-panel");
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return panel !== null && target !== null && panel.contains(target);
    });
    if (composerCoveredByAssistant) {
      await measure(
        "mobile-assistant-close",
        async () => {
          await page
            .locator(assistantPanel)
            .getByRole("button", { name: "Close assistant sidebar", exact: true })
            .click();
          await page.locator(assistantPanel).waitFor({ state: "hidden" });
          await wait(`${composer}:not([disabled])`);
        },
        `body:not(:has(${assistantPanel}:not([hidden]))) ${composer}:not([disabled])`,
      );
    }
    // Onboarding may seed a hatch draft; measure composing from an empty field.
    await page.locator(composer).fill("");
    await measure(
      "first-message-compose",
      async () => {
        await page.locator(composer).fill("Say hello in one short sentence.");
        await page.locator(send).waitFor({ state: "visible" });
        assert.equal(await page.locator(reply).count(), 0, "First chat must have no earlier reply");
      },
      `${send}:not([disabled])`,
    );
    await measure(
      "first-message-reply",
      async () => {
        await page.locator(send).click();
        await page
          .locator(reply)
          .getByText("Synthetic first-run reply.", { exact: true })
          .waitFor();
        await wait(`${composer}:not([disabled])`);
      },
      `${reply} p`,
    );

    return {
      onboarding,
      onboardingRestart,
      requestCounts: Object.fromEntries(
        [...new Set(methods)].map((method) => [
          method,
          methods.filter((value) => value === method).length,
        ]),
      ),
    };
  } finally {
    page.off("websocket", observeSocket);
    for (const [socket, observer] of observers) {
      socket.off("framesent", observer.sent);
      socket.off("framereceived", observer.received);
    }
  }
}
