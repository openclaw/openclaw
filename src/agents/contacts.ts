/**
 * Contacts utilities for persistent phonebook storage.
 * CONTACTS.md stores contact information across sessions for messaging.
 * The agent uses this file to remember phone numbers without asking repeatedly.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CONTACTS_FILENAME = "CONTACTS.md";

export function getContactsPath(workspaceDir: string): string {
  return path.join(workspaceDir, DEFAULT_CONTACTS_FILENAME);
}

export async function contactsExist(workspaceDir: string): Promise<boolean> {
  try {
    await fs.access(getContactsPath(workspaceDir));
    return true;
  } catch {
    return false;
  }
}

export interface Contact {
  name: string;
  number: string;
  notes?: string;
}

export async function loadContacts(workspaceDir: string): Promise<Contact[]> {
  const contactsPath = getContactsPath(workspaceDir);
  try {
    const content = await fs.readFile(contactsPath, "utf-8");
    return parseContactsMarkdown(content);
  } catch {
    return [];
  }
}

export function parseContactsMarkdown(content: string): Contact[] {
  const contacts: Contact[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed === "---" ||
      /^\|?-+\|/.test(trimmed) ||
      line.toLowerCase().includes("| name")
    ) {
      continue;
    }
    const match = line.match(/^\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]*)\s*\|?\s*$/);
    if (match) {
      const name = match[1]?.trim();
      const number = match[2]?.trim();
      const notes = match[3]?.trim();

      if (name && number && !name.toLowerCase().includes("example") && !number.includes("XXXX")) {
        contacts.push({
          name,
          number,
          notes: notes || undefined,
        });
      }
    }
  }

  return contacts;
}

export function findContactByName(contacts: Contact[], name: string): Contact | undefined {
  const searchTokens = name.toLowerCase().trim().split(/\s+/);
  const exactMatch = contacts.find((c) => c.name.toLowerCase() === name.toLowerCase().trim());
  if (exactMatch) {
    return exactMatch;
  }
  return contacts.find((c) => {
    const contactTokens = c.name.toLowerCase().split(/\s+/);
    return (
      searchTokens.every((t) => contactTokens.some((ct) => ct.includes(t))) ||
      contactTokens.every((ct) => searchTokens.some((t) => t.includes(ct)))
    );
  });
}

export function generateContactsTemplate(): string {
  return `# Contacts

Store contact information here for messaging across sessions.

| Name | Number | Notes |
|------|--------|-------|

## Usage
- Add new contacts by appending rows to the table above
- Format: | Name | +E164Number | Optional notes |
- The agent will check here before asking for numbers
`;
}
