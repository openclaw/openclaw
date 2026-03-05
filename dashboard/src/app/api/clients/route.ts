import path from "path";
import { getWorkspacePath, readTextFile, listFiles, apiResponse } from "@/lib/workspace";
import type { Client } from "@/lib/types";

function parseClientMd(content: string, filename: string): Client {
  const id = filename.replace(/\.md$/, "");
  const lines = content.split("\n");
  const client: Client = {
    id,
    name: id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    status: "prospect",
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (line.startsWith("# ")) client.name = line.slice(2).trim();
    if (lower.includes("status:")) {
      const val = line.split(":").slice(1).join(":").trim().toLowerCase();
      if (val.includes("active")) client.status = "active";
      else if (val.includes("proposal")) client.status = "proposal";
      else if (val.includes("meeting")) client.status = "meeting";
      else if (val.includes("contacted")) client.status = "contacted";
    }
    if (lower.includes("contact:") || lower.includes("contacts:")) {
      client.contacts = [line.split(":").slice(1).join(":").trim()];
    }
    if (lower.includes("next action:") || lower.includes("next:")) {
      client.nextAction = line.split(":").slice(1).join(":").trim();
    }
    if (lower.includes("note")) {
      client.notes = line.split(":").slice(1).join(":").trim();
    }
  }

  return client;
}

export async function GET() {
  const wsPath = getWorkspacePath();
  const clientDir = path.join(wsPath, "clients");
  const files = await listFiles(clientDir, ".md");

  const clients: Client[] = [];
  for (const file of files) {
    const content = await readTextFile(path.join(clientDir, file));
    if (content) {
      clients.push(parseClientMd(content, file));
    }
  }

  return apiResponse(clients);
}
