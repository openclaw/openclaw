import type { Page } from "playwright";
import { expect } from "vitest";
import {
  activated,
  candidate,
  makeDetection,
  runningStep,
  runningWizard,
  setupRpc,
} from "../../ui/src/e2e/model-setup-fixtures.test-support.ts";
import {
  configMocks,
  inspection,
  inventory,
  workboard,
} from "../../ui/src/e2e/plugins-settings-admin.test-support.ts";
import type { ControlUiMockGatewayScenario } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../../ui/src/test-helpers/skill-library-fixtures.ts";
import { sessionKey } from "../control-ui-parity/fixtures.ts";
import { baseScenario, type Scene } from "../control-ui-parity/scenarios.ts";

const chat = {
  route: "chat",
  path: `/chat?session=${sessionKey}`,
  ready: "openclaw-chat-pane",
} as const;
const models = {
  route: "model-providers",
  path: "/settings/model-providers?connect=1",
  ready: "[data-models-login-discover]",
} as const;
const passage = "Review the deployment checklist.";
const file = { name: "AGENTS.md", path: "/synthetic/workspace/AGENTS.md", missing: false };
const fileContent = "# Preview tooltip fixture\n\nSynthetic preview instructions.\n";
const [selectedSkill, otherSkill, teamSkill] = buildSkillLibraryMock();
const originalRef = { source: "file", provider: "team", id: "/search/apiKey" };
const credentialConfig = {
  plugins: {
    entries: {
      workboard: { enabled: true, config: { search: { apiKey: originalRef, mode: "web" } } },
    },
  },
};
const credentialSchema = {
  type: "object",
  properties: {
    plugins: {
      type: "object",
      properties: {
        entries: {
          type: "object",
          properties: {
            workboard: {
              type: "object",
              properties: {
                config: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    search: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        apiKey: { type: ["string", "object"] },
                        mode: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
const modelScenario: ControlUiMockGatewayScenario = {
  featureMethods: [
    ...baseScenario.featureMethods!,
    setupRpc.detect,
    setupRpc.auth,
    setupRpc.activate,
    setupRpc.next,
    setupRpc.cancel,
  ],
  methodResponses: {
    "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
    [setupRpc.detect]: makeDetection({
      setupComplete: true,
      candidates: [
        candidate("saved-auth:openai:replacement", "Saved OpenAI sign-in", "openai/gpt-5", {
          brandId: "openai",
          detail: "Saved but inactive. Test this sign-in again to activate it.",
        }),
      ],
      authOptions: [{ id: "setup-only", label: "Setup account", kind: "oauth", featured: true }],
    }),
    [setupRpc.auth]: runningWizard(),
    [setupRpc.activate]: runningWizard(),
    [setupRpc.next]: runningStep("account", "text", "Setup account name"),
    [setupRpc.cancel]: { status: "cancelled" },
  },
};

async function openDiscovery(page: Page) {
  await page.locator("[data-models-login-discover]").click();
  await page.getByRole("heading", { name: "On this Gateway", exact: true }).waitFor();
}

// Recipes: chat-attachment-menu, chat-comment-lifecycle, session-placement.menu,
// agent-file-lifecycle, model-providers.discovery, model-setup-replacement,
// plugins-credentials, chat-skill-library, and chat-file-editor-recovery E2E suites.
export const resourceDialogScenes: Scene[] = [
  {
    ...chat,
    id: "dialog-camera-resources",
    label: "Synthetic camera preview, capture, retake, and cancellation",
    prepare: async (page) => {
      // The harness launches Chromium with --use-fake-device-for-media-stream.
      await page.context().grantPermissions(["camera"]);
      await page.getByRole("button", { name: "Add attachment", exact: true }).click();
      await page.getByRole("menuitem", { name: "Take photo", exact: true }).click();
      const camera = page.locator("openclaw-chat-camera-capture");
      const capture = camera.getByRole("button", { name: "Capture", exact: true });
      await expect.poll(() => capture.isEnabled()).toBe(true);
      const firstStream = await camera
        .locator("video")
        .evaluateHandle((video: HTMLVideoElement) => video.srcObject as MediaStream);
      try {
        await capture.click();
        await camera.getByRole("button", { name: "Use photo", exact: true }).waitFor();
        expect(
          await firstStream.evaluate((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          ),
        ).toBe(true);
      } finally {
        await firstStream.dispose();
      }
      await camera.getByRole("button", { name: "Retake", exact: true }).click();
      await expect.poll(() => capture.isEnabled()).toBe(true);
      const secondStream = await camera
        .locator("video")
        .evaluateHandle((video: HTMLVideoElement) => video.srcObject as MediaStream);
      try {
        await camera.getByRole("button", { name: "Cancel", exact: true }).click();
        await camera
          .getByRole("dialog", { name: "Take photo", exact: true })
          .waitFor({ state: "detached" });
        expect(
          await secondStream.evaluate((stream) =>
            stream.getTracks().every((track) => track.readyState === "ended"),
          ),
        ).toBe(true);
      } finally {
        await secondStream.dispose();
      }
    },
  },
  {
    ...chat,
    id: "dialog-comment-editor",
    label: "Selected transcript comment editor",
    scenario: { historyMessages: [{ role: "assistant", content: passage }] },
    prepare: async (page) => {
      const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
      await source.waitFor();
      await source.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await source.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
      await page
        .getByRole("toolbar", { name: "Selection actions" })
        .getByRole("button", { name: "Add to chat", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Comment", exact: true })
        .getByRole("textbox")
        .waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-session-placement",
    label: "Session placement destination picker",
    scenario: {
      featureMethods: [
        ...baseScenario.featureMethods!,
        "sessions.dispatch",
        "sessions.move",
        "environments.list",
      ],
      sessions: [
        {
          key: sessionKey,
          sessionId: "retention-placement",
          kind: "direct",
          label: "Review release notes",
          updatedAt: Date.now(),
          status: "done",
          hasActiveRun: false,
          worktree: {
            id: "notes-workspace",
            branch: "release-notes",
            repoRoot: "/example/project",
          },
        },
      ],
      methodResponses: {
        "environments.list": {
          profiles: [{ id: "cloud", providerId: "crabbox", providerDisplayId: "aws" }],
          environments: [
            {
              id: "node:runner",
              type: "node",
              label: "Build device",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
        },
      },
    },
    prepare: async (page) => {
      await page
        .getByRole("button", { name: "Actions for Review release notes", exact: true })
        .click();
      await page
        .locator("openclaw-chat-header-session-menu")
        .getByText("Move to cloud…", { exact: true })
        .click();
      await page.locator('openclaw-modal-dialog [data-value="device:runner"]').waitFor();
    },
  },
  {
    route: "agents",
    path: "/settings/agents/main/files",
    ready: ".agent-file-textarea",
    id: "dialog-agent-file-preview",
    label: "Agent Markdown file preview",
    scenario: {
      featureMethods: [
        ...baseScenario.featureMethods!,
        "agents.files.get",
        "agents.files.list",
        "agents.files.set",
      ],
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", name: "Main" }],
        },
        "agents.files.list": { agentId: "main", workspace: "/synthetic/workspace", files: [file] },
        "agents.files.get": {
          agentId: "main",
          workspace: "/synthetic/workspace",
          files: [file],
          file: { ...file, content: fileContent },
        },
      },
    },
    prepare: async (page) => {
      await expect.poll(() => page.locator(".agent-file-textarea").inputValue()).toBe(fileContent);
      await page
        .locator(".agent-file-actions")
        .getByRole("button", { name: "Preview", exact: true })
        .click();
      await page.locator("openclaw-modal-dialog .md-preview-dialog__reader").waitFor();
      await page.locator(".md-preview-expand-btn").click();
      await page.locator(".md-preview-dialog__panel.fullscreen").waitFor();
    },
  },
  {
    ...models,
    id: "dialog-model-discovery",
    label: "Model discovery",
    scenario: modelScenario,
    prepare: openDiscovery,
  },
  {
    ...models,
    id: "dialog-model-auth-wizard",
    label: "Embedded model setup wizard",
    scenario: modelScenario,
    prepare: async (page) => {
      await openDiscovery(page);
      await page.locator('[data-auth-choice="setup-only"] button').click();
      await page.locator('input[name="wizard-text"]').waitFor();
    },
  },
  {
    ...models,
    id: "dialog-model-success",
    label: "Model activation success",
    scenario: {
      ...modelScenario,
      methodResponses: {
        ...modelScenario.methodResponses,
        [setupRpc.next]: activated("openai/gpt-5"),
      },
    },
    prepare: async (page) => {
      await openDiscovery(page);
      await page
        .locator('[data-candidate-kind="saved-auth:openai:replacement"]')
        .getByRole("button", { name: "Test & use for this agent", exact: true })
        .click();
      await page.locator(".model-setup-success").waitFor();
      await page.getByRole("heading", { name: "Connection verified", exact: true }).waitFor();
    },
  },
  {
    route: "plugin-settings",
    path: "/settings/plugins/workboard?view=settings",
    ready: "openclaw-plugin-settings-editor",
    id: "dialog-plugin-credential",
    label: "Plugin secret reference editor",
    scenario: {
      featureMethods: [
        ...baseScenario.featureMethods!,
        "config.set",
        "plugins.inspect",
        "plugins.credentials.inspect",
      ],
      methodResponses: {
        "plugins.list": { ...inventory, plugins: [workboard] },
        "plugins.inspect": {
          ...inspection,
          catalog: undefined,
          credentials: [
            {
              path: ["plugins", "entries", "workboard", "config", "search", "apiKey"],
              label: "Search API key",
              envVars: ["SEARCH_API_KEY"],
              signupUrl: "https://provider.example/signup",
              placeholder: "demo-key",
            },
          ],
        },
        "plugins.credentials.inspect": {
          baseHash: configMocks["config.get"].hash,
          credential: { kind: "reference", ref: originalRef, unresolved: false },
        },
        "config.get": {
          ...configMocks["config.get"],
          config: credentialConfig,
          raw: JSON.stringify(credentialConfig),
        },
        "config.schema": {
          ...configMocks["config.schema"],
          schema: credentialSchema,
          uiHints: {
            "plugins.entries.workboard.config.search.apiKey": {
              label: "Search API key",
              sensitive: true,
            },
            "plugins.entries.workboard.config.search.mode": { label: "Search mode" },
          },
        },
      },
    },
    prepare: async (page) => {
      await page
        .getByRole("button", { name: "Edit reference: Search API key", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Secret reference: Search API key",
        exact: true,
      });
      await dialog.waitFor();
      await expect
        .poll(() => dialog.getByLabel("Identifier", { exact: true }).inputValue())
        .toBe("/search/apiKey");
    },
  },
  {
    ...chat,
    id: "dialog-session-skill-reader",
    label: "Session-selected retained skill revision",
    scenario: {
      methodResponses: {
        "skills.library.list": {
          entries: [otherSkill.entry, teamSkill.entry],
          profileId: "profile-bob",
          multipleProfiles: true,
          defaultTarget: "personal",
          canManageWorkspace: false,
          defaultSelectionLimit: 64,
          session: {
            sessionKey,
            selections: [
              {
                skillId: selectedSkill.entry.skillId,
                revision: selectedSkill.entry.revision,
                name: selectedSkill.entry.name,
                ownerProfileId: selectedSkill.entry.ownerProfileId,
                ownerLabel: selectedSkill.entry.ownerLabel,
                slug: selectedSkill.entry.slug,
                description: selectedSkill.entry.description,
              },
            ],
            attachable: [otherSkill.entry, teamSkill.entry],
          },
        },
        "skills.library.read": {
          ...selectedSkill,
          entry: { ...selectedSkill.entry, canEdit: false },
        },
      },
    },
    prepare: async (page) => {
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await pane.getByRole("button", { name: "Add attachment", exact: true }).click();
      const menu = pane.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: "Skills", exact: true }).click();
      await menu.getByText("Selected for this session", { exact: true }).waitFor();
      await menu
        .locator(`.oc-menu-item[data-value="library-selected:${selectedSkill.entry.skillId}"]`)
        .click();
      await menu.getByRole("menuitem", { name: "Read selected revision", exact: true }).click();
      await page.locator(".skill-reader-dialog").getByLabel("SKILL.md", { exact: true }).waitFor();
    },
  },
  {
    ...chat,
    id: "resource-file-editor",
    label: "Session file CodeMirror editor",
    scenario: {
      historyMessages: [{ role: "assistant", content: "Review `notes.txt`.", timestamp: 1 }],
      methodResponses: {
        "sessions.files.get": {
          root: "/workspace",
          file: {
            previewKind: "text",
            contentEncoding: "utf8",
            content: "Synthetic notes.txt content",
            kind: "read",
            missing: false,
            name: "notes.txt",
            path: "notes.txt",
            workspacePath: "notes.txt",
          },
        },
      },
    },
    prepare: async (page) => {
      await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
      await page.locator(".cm-content").waitFor();
      await expect
        .poll(() => page.locator(".cm-content").textContent())
        .toContain("Synthetic notes.txt content");
      await page.getByRole("button", { name: "Close tab: notes.txt", exact: true }).click();
      await page.locator(".cm-content").waitFor({ state: "detached" });
    },
  },
];
