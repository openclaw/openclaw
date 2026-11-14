import type { Page } from "playwright";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames, prepareChat } from "./control-ui-interaction-navigation.ts";

const sessionKeys = ["agent:main:interaction-a", "agent:main:interaction-b"] as const;
const activePane = ".chat-pane-cache__pane--active";
const composer = `${activePane} .agent-chat__composer-combobox textarea`;

async function closePanels(page: Page) {
  const pane = page.locator(activePane);
  // Keep the exiting host matched until its visibility transition completes.
  const mobileHost = pane.locator(".chat-mobile-host");
  if (await pane.locator(".agent-chat__header--mobile").isVisible()) {
    await mobileHost
      .locator(".chat-mobile-host__header")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await mobileHost.waitFor({ state: "hidden" });
  } else {
    await pane
      .locator(".sidebar-region__panels-toggle")
      .getByRole("button", { name: "Panels", exact: true })
      .click();
  }
  await prepareChat(page);
}

async function openSessionMenu(page: Page) {
  const pane = page.locator(activePane);
  await pane
    .locator(".chat-header-session-menu__trigger")
    .filter({ visible: true })
    .first()
    .click();
  const menu = pane.locator("openclaw-chat-header-session-menu");
  await menu.locator(".oc-menu:visible").first().waitFor();
  return menu;
}

async function keyboardSession(page: Page, gateway: MockGatewayControls, index: 0 | 1) {
  const query = `Interaction ${String(index).padStart(4, "0")}`;
  const after = (await gateway.getRequests("sessions.search", { query })).length;
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator(".cmd-palette__input");
  await input.fill(query);
  await gateway.waitForRequest("sessions.search", { after, match: { query } });
  const option = page.getByRole("option", { name: new RegExp(query) });
  await option.waitFor({ state: "visible" });
  await input.press("ArrowDown");
  await page.waitForFunction((label) => {
    const searchElement = document.querySelector(".cmd-palette__input");
    const activeId = searchElement?.getAttribute("aria-activedescendant");
    const active = activeId ? document.getElementById(activeId) : null;
    return active?.getAttribute("aria-selected") === "true" && active.textContent?.includes(label);
  }, query);
  await input.press("Enter");
  await input.waitFor({ state: "hidden" });
  await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKeys[index]));
  await page
    .locator(activePane)
    .getByText(`Transcript ${index} message 399.`, { exact: false })
    .waitFor({ state: "visible" });
  await frames(page);
}

