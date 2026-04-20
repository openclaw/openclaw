import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".openclaw", "cache", "ghl");
const contacts = JSON.parse(readFileSync(join(CACHE_DIR, "contacts.json"), "utf-8"));
const opportunities = JSON.parse(readFileSync(join(CACHE_DIR, "opportunities.json"), "utf-8"));
const users = JSON.parse(readFileSync(join(CACHE_DIR, "users.json"), "utf-8"));

const contact = contacts.find(
  (c) => c.firstName?.toLowerCase() === "chester" && c.lastName?.toLowerCase() === "johnson",
);

if (!contact) {
  console.log('Contact "Chester Johnson" not found.');
  process.exit(1);
}

const contactId = contact.id;
console.log(`Chester Johnson's contactId: ${contactId}`);

const userMap = new Map();
for (const u of users) {
  userMap.set(u.id, u.name);
}

const contactOpps = opportunities.filter((o) => o.contactId === contactId);

if (contactOpps.length === 0) {
  console.log(`No opportunities found for contactId: ${contactId}`);
  process.exit(1);
}

console.log("\\nOpportunities for Chester Johnson:");
for (const opp of contactOpps) {
  const setterId = opp.assignedTo;
  const setterName = setterId ? userMap.get(setterId) : "None";
  console.log(
    `- Opportunity ID: ${opp.id}, Created: ${opp.createdAt}, Setter: ${setterName} (ID: ${setterId})`,
  );
}
