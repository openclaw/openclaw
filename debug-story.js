import * as dotenv from "dotenv";
import { GraphService } from "./src/services/GraphService.js";
dotenv.config();

const sessionId = process.argv[2];

if (!sessionId) {
  console.error("Please provide a sessionId: node debug-story.js <sessionId>");
  process.exit(1);
}

async function debugStory() {
  const graph = new GraphService(process.env.GRAPHITI_MCP_URL || "http://localhost:8001");
  console.log(`🔍 Checking Narrative Story for session: ${sessionId}...`);

  try {
    const story = await graph.getStory(sessionId);
    if (story) {
      console.log("\n📖 CURRENT NARRATIVE STORY:");
      console.log("------------------------------------------");
      console.log(story);
      console.log("------------------------------------------");
      console.log(`Length: ${story.length} chars`);
    } else {
      console.log("❌ No Narrative Story found for this session.");
    }
  } catch (e) {
    console.error("Error fetching story:", e);
  }
}

void debugStory();
