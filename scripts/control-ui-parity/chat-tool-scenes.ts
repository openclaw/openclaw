import type { Page } from "playwright";
import { buildSandboxHostDocument, buildSandboxHostPath } from "../../src/agents/sandbox-host.js";
import { openChatSidePanelType } from "../../ui/src/e2e/chat-side-panel.test-support.ts";
import { fixedTime, parityBaseScenario, sessionKey } from "./fixtures.ts";
import type { Scene } from "./scenarios.ts";

const previewHtml =
  "<!doctype html><html><head><style>body{margin:24px;font:16px system-ui;color:#243047}h1{font-size:24px}table{border-collapse:collapse}td{padding:12px 24px 12px 0;border-bottom:1px solid #ccd6e4}</style></head><body><h1>Synthetic HTML report</h1><p>The preview keeps this report inside its file tab.</p><table><tr><td>Preview</td><td>Ready</td></tr><tr><td>Source</td><td>Preserved</td></tr></table></body></html>";
const sandboxOrigin = "http://parity-sandbox.localhost:18790";
const sandboxPolicy = { blockDescendantFrames: true };

const historyMessages = [
  {
    role: "user",
    content: "Review the synthetic changes and command output.",
    timestamp: fixedTime - 5_000,
  },
  ...["first", "second"].flatMap((name, index) => [
    {
      role: "assistant",
      timestamp: fixedTime - 4_000 + index * 1_000,
      __openclaw: { id: `parity-patch-${name}` },
      content: [
        {
          type: "toolCall",
          id: "reused-patch",
          name: "apply_patch",
          arguments: {
            changes: [
              {
                path: `src/${name}.ts`,
                kind: { type: "update" },
                diff: "@@ -1 +1 @@\n-const ready = false;\n+const ready = true;\n",
              },
            ],
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "reused-patch",
      toolName: "apply_patch",
      timestamp: fixedTime - 3_500 + index * 1_000,
      content: [{ type: "text", text: `Updated synthetic ${name}.ts` }],
      __openclaw: { id: `parity-result-${name}` },
    },
  ]),
  {
    role: "assistant",
    content: "Both synthetic files are ready for review.",
    timestamp: fixedTime - 1_000,
  },
];

async function openActivities(page: Page) {
  await page.getByText("Both synthetic files are ready for review.", { exact: true }).waitFor();
  for (const group of await page
    .locator('.chat-activity-group__summary[aria-expanded="false"]')
    .all()) {
    await group.click();
  }
}

export const chatToolScenes: Scene[] = [
  {
    id: "chat-tools-collapsed",
    label: "Chat: collapsed tool results",
    path: `/chat?session=${sessionKey}`,
    ready: ".chat-thread",
    scenario: { historyMessages },
    prepare: openActivities,
  },
  {
    id: "chat-tools-expanded",
    label: "Chat: expanded patch results with reused call IDs",
    path: `/chat?session=${sessionKey}`,
    ready: ".chat-thread",
    scenario: { historyMessages },
    prepare: async (page) => {
      await openActivities(page);
      for (const toggle of await page
        .locator(
          '.chat-tool-row__toggle[aria-expanded="false"], button.chat-tool-msg-summary[aria-expanded="false"]',
        )
        .all()) {
        await toggle.focus();
        await toggle.press("Enter");
      }
      await page.locator("wa-tab-group").first().waitFor();
    },
  },
  {
    id: "chat-tools-svg-attachment",
    label: "Chat: SVG attachment preview",
    path: `/chat?session=${sessionKey}`,
    ready: "openclaw-chat-page",
    scenario: {
      deferredMethods: ["chat.startup"],
      historyMessages: [
        {
          role: "assistant",
          timestamp: fixedTime - 1_000,
          content: [
            { type: "text", text: "A synthetic diagram for review." },
            {
              type: "attachment",
              attachment: {
                kind: "image",
                label: "preview.svg",
                mimeType: "image/svg+xml",
                url: "http://parity.localhost:18789/parity-preview.svg",
              },
            },
          ],
        },
      ],
    },
    prepare: async (page, gateway) => {
      await page.route("**/parity-preview.svg", (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" viewBox="0 0 400 220"><rect width="400" height="220" rx="16" fill="#edf3fa"/><path d="M95 110h210" stroke="#55708f" stroke-width="4"/><rect x="35" y="70" width="120" height="80" rx="12" fill="#315c84"/><rect x="245" y="70" width="120" height="80" rx="12" fill="#287c63"/><g fill="white" font-family="sans-serif" font-size="18" text-anchor="middle"><text x="95" y="116">Source</text><text x="305" y="116">Preview</text></g></svg>',
        }),
      );
      await gateway.waitForRequest("chat.startup");
      await gateway.resolveDeferred("chat.startup");
      await page.locator("openclaw-chat-svg-attachment img.chat-message-image").waitFor();
    },
  },
  {
    id: "chat-tools-html-preview",
    label: "Chat: HTML file preview in its sandbox",
    // Playwright's blocking init script throws when it enters the opaque inner frame.
    serviceWorkers: "allow",
    path: `/chat?session=${sessionKey}`,
    ready: ".chat-thread",
    scenario: {
      workspace: "/workspace",
      featureMethods: [...(parityBaseScenario.featureMethods ?? []), "canvas.document.preview"],
      historyMessages: [
        {
          role: "assistant",
          timestamp: fixedTime - 1_000,
          content: [{ type: "text", text: "Inspect [preview.html](preview.html)." }],
        },
      ],
      methodResponses: {
        "sessions.files.get": {
          root: "/workspace",
          sessionKey,
          file: {
            name: "preview.html",
            path: "preview.html",
            workspacePath: "preview.html",
            content: previewHtml,
            contentEncoding: "utf8",
            hash: "a".repeat(64),
            kind: "read",
            missing: false,
            previewKind: "text",
            mimeType: "text/html",
            size: Buffer.byteLength(previewHtml),
          },
        },
        "canvas.document.preview": {
          html: previewHtml,
          sandboxUrl: buildSandboxHostPath(sandboxPolicy),
          sandboxPort: 18790,
          sandboxOrigin,
        },
      },
    },
    prepare: async (page) => {
      const sandbox = buildSandboxHostDocument(sandboxPolicy);
      await page.route(`${sandboxOrigin}/mcp-app-sandbox**`, (route) =>
        route.fulfill({ body: sandbox.html, headers: sandbox.headers }),
      );
      await page.locator('a.markdown-file-link[data-file-path="preview.html"]').click();
      const panel = page.locator("openclaw-chat-detail-panel:visible");
      await panel
        .locator(".chat-html-preview__frame")
        .contentFrame()
        .frameLocator("iframe")
        .getByRole("heading", { name: "Synthetic HTML report", exact: true })
        .waitFor();
      await panel.locator("openclaw-chat-html-preview [role=status]").waitFor({ state: "hidden" });
    },
  },
  {
    id: "chat-tools-session-diff",
    label: "Chat: session diff in the Review panel",
    path: `/chat?session=${sessionKey}`,
    ready: ".chat-thread",
    scenario: {
      workspace: "/workspace",
      featureMethods: [...(parityBaseScenario.featureMethods ?? []), "sessions.diff"],
      historyMessages: [
        {
          role: "assistant",
          content: "The synthetic change is ready for review.",
          timestamp: fixedTime - 1_000,
        },
      ],
      methodResponses: {
        "sessions.files.list": {
          sessionKey,
          root: "/workspace",
          gitCheckout: true,
          files: [],
          browser: { path: "", entries: [] },
        },
        "sessions.diff": {
          sessionKey,
          root: "/workspace",
          branch: "parity/preview",
          baseRef: "main",
          additions: 1,
          deletions: 1,
          files: [
            {
              path: "src/preview.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: "@@ -1 +1 @@\n-export const ready = false;\n+export const ready = true;\n",
            },
          ],
        },
      },
    },
    prepare: async (page) => {
      await openChatSidePanelType(page, "Files");
      await openChatSidePanelType(page, "Review");
      const file = page.locator(".session-diff__file").first();
      const toggle = file.locator(".session-diff__file-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
      await file.locator(".session-diff__file-body").waitFor();
    },
  },
];
