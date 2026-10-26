import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect } from "vitest";
import { controlUiE2eBuiltModuleRequest } from "../../ui/src/e2e/control-ui-built-module.test-support.ts";
import { sessionKey } from "../control-ui-parity/fixtures.ts";
import { baseScenario, type Scene } from "../control-ui-parity/scenarios.ts";

const chat = {
  route: "chat",
  path: `/chat?session=${sessionKey}`,
  ready: "openclaw-chat-pane",
} as const;
const newSession = {
  route: "new-session",
  path: "/new",
  ready: "openclaw-new-session-page",
} as const;
// Seed once per document without retaining Page objects or browser callbacks.
const usageSeeded = new WeakSet<Page>();
const privateSeeded = new WeakSet<Page>();
const paletteIntercepted = new WeakSet<Page>();
const privateText = "Synthetic private draft for retention measurement.";

export const specialDialogScenes: Scene[] = [
  {
    ...chat,
    id: "dialog-onboarding-memory-import",
    label: "Onboarding memory offer (synthetic once-per-tab guard reset)",
    scenario: {
      featureMethods: [...baseScenario.featureMethods!, "migrations.memory.plan"],
      methodResponses: {
        "migrations.memory.plan": {
          agentId: "main",
          workspace: "/synthetic/workspace",
          providers: [
            {
              providerId: "codex",
              label: "Codex",
              planFingerprint: "a".repeat(64),
              found: true,
              source: "/synthetic/codex",
              target: "/synthetic/workspace",
              summary: {
                total: 1,
                planned: 1,
                migrated: 0,
                skipped: 0,
                conflicts: 0,
                errors: 0,
                sensitive: 0,
              },
              items: [
                {
                  id: "memory:codex:MEMORY.md",
                  status: "planned",
                  source: "/synthetic/codex/MEMORY.md",
                },
              ],
            },
          ],
        },
      },
    },
    prepare: async (page) => {
      // The offer intentionally appears once per tab. Rearm only its named
      // synthetic storage trigger, then enter through the ordinary route.
      await page.evaluate(() => {
        sessionStorage.removeItem("openclaw.onboarding.memory-import");
        window.openclawControlUi!.navigate("new-session", {
          pathname: "/new",
          search: "?onboarding=1",
          hash: "",
        });
      });
      const dialog = page.locator(".onboarding-memory-import-dialog");
      await dialog.waitFor();
      await dialog.getByText("Codex", { exact: true }).waitFor();
      await dialog.locator('[data-test-id="onboarding-memory-import-skip"]').click();
      await dialog.waitFor({ state: "detached" });
    },
  },
  {
    route: "skills",
    path: "/skills?clawhub=%40fixture%2Fguide",
    ready: "openclaw-skills-page",
    id: "dialog-clawhub-skill-detail",
    label: "ClawHub skill details",
    scenario: {
      featureMethods: [...baseScenario.featureMethods!, "skills.status", "skills.detail"],
      methodResponses: {
        "skills.status": {
          workspaceDir: "/synthetic/workspace",
          managedSkillsDir: "/synthetic/skills",
          skills: [],
        },
        "skills.detail": {
          skill: {
            slug: "guide",
            displayName: "Guide",
            summary: "Review and verification instructions.",
            createdAt: 1,
            updatedAt: 2,
          },
          owner: { displayName: "Fixture operator" },
          latestVersion: {
            version: "1.0.0",
            createdAt: 2,
            changelog: "# Release notes\n\nSynthetic verification instructions.",
          },
        },
      },
    },
    prepare: async (page) => {
      const dialog = page.getByRole("dialog", { name: "Guide", exact: true });
      await dialog.locator(".skill-reader-dialog__body").waitFor();
      await dialog.getByRole("heading", { name: "Release notes", exact: true }).waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-chatgpt-usage-limit",
    label: "ChatGPT usage-limit modal (one failed run, repeated reopening)",
    prepare: async (page, gateway) => {
      if (!usageSeeded.has(page)) {
        const sentBefore = (await gateway.getRequests("chat.send")).length;
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        await pane
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Synthetic usage-limit request.");
        await pane.getByRole("button", { name: "Send message", exact: true }).click();
        const sent = await gateway.waitForRequest("chat.send", { after: sentBefore });
        if (!isRecord(sent.params) || typeof sent.params.idempotencyKey !== "string") {
          throw new Error("Usage-limit fixture requires the admitted chat run identity");
        }
        await gateway.emitGatewayEvent("chat", {
          runId: sent.params.idempotencyKey,
          sessionKey,
          state: "error",
          errorMessage: "Synthetic usage limit reached",
          errorDetail: {
            provider: "openai",
            httpStatus: 429,
            providerErrorCode: "subscription_sharing_usage_limit_exceeded",
          },
        });
        await page.locator(".chatgpt-usage-limit-modal").getByRole("dialog").waitFor();
        usageSeeded.add(page);
      } else {
        await page
          .locator(".chat-composer-neighbor-card--warn")
          .getByRole("button", { name: "Details", exact: true })
          .click();
      }
      const dialog = page.locator(".chatgpt-usage-limit-modal").getByRole("dialog");
      await dialog.waitFor();
      await dialog.getByRole("link", { name: "Manage usage", exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    },
  },
  {
    ...newSession,
    id: "dialog-private-composer-recovery",
    label: "Unsent Incognito draft recovery (one blocked update, repeated review)",
    prepare: async (page, gateway) => {
      if (!privateSeeded.has(page)) {
        await page.getByRole("switch", { name: "Incognito", exact: true }).click();
        await page.locator(".new-session-page textarea").fill(privateText);
        await page.locator(".new-session-page .agent-chat__file-input").setInputFiles({
          name: "private-start.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic private attachment"),
        });
        await page.getByText("private-start.txt", { exact: true }).first().waitFor();
        await gateway.setOnline(false);
        await gateway.deferNext("connect");
        const connects = (await gateway.getRequests("connect")).length;
        await gateway.setOnline(true);
        await gateway.waitForRequest("connect", { after: connects });
        await gateway.rejectDeferred("connect", {
          code: "UNAVAILABLE",
          message: "protocol mismatch: Control UI updated; reload this page to continue",
          details: {
            code: "PROTOCOL_MISMATCH",
            gatewayBuildId: "synthetic-retention-replacement",
            reloadRequired: true,
          },
          retryable: false,
        });
      }
      await page.getByRole("button", { name: /Server updated/u }).click();
      await page.getByRole("button", { name: "Review private draft", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Unsent Incognito draft", exact: true });
      await expect
        .poll(() => dialog.getByRole("textbox", { name: "Draft text", exact: true }).inputValue())
        .toBe(privateText);
      await dialog
        .getByRole("button", { name: "Download private-start.txt", exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "Keep in this tab", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      privateSeeded.add(page);
    },
  },
  {
    ...chat,
    id: "dialog-lazy-view-failure",
    label: "Failed command-palette chunk modal",
    prepare: async (page) => {
      if (!paletteIntercepted.has(page)) {
        const moduleRequest = controlUiE2eBuiltModuleRequest(
          "ui/src/components/command-palette.tsx",
          path.resolve(process.env.OPENCLAW_RETENTION_BUNDLE ?? "dist/control-ui"),
        );
        // Keep recovery probes unavailable so an observed failure cannot reload
        // the measured document. Both handlers belong to this page/context.
        await page.route("**/*", async (route) => {
          if (route.request().method() === "HEAD") {
            await route.fulfill({ status: 503 });
          } else {
            await route.fallback();
          }
        });
        await page.route(moduleRequest, (route) => route.abort("internetdisconnected"));
        paletteIntercepted.add(page);
      }
      await page.keyboard.press("ControlOrMeta+K");
      const error = page.locator("openclaw-modal-dialog .lazy-view-error");
      await error.waitFor();
      await expect
        .poll(() => error.textContent())
        .toContain("Failed to fetch dynamically imported module");
      await error.getByRole("button", { name: "Close", exact: true }).click();
      await error.waitFor({ state: "detached" });
    },
  },
];

export const specialDialogCoverageNotes = [
  "Onboarding repetition resets only the synthetic tab's documented once-per-tab memory-offer guard before navigating into onboarding.",
  "Usage-limit and private recovery reopen one seeded failure; transcript additions, update rejection, and attachment admission occur only once per document.",
  "Lazy-view failure intercepts one real production chunk and holds HTTP HEAD probes unavailable; page routes are released when the census context closes.",
  "MCP confirmation uses the official App SDK and sandbox document over a loopback server with synthetic Gateway transport; it does not mount components directly.",
];
