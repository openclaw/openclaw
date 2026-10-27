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

it.each([
  '{"name": "Alice", "city": "Rome", "email": "alice@example.com"}\n\nIs this JSON valid?',
  JSON.stringify({
    content_type: "application/json",
    asset_pointer: "example",
    description: "A pasted object, not a ChatGPT part",
    value: 42,
  }),
])("keeps ordinary messages mentioning dalle and pasted JSON: %s", async (user) => {
  const assistant = "Sì, è valido: i valori vanno dalle virgolette alle virgole senza errori.";
  const page = await importConversation(user, assistant);
  expect(page).toContain(user);
  expect(page).toContain(assistant);
  expect(page).toContain("Active-branch messages: 2");
});

it("drops serialized image parts and decodes serialized text parts", async () => {
  const text =
    'A serialized text part with "quoted text" that is long enough to be read from its JSON.';
  const page = await importConversation(
    JSON.stringify({
      content_type: "image_asset_pointer",
      asset_pointer: "file-service://file-abc",
      size_bytes: 1024,
      metadata: { dalle: { prompt: "a cat" } },
    }),
    JSON.stringify({ content_type: "text", text }),
  );
  expect(page).not.toContain("asset_pointer");
  expect(page).toContain(text);
  expect(page).toContain("Active-branch messages: 1");
});
