import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { importChatGptConversations } from "./chatgpt-import.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

it("keeps imported label ordering and exclusive work topics across overlapping signals", async () => {
  const { rootDir, config } = await createVault();
  const conversations = [
    {
      conversation_id: "all",
      title:
        "Translate Anki flight recipe garden dating investment tax therapy book an appointment robot docker job router Porsche",
    },
    { conversation_id: "career", title: "Resume" },
    { conversation_id: "language", title: "Portuguese" },
    { conversation_id: "software", title: "Docker resume" },
  ];
  const exportPath = path.join(rootDir, "conversations.json");
  await fs.writeFile(exportPath, JSON.stringify(conversations));

  const result = await importChatGptConversations({ config, exportPath, dryRun: true });

  expect(result.actions.map(({ conversationId, labels }) => ({ conversationId, labels }))).toEqual([
    {
      conversationId: "all",
      labels: [
        "domain/personal",
        "topic/translation",
        "area/language-learning",
        "topic/language-learning",
        "area/travel",
        "topic/travel",
        "area/cooking",
        "topic/cooking",
        "area/gardening",
        "topic/gardening",
        "area/relationships",
        "topic/relationships",
        "area/finance",
        "topic/finance",
        "area/legal-tax",
        "topic/legal-tax",
        "area/health",
        "topic/health",
        "area/life-admin",
        "topic/life-admin",
        "area/work",
        "topic/robotics",
        "area/home",
        "topic/home-infrastructure",
        "area/vehicles",
        "topic/vehicles",
      ],
    },
    { conversationId: "career", labels: ["domain/personal", "area/work", "topic/career"] },
    { conversationId: "language", labels: ["domain/personal", "area/other"] },
    { conversationId: "software", labels: ["domain/personal", "area/work", "topic/software"] },
  ]);
});
