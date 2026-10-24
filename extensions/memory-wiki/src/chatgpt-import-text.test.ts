import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { importChatGptConversations } from "./chatgpt-import.js";
import { createChatGptConversation, createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

async function importConversation(user: string, assistant: string): Promise<string> {
  const { rootDir, config, read } = await createVault({ initialize: true });
  const exportPath = path.join(rootDir, "conversations.json");
  await fs.writeFile(exportPath, JSON.stringify([createChatGptConversation(user, assistant)]));

  const result = await importChatGptConversations({ config, exportPath });

  return read(result.actions[0]!.pagePath);
}

it("keeps messages that mention dalle or start with pasted JSON", async () => {
  const page = await importConversation(
    '{"name": "Alice", "city": "Rome", "email": "alice@example.com"}\n\nIs this JSON valid?',
    "Sì, è valido: i valori vanno dalle virgolette alle virgole senza errori.",
  );

  expect(page).toContain("Is this JSON valid?");
  expect(page).toContain("dalle virgolette");
});

it("still drops serialized image parts and reads serialized text parts", async () => {
  const page = await importConversation(
    JSON.stringify({
      content_type: "image_asset_pointer",
      asset_pointer: "file-service://file-abc",
      size_bytes: 1024,
      metadata: { dalle: { prompt: "a cat" } },
    }),
    JSON.stringify({
      content_type: "text",
      text: "A serialized text part that is long enough to be read from its JSON.",
    }),
  );

  expect(page).not.toContain("asset_pointer");
  expect(page).toContain("A serialized text part that is long enough to be read from its JSON.");
});
