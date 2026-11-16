import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createEngineTranscript, type EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames, prepareChat } from "./control-ui-interaction-navigation.ts";

const sessionKey = "agent:main:interaction-a";
const workSessionKey = "agent:main:dashboard:chat-actions-work";
const forkKey = "agent:main:interaction-b";
const activePane = ".chat-pane-cache__pane--active";
const userId = "interaction-0-398";
const answerId = "interaction-0-399";
const userText = "Transcript 0 message 398. Review the synthetic deployment report.";
const answerText = `Transcript 0 message 399.\n\n# Deployment report\n\n${"The synthetic deployment passed its validation; the next checkpoint verifies the same release.\n\n".repeat(
  60,
)}## Final checkpoint\n\nThe report is complete.`;
const failedText = "Synthetic message awaiting delivery.";
const reasoningText = "Compare the synthetic deployment checks before reaching a conclusion.";
const route = controlUiSessionPath(sessionKey);

function message(role: string, content: unknown, index: number) {
  return {
    role,
    content,
    timestamp: 1_800_000_000_000 + index * 1_000,
    __openclaw: { id: `interaction-0-${index}`, seq: index + 1 },
  };
}

function transcript() {
  return [
    ...createEngineTranscript(398),
    message("user", userText, 398),
    message("assistant", answerText, 399),
  ];
}

const fixture: NonNullable<EngineScenario["fixtureOverrides"]> = (_sandbox, base) => ({
  // A single canonical source lets the mock's setHistoryMessages model rewind.
  historyMessages: transcript(),
  sessionTranscripts: {},
  sessions: base.sessions.map((row) => ({ ...row, reasoningLevel: "on" })),
  methodResponses: {
    "sessions.rewind": { editorText: userText, editorAttachments: [] },
  },
});

function bubble(page: Page, id: string) {
  return page.locator(`${activePane} .chat-bubble[data-entry-id="${id}"]`);
}

function group(page: Page, id: string) {
  return page
    .locator(`${activePane} .chat-group`)
    .filter({ has: page.locator(`.chat-bubble[data-entry-id="${id}"]`) })
    .last();
}

async function revealActions(page: Page, id = answerId) {
  const target = bubble(page, id);
  // Touch exposes the same footer through the product's tap-to-reveal behavior.
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await target.tap();
  } else {
    await target.hover();
  }
  const actions = group(page, id).locator(".chat-group-footer-actions").last();
  await actions.waitFor({ state: "visible" });
  await actions.evaluate(async (element) => {
    const footer = element.closest(".chat-group-footer") ?? element;
    await Promise.all(
      footer.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
    if (getComputedStyle(footer).opacity === "0") {
      throw new Error("Message footer remained hidden after reveal");
    }
  });
  return actions;
}

async function contextMenu(page: Page, target: Locator) {
  await target.click({ button: "right" });
  const menu = page.locator(".chat-reply-context-menu");
  await menu.waitFor({ state: "visible" });
  // The menu installs outside-click and Escape dismissal on the next frame.
  await frames(page);
  return menu;
}

async function noRequests(gateway: MockGatewayControls, method: string) {
  if ((await gateway.getRequests(method)).length !== 0) {
    throw new Error(`Unexpected ${method} request during a presentation-only action`);
  }
}

async function preparePreviousMessages(page: Page) {
  await prepareChat(page);
  // The long final answer can occupy the virtualizer's entire window. Scroll to
  // its leading edge before looking up predecessor rows that are not mounted yet.
  await page.locator(`${activePane} .chat-thread`).evaluate((thread, entryId) => {
    const answer = thread.querySelector(`[data-entry-id="${entryId}"]`);
    if (!answer) {
      throw new Error("The prepared final answer is not mounted");
    }
    const top =
      thread.scrollTop + answer.getBoundingClientRect().top - thread.getBoundingClientRect().top;
    thread.scrollTo({ top: top - thread.clientHeight / 2, behavior: "instant" });
  }, answerId);
  await frames(page);
}

