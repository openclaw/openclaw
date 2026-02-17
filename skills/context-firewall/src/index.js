const fs = require("fs");
const path = require("path");
const { program } = require("commander");

const MEMORY_FILE = path.join(__dirname, "..", "firewall_db.json");

// Initialize DB if not exists
if (!fs.existsSync(MEMORY_FILE)) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify({ memories: [] }, null, 2));
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch (e) {
    return { memories: [] };
  }
}

function saveDb(db) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(db, null, 2));
}

program
  .command("store")
  .description("Store a scoped memory")
  .requiredOption("--text <text>", "Text to store")
  .requiredOption("--scope <scope>", "Scope: private, group, public")
  .option("--owner <ownerId>", "Owner User ID")
  .option("--group <groupId>", "Group ID")
  .action((options) => {
    const db = loadDb();
    const memory = {
      id: Math.random().toString(36).substring(7),
      text: options.text,
      scope: options.scope,
      ownerId: options.owner,
      groupId: options.group,
      timestamp: Date.now(),
      tags: [],
    };
    db.memories.push(memory);
    saveDb(db);
    console.log(
      JSON.stringify({
        status: "success",
        id: memory.id,
        message: "Memory stored securely.",
      }),
    );
  });

program
  .command("retrieve")
  .description("Retrieve memories accessible to the current context")
  .requiredOption("--query <query>", "Search query")
  .requiredOption("--user <userId>", "Current User ID")
  .option("--group <groupId>", "Current Group ID")
  .action((options) => {
    const db = loadDb();
    const query = options.query.toLowerCase();

    const accessibleMemories = db.memories.filter((m) => {
      // 1. Text match (simple keyword for now)
      if (!m.text.toLowerCase().includes(query)) return false;

      // 2. Permission Check
      // Public: everyone sees
      if (m.scope === "public") return true;

      // Private: only owner sees
      if (m.scope === "private") {
        return m.ownerId === options.user;
      }

      // Group: only group members (or specifically this group context) see
      if (m.scope === "group") {
        return m.groupId === options.group;
      }

      return false;
    });

    console.log(JSON.stringify(accessibleMemories, null, 2));
  });

program.parse(process.argv);
