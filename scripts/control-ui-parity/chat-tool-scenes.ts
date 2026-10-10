import type { Page } from "playwright";
import { fixedTime, sessionKey } from "./fixtures.ts";
import type { Scene } from "./scenarios.ts";

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
        await toggle.click();
      }
      await page.locator("wa-tab-group").first().waitFor();
    },
  },
];