async function prepareToolRows(page: Page) {
  await preparePreviousMessages(page);
  const work = page
    .locator(`${activePane} .chat-work-group > .chat-activity-group__summary`)
    .last();
  await work.click();
  await expectExpanded(work, true);
  // Expansion can leave the tool rows outside the mobile virtualizer's window.
  await work.scrollIntoViewIfNeeded();
  await frames(page);
  const activity = page
    .locator(
      `${activePane} .chat-activity-group:not(.chat-work-group) > .chat-activity-group__summary`,
    )
    .last();
  if ((await activity.count()) && (await activity.getAttribute("aria-expanded")) === "false") {
    await activity.click();
  }
}

async function prepareFailedSend(page: Page, gateway: MockGatewayControls) {
  await prepareChat(page);
  await gateway.deferNext("chat.send");
  await page.locator(`${activePane} .agent-chat__composer-combobox textarea`).fill(failedText);
  await page.locator(`${activePane} .chat-send-btn--send`).click();
  await gateway.waitForRequest("chat.send");
  await gateway.rejectDeferred("chat.send", {
    code: "INVALID_REQUEST",
    message: "Synthetic delivery failure.",
  });
  await page.locator(`${activePane} .chat-send-status__retry`).waitFor({ state: "visible" });
  await frames(page);
}

async function expectExpanded(button: Locator, expanded: boolean) {
  await button
    .page()
    .waitForFunction(({ element, value }) => element?.getAttribute("aria-expanded") === value, {
      element: await button.elementHandle(),
      value: String(expanded),
    });
}

function workTranscript() {
  const prefix = createEngineTranscript(385);
  const work: unknown[] = [message("user", "Inspect the synthetic deployment.", 385)];
  work.push(message("assistant", [{ type: "thinking", thinking: reasoningText }], 386));
  for (let index = 0; index < 5; index++) {
    const callId = `chat-actions-read-${index}`;
    work.push(
      message(
        "assistant",
        [
          {
            type: "toolCall",
            id: callId,
            name: "read",
            arguments: { path: `report-${index}.txt` },
          },
        ],
        387 + index * 2,
      ),
    );
    work.push({
      ...message(
        "toolResult",
        `Synthetic tool result ${index}.\n${"Validation passed.\n".repeat(20)}`,
        388 + index * 2,
      ),
      toolCallId: callId,
      toolName: "read",
    });
  }
  work.push(message("assistant", "The five deployment reports passed validation.", 397));
  // The settled answer keeps prepareChat's shared readiness witness.
  return [
    ...prefix,
    ...work,
    message("user", userText, 398),
    message("assistant", answerText, 399),
  ];
}

const workFixture: NonNullable<EngineScenario["fixtureOverrides"]> = (sandbox, base) => ({
  ...fixture(sandbox, base),
  // Completed-work rollups belong to dashboard sessions; channel-shaped keys
  // intentionally retain their uncollapsed canonical transcript.
  sessionKey: workSessionKey,
  sessions: base.sessions.map((row) =>
    Object.assign({}, row, {
      key: row.key === sessionKey ? workSessionKey : row.key,
      reasoningLevel: "on",
    }),
  ),
  historyMessages: workTranscript(),
});

