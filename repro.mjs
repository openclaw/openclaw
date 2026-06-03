import fs from "node:fs";
import path from "node:path";

const stateDir = path.join(process.cwd(), "tmp-proof-state");
const discordDir = path.join(stateDir, "discord");
fs.mkdirSync(discordDir, { recursive: true });

const boundAt = Date.now() - 10_000;
const expiresAt = boundAt + 60_000;

fs.writeFileSync(
  path.join(discordDir, "thread-bindings.json"),
  JSON.stringify({
    version: 1,
    bindings: {
      "legacy-thread": {
        accountId: "default",
        channelId: "parent-1",
        threadId: "legacy-thread",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:legacy",
        agentId: "main",
        boundBy: "system",
        boundAt,
        expiresAt,
      },
    },
  }),
);

const { detectDiscordLegacyStateMigrations } =
  await import("./extensions/discord/src/monitor/model-picker-preferences-migrations.ts");

const plans = await detectDiscordLegacyStateMigrations({
  cfg: {},
  env: {},
  oauthDir: path.join(stateDir, "credentials"),
  stateDir,
});

console.log("Plans found:", plans.length);
const plan = plans[0];
console.log("Plan kind:", plan.kind);

const entries = await plan.readEntries();
console.log("\nEntries returned by readEntries():");
console.log(JSON.stringify(entries, null, 2));

const value = entries[0].value;
const ownKeys = Object.keys(value);
const undefinedKeys = ownKeys.filter((k) => value[k] === undefined);
console.log("\nOwn keys:", ownKeys);
console.log("Keys with undefined values:", undefinedKeys);
console.log("\nJSON.stringify of value:", JSON.stringify(value));
console.log(
  "Object.entries with undefined:",
  Object.entries(value)
    .filter(([_, v]) => v === undefined)
    .map(([k]) => k),
);