export function createChatPanelScenarios(): readonly EngineScenario[] {
  const route = controlUiSessionPath(sessionKeys[0]);
  return [
    {
      id: "chat-actions-terminal",
      route,
      expected:
        "The terminal opens beside 400 messages and closes without ending its PTY or sending chat.",
      rowSelector: "[data-virtual-row-key]",
      fixtureOverrides: () => ({ terminalEnabled: true, featureMethods: ["terminal.open"] }),
      prepare: prepareChat,
      run: async (page, gateway) => {
        const opens = (await gateway.getRequests("terminal.open")).length;
        const closes = (await gateway.getRequests("terminal.close")).length;
        const sends = (await gateway.getRequests("chat.send")).length;
        await page.locator(composer).focus();
        await page.keyboard.press("Control+Backquote");
        await gateway.waitForRequest("terminal.open", { after: opens });
        const terminal = page.locator(`${activePane} [data-panel-slot="terminal"]`);
        await terminal
          .locator(".tp-session.is-current, .tp-host canvas")
          .filter({ visible: true })
          .first()
          .waitFor();
        const current = terminal.locator(".tp-session.is-current");
        if (await current.isVisible()) {
          await current.click();
        }
        await terminal.locator(".tp-host canvas").waitFor({ state: "visible" });
        await closePanels(page);
        await terminal.waitFor({ state: "hidden" });
        const terminalClosed = (await gateway.getRequests("terminal.close")).length - closes;
        const chatSent = (await gateway.getRequests("chat.send")).length - sends;
        if ((await terminal.isVisible()) || terminalClosed !== 0 || chatSent !== 0) {
          throw new Error(
            `Hiding the chat terminal lost its panel or PTY ownership: terminal.close=${terminalClosed}, chat.send=${chatSent}`,
          );
        }
        return {
          openedTerminals: (await gateway.getRequests("terminal.open")).length - opens,
          fixtureMessages: 400,
        };
      },
    },
    {
      id: "chat-actions-diff",
      route,
      expected:
        "Review opens a 20-file diff for the active session and closes back to the transcript.",
      rowSelector: "[data-virtual-row-key]",
      fixtureOverrides: () => ({
        featureMethods: ["sessions.diff"],
        methodResponses: {
          "sessions.diff": {
            sessionKey: sessionKeys[0],
            root: "/workspace/synthetic-chat-actions",
            branch: "feature/synthetic-chat-actions",
            baseRef: "main",
            additions: 20,
            deletions: 20,
            files: Array.from({ length: 20 }, (_, index) => ({
              path: `src/module-${String(index).padStart(2, "0")}.ts`,
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: `@@ -1,2 +1,2 @@\n-export const value = ${index};\n+export const value = ${index + 1};\n // Synthetic review context`,
            })),
          },
        },
      }),
      prepare: prepareChat,
      run: async (page, gateway) => {
        const after = (await gateway.getRequests("sessions.diff")).length;
        const sends = (await gateway.getRequests("chat.send")).length;
        await page.locator(composer).focus();
        await page.keyboard.press("ControlOrMeta+Alt+Shift+e");
        await gateway.waitForRequest("sessions.diff", {
          after,
          match: { sessionKey: sessionKeys[0] },
        });
        const diff = page.locator(`${activePane} [data-panel-slot="detail"]`);
        await diff
          .getByText("module-00.ts", { exact: true })
          .filter({ visible: true })
          .first()
          .waitFor({ state: "visible" });
        await closePanels(page);
        await diff.waitFor({ state: "hidden" });
        if ((await diff.isVisible()) || (await gateway.getRequests("chat.send")).length !== sends) {
          throw new Error("Closing Review failed to restore chat without sending a message");
        }
        return { diffFiles: 20, fixtureMessages: 400 };
      },
    },
    {
      id: "chat-actions-split-view",
      route,
      viewports: ["desktop"],
      expected:
        "Desktop split view opens a second pane and closing it restores the original chat; opening splits is unavailable on mobile.",
      rowSelector: "[data-virtual-row-key]",
      prepare: prepareChat,
      run: async (page, gateway) => {
        const sends = (await gateway.getRequests("chat.send")).length;
        const deletes = (await gateway.getRequests("sessions.delete")).length;
        const menu = await openSessionMenu(page);
        await menu.getByRole("menuitem", { name: "Open split view", exact: true }).click();
        await page.waitForFunction(
          () => document.querySelectorAll(".chat-split-view__cell").length === 2,
        );
        await page.locator(composer).waitFor({ state: "visible" });
        const closeMenu = await openSessionMenu(page);
        if (await page.locator(`${activePane} .agent-chat__header--mobile`).isVisible()) {
          await closeMenu.getByRole("menuitem", { name: "Advanced", exact: true }).click();
          await page
            .locator(`${activePane} .chat-mobile-host`)
            .getByRole("button", { name: "Close pane", exact: true })
            .click();
        } else {
          await closeMenu.getByRole("menuitem", { name: "View", exact: true }).click();
          await closeMenu.getByRole("menuitem", { name: "Close pane", exact: true }).click();
        }
        await page.waitForFunction(
          () => document.querySelectorAll(".chat-split-view__cell").length === 1,
        );
        await prepareChat(page);
        if (
          (await gateway.getRequests("chat.send")).length !== sends ||
          (await gateway.getRequests("sessions.delete")).length !== deletes
        ) {
          throw new Error("Closing a split pane mutated the underlying session");
        }
        return { openedPanes: 2, survivingPanes: 1 };
      },
    },
    {
      id: "chat-actions-keyboard-session-navigation",
      route,
      expected:
        "Keyboard palette selection switches between two retained 400-message sessions without sending chat.",
      rowSelector: "[data-virtual-row-key]",
      prepare: async (page, gateway) => {
        await prepareChat(page);
        await keyboardSession(page, gateway, 1);
        await keyboardSession(page, gateway, 0);
      },
      run: async (page, gateway) => {
        const sends = (await gateway.getRequests("chat.send")).length;
        await keyboardSession(page, gateway, 1);
        await keyboardSession(page, gateway, 0);
        if ((await gateway.getRequests("chat.send")).length !== sends) {
          throw new Error("Keyboard session navigation sent a chat message");
        }
        return { sessionSwitches: 2, fixtureMessages: 800 };
      },
    },
  ];
}