/** Real message UI paths; clipboard transport is a deterministic OS boundary in both engines. */
export function createChatMessageScenarios(): readonly EngineScenario[] {
  const scenarios: EngineScenario[] = [
    {
      id: "chat-actions-hover",
      route,
      fixtureOverrides: fixture,
      rowSelector: ".chat-virtual-row",
      expected: "Hover or tap reveals the settled answer's copy and reply toolbar without a write.",
      prepare: async (page) => {
        await prepareChat(page);
        await bubble(page, answerId).scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
      },
      run: async (page, gateway) => {
        const actions = await revealActions(page);
        await actions.getByRole("button", { name: "Copy as markdown", exact: true }).waitFor();
        await actions.getByRole("button", { name: "Reply to message", exact: true }).waitFor();
        await noRequests(gateway, "chat.send");
        return { toolbarVisible: true };
      },
    },
    {
      id: "chat-actions-copy",
      route,
      fixtureOverrides: fixture,
      expected: "Copy sends the complete long answer to the clipboard boundary and shows success.",
      setup: async (page) => {
        await page.addInitScript(() => {
          const writes: string[] = [];
          Reflect.set(window, "__chatActionsClipboardWrites", writes);
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text: string) => {
                writes.push(text);
                Reflect.set(window, "__chatActionsCopied", text);
              },
            },
          });
        });
      },
      prepare: async (page) => {
        await prepareChat(page);
        await revealActions(page);
      },
      run: async (page, gateway) => {
        // The success label changes to "Copied!", so retain the control by its stable class.
        const copy = group(page, answerId).locator(".chat-copy-btn");
        await copy.click();
        await page.waitForFunction(
          (expected) => Reflect.get(window, "__chatActionsCopied") === expected,
          answerText,
        );
        if ((await copy.getAttribute("data-copy-state")) !== "copied") {
          throw new Error("Copy did not expose its successful state");
        }
        const clipboardWrites: number = await page.evaluate(
          () => Reflect.get(window, "__chatActionsClipboardWrites").length,
        );
        if (clipboardWrites !== 1) {
          throw new Error(`Copy wrote to the clipboard ${clipboardWrites} times`);
        }
        await noRequests(gateway, "chat.send");
        return { copiedCharacters: answerText.length, clipboardWrites };
      },
    },
    {
      id: "chat-actions-edit-resubmit",
      route,
      fixtureOverrides: fixture,
      rowSelector: ".chat-virtual-row",
      expected:
        "Rewind restores the selected user prompt; editing and resubmitting sends the replacement.",
      prepare: async (page, gateway) => {
        await preparePreviousMessages(page);
        await bubble(page, userId).scrollIntoViewIfNeeded();
        await gateway.setHistoryMessages(createEngineTranscript(398));
      },
      run: async (page, gateway) => {
        const menu = await contextMenu(page, bubble(page, userId));
        await menu.getByRole("menuitem", { name: "Rewind to here", exact: true }).click();
        await page
          .locator(".chat-confirm-popover")
          .getByRole("button", { name: "Rewind", exact: true })
          .click();
        await gateway.waitForRequest("sessions.rewind", { match: { sessionKey, entryId: userId } });
        const composer = page.locator(`${activePane} .agent-chat__composer-combobox textarea`);
        await page.waitForFunction(
          (text) =>
            document.querySelector<HTMLTextAreaElement>(
              ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
            )?.value === text,
          userText,
        );
        await bubble(page, answerId).waitFor({ state: "detached" });
        const replacement = `${userText} Include the next validation checkpoint.`;
        await composer.fill(replacement);
        await page.locator(`${activePane} .chat-send-btn--send`).click();
        await gateway.waitForRequest("chat.send", { match: { sessionKey, message: replacement } });
        await page
          .locator(`${activePane} .chat-group.user`)
          .getByText(replacement, { exact: true })
          .waitFor();
        return { rewindRequests: 1, replacementSends: 1 };
      },
    },
    {
      id: "chat-actions-retry",
      route,
      fixtureOverrides: fixture,
      expected:
        "Retrying a failed unsent message starts one new send and clears the failure affordance.",
      prepare: prepareFailedSend,
      run: async (page, gateway) => {
        const before = await gateway.getRequests("chat.send");
        const original = before.at(-1)?.params;
        await page.locator(`${activePane} .chat-send-status__retry`).click();
        const request = await gateway.waitForRequest("chat.send", {
          after: before.length,
          match: { sessionKey, message: failedText },
        });
        if (
          !isRecord(request.params) ||
          !isRecord(original) ||
          request.params.idempotencyKey === original.idempotencyKey
        ) {
          throw new Error("Retry did not create a fresh send attempt");
        }
        await page.locator(`${activePane} .chat-send-status__retry`).waitFor({ state: "detached" });
        await page
          .locator(`${activePane} .chat-group.user`)
          .getByText(failedText, { exact: true })
          .waitFor();
        return { retrySends: 1 };
      },
    },
    {
      id: "chat-actions-discard",
      route,
      fixtureOverrides: fixture,
      rowSelector: ".chat-virtual-row",
      expected:
        "Discard removes a failed unsent message locally; settled-message deletion is not offered.",
      prepare: prepareFailedSend,
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("chat.send")).length;
        await page.locator(`${activePane} .chat-send-status__discard`).click();
        await page
          .locator(`${activePane} .chat-group.user`)
          .filter({ hasText: failedText })
          .waitFor({ state: "detached" });
        if ((await gateway.getRequests("chat.send")).length !== before) {
          throw new Error("Discard sent a message");
        }
        await noRequests(gateway, "sessions.delete");
        return { discardedUnsentMessages: 1 };
      },
    },
    {
      id: "chat-actions-fork",
      route,
      fixtureOverrides: (sandbox, base) => ({
        ...fixture(sandbox, base),
        sessionTranscripts: {
          [forkKey]: { messages: createEngineTranscript(398) },
        },
        methodResponses: {
          "sessions.fork": { sessionKey: forkKey, editorText: userText, editorAttachments: [] },
        },
      }),
      expected:
        "Fork preserves the preceding 398 messages in the returned session and restores the selected prompt.",
      prepare: async (page) => {
        await preparePreviousMessages(page);
        await bubble(page, userId).scrollIntoViewIfNeeded();
      },
      run: async (page, gateway) => {
        const menu = await contextMenu(page, bubble(page, userId));
        await menu.getByRole("menuitem", { name: "Fork from here", exact: true }).click();
        await gateway.waitForRequest("sessions.fork", { match: { sessionKey, entryId: userId } });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(forkKey));
        await bubble(page, "interaction-0-397").waitFor({ state: "visible" });
        await page.waitForFunction(
          (text) =>
            document.querySelector<HTMLTextAreaElement>(
              ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
            )?.value === text,
          userText,
        );
        await noRequests(gateway, "chat.send");
        return { forkRequests: 1, destinationVisible: true };
      },
    },
    {
      id: "chat-actions-context-long",
      route,
      fixtureOverrides: fixture,
      expected:
        "A long answer opens and closes its own copy/reply menu; direct edit/delete/retry remain absent.",
      prepare: async (page) => {
        await prepareChat(page);
        await bubble(page, answerId).scrollIntoViewIfNeeded();
      },
      run: async (page, gateway) => {
        const menu = await contextMenu(page, bubble(page, answerId));
        await menu.getByRole("menuitem", { name: "Copy as markdown", exact: true }).waitFor();
        await menu.getByRole("menuitem", { name: "Reply to message", exact: true }).waitFor();
        for (const name of ["Edit", "Delete", "Retry"]) {
          if (await menu.getByRole("menuitem", { name, exact: true }).count()) {
            throw new Error(`Unexpected settled-message action: ${name}`);
          }
        }
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        await noRequests(gateway, "chat.send");
        return { contextMenus: 1, settledEditDeleteRetrySupported: false };
      },
    },
    {
      id: "chat-actions-reasoning-toggle",
      diagnostic:
        "Compound expand/collapse cycle includes driver and assertion gaps; use the single-action reasoning cases to attribute disclosure latency.",
      route: controlUiSessionPath(workSessionKey),
      fixtureOverrides: workFixture,
      expected:
        "Expanding and collapsing completed work reveals and hides reasoning without a request.",
      prepare: async (page) => {
        await preparePreviousMessages(page);
        await page
          .locator(`${activePane} .chat-work-group > .chat-activity-group__summary`)
          .last()
          .scrollIntoViewIfNeeded();
      },
      run: async (page, gateway) => {
        const toggle = page
          .locator(`${activePane} .chat-work-group > .chat-activity-group__summary`)
          .last();
        await toggle.click();
        await expectExpanded(toggle, true);
        await page
          .locator(`${activePane} .chat-thinking`)
          .filter({ hasText: reasoningText })
          .waitFor({ state: "visible" });
        await toggle.click();
        await expectExpanded(toggle, false);
        await page
          .locator(`${activePane} .chat-thinking`)
          .filter({ hasText: reasoningText })
          .waitFor({ state: "hidden" });
        await noRequests(gateway, "chat.send");
        return { workDisclosureToggles: 2 };
      },
    },
    {
      id: "chat-actions-context-tool",
      route: controlUiSessionPath(workSessionKey),
      fixtureOverrides: workFixture,
      expected: "An expanded grouped tool result opens and closes its code-copy context menu.",
      prepare: async (page) => {
        await prepareToolRows(page);
        await bubble(page, "interaction-0-395").waitFor({ state: "visible" });
        await bubble(page, "interaction-0-395").locator(".chat-tool-row__toggle").press("Space");
        await bubble(page, "interaction-0-395")
          .locator("pre")
          .filter({ hasText: "Synthetic tool result 4." })
          .waitFor();
      },
      run: async (page, gateway) => {
        const menu = await contextMenu(
          page,
          bubble(page, "interaction-0-395")
            .locator("pre")
            .filter({ hasText: "Synthetic tool result 4." }),
        );
        await menu.getByRole("menuitem", { name: "Copy code", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        await noRequests(gateway, "chat.send");
        return { toolContextMenus: 1 };
      },
    },
    {
      id: "chat-actions-tool-toggle",
      diagnostic:
        "Compound expand/collapse cycle includes driver and assertion gaps; use the single-action tool cases to attribute disclosure latency.",
      route: controlUiSessionPath(workSessionKey),
      fixtureOverrides: workFixture,
      expected: "The first grouped tool disclosure opens and closes without sending a request.",
      prepare: async (page) => {
        await prepareToolRows(page);
        const toggle = page.locator(`${activePane} .chat-tool-row__toggle`).first();
        await toggle.waitFor({ state: "visible" });
        if ((await toggle.getAttribute("aria-expanded")) === "true") {
          await toggle.press("Space");
        }
      },
      run: async (page, gateway) => {
        const toggle = page.locator(`${activePane} .chat-tool-row__toggle`).first();
        const output = bubble(page, "interaction-0-387").locator(".chat-tool-msg-body");
        await toggle.press("Space");
        await expectExpanded(toggle, true);
        await output.filter({ hasText: "Synthetic tool result 0." }).waitFor({ state: "visible" });
        await toggle.press("Space");
        await expectExpanded(toggle, false);
        await output.waitFor({ state: "hidden" });
        await noRequests(gateway, "chat.send");
        return { toolDisclosureToggles: 2 };
      },
    },
  ];
  for (const kind of ["reasoning", "tool"] as const) {
    for (const length of ["short", "long"] as const) {
      for (const action of ["expand", "collapse"] as const) {
        const toggle = (page: Page) =>
          kind === "reasoning"
            ? page.locator(`${activePane} .chat-work-group > .chat-activity-group__summary`).last()
            : page.locator(`${activePane} .chat-tool-row__toggle`).first();
        const output = (page: Page) =>
          kind === "reasoning"
            ? page.locator(`${activePane} .chat-thinking`).filter({ hasText: reasoningText })
            : bubble(page, "interaction-0-387").locator(".chat-tool-msg-body");
        const activate = async (page: Page) => {
          if (kind === "reasoning") {
            await toggle(page).click();
          } else {
            await toggle(page).press("Space");
          }
        };
        const scenario: EngineScenario = {
          id: `chat-actions-${kind}-${action}-${length}`,
          route: controlUiSessionPath(workSessionKey),
          fixtureOverrides: (sandbox, base) => ({
            ...workFixture(sandbox, base),
            historyMessages: length === "short" ? workTranscript().slice(385) : workTranscript(),
          }),
          expected: `One ${action} of ${kind} in a ${length} transcript, without a request.`,
          prepare: async (page) => {
            if (kind === "reasoning") {
              await preparePreviousMessages(page);
              await toggle(page).scrollIntoViewIfNeeded();
            } else {
              await prepareToolRows(page);
            }
            if (
              (await toggle(page).getAttribute("aria-expanded")) !== String(action === "collapse")
            ) {
              await activate(page);
            }
            await expectExpanded(toggle(page), action === "collapse");
            await output(page).waitFor({ state: action === "collapse" ? "visible" : "hidden" });
          },
          run: async (page, gateway) => {
            await activate(page);
            await expectExpanded(toggle(page), action === "expand");
            await output(page).waitFor({ state: action === "expand" ? "visible" : "hidden" });
            await noRequests(gateway, "chat.send");
            return {
              disclosureToggles: 1,
              transcriptMessages: length === "short" ? 15 : 400,
            };
          },
        };
        scenarios.push(scenario);
        if (kind === "tool" && action === "expand") {
          scenarios.push({
            ...scenario,
            id: `chat-actions-tool-reopen-${length}`,
            expected: `Reopening loaded tool content in a ${length} transcript without a request.`,
            prepare: async (page, gateway) => {
              await scenario.prepare(page, gateway);
              await activate(page);
              await expectExpanded(toggle(page), true);
              await output(page).waitFor({ state: "visible" });
              await activate(page);
              await expectExpanded(toggle(page), false);
              await output(page).waitFor({ state: "hidden" });
            },
          });
        }
      }
    }
  }
  return scenarios.map((scenario) => Object.assign({}, scenario, { explicitOnly: true }));
}
