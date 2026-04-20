import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CACHE_DIR = join(homedir(), ".openclaw", "cache", "ghl");

interface GhlOpportunity {
  contactId?: string;
  createdAt: string;
}
interface GhlCalendarEvent {
  appointmentStatus?: string;
  startTime: string;
  contactId?: string;
}

const events = JSON.parse(
  readFileSync(join(CACHE_DIR, "calendar-events.json"), "utf-8"),
) as GhlCalendarEvent[];
const contacts = JSON.parse(readFileSync(join(CACHE_DIR, "contacts.json"), "utf-8"));
const opportunities = JSON.parse(
  readFileSync(join(CACHE_DIR, "opportunities.json"), "utf-8"),
) as GhlOpportunity[];
const users = JSON.parse(readFileSync(join(CACHE_DIR, "users.json"), "utf-8"));

const contactMap = new Map();
for (const c of contacts) {
  contactMap.set(c.id, c);
}

const userMap = new Map();
for (const u of users) {
  userMap.set(u.id, u.name);
}

const contactOppMap = new Map();
// Sort opportunities by creation date, newest first
opportunities.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
for (const opp of opportunities) {
  // Only store the most recent opportunity for each contact
  if (opp.contactId && !contactOppMap.has(opp.contactId)) {
    contactOppMap.set(opp.contactId, opp);
  }
}

const denverFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Denver",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const todayStr = denverFormatter.format(new Date());

const unconfirmed = events.filter((e) => {
  if (e.appointmentStatus !== "new") {
    return false;
  }
  const evtDateStr = denverFormatter.format(new Date(e.startTime));
  return evtDateStr === todayStr;
});

unconfirmed.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

let message =
  "📅 *GHL Unconfirmed Appointments* 📅\n<@U0AAVS535AB> and <@U07KRVD2867>, here are the unconfirmed appointments for today. Please double text or call them!\n\n";

if (unconfirmed.length === 0) {
  message += "_No unconfirmed appointments for today._\n";
}

for (const e of unconfirmed) {
  const contact = contactMap.get(e.contactId);
  const name = contact ? `${contact.firstName || ""} ${contact.lastName || ""}`.trim() : "Unknown";
  const phone = contact?.phone || "No phone";
  const time = new Date(e.startTime).toLocaleString("en-US", {
    timeZone: "America/Denver",
    hour: "numeric",
    minute: "2-digit",
  });

  // Start with a default setter name
  let setterName = "NA";

  const customSetterField = contact?.customFields?.find(
    (field) => field.id === "7KhSn4AzGFYKIJ4vygll",
  );
  if (customSetterField && customSetterField.value) {
    setterName = customSetterField.value;
  }

  message += `- *${name}* (${phone}) - ${time} - _Setter: ${setterName}_\n`;
}

console.log(message);
