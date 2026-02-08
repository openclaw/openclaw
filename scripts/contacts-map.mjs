#!/usr/bin/env node

import { readJsonWithFallbackSync, withFileLockSync, writeJsonAtomicSync } from "./lib/json-state-lock.mjs";
import path from "node:path";

const contactsPath =
  process.env.OPENCLAW_CONTACTS_MAP ||
  path.join(process.cwd(), "memory", "contacts.json");

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return { version: 2, updatedAt: nowIso(), contacts: {}, aliases: {} };
}

function normalizeState(parsed) {
  const state = defaultState();
  if (!parsed || typeof parsed !== "object") return state;

  if (typeof parsed.version === "number") state.version = parsed.version;

  if (parsed.contacts && typeof parsed.contacts === "object") {
    for (const [name, target] of Object.entries(parsed.contacts)) {
      const normalizedName = normalizeDisplay(name);
      if (!normalizedName) continue;

      if (typeof target === "string") {
        const cleanTarget = target.trim();
        if (cleanTarget) state.contacts[normalizedName] = cleanTarget;
        continue;
      }

      if (target && typeof target === "object" && typeof target.target === "string") {
        const cleanTarget = target.target.trim();
        if (cleanTarget) state.contacts[normalizedName] = cleanTarget;
      }
    }
  }

  if (parsed.aliases && typeof parsed.aliases === "object") {
    for (const [alias, mappedName] of Object.entries(parsed.aliases)) {
      const cleanAlias = normalizeDisplay(alias);
      const cleanMappedName = normalizeDisplay(mappedName);
      if (!cleanAlias || !cleanMappedName) continue;
      state.aliases[cleanAlias] = cleanMappedName;
    }
  }

  return state;
}

function readContacts() {
  const raw = readJsonWithFallbackSync(contactsPath, defaultState);
  return normalizeState(raw);
}

function writeContacts(state) {
  state.version = 2;
  state.updatedAt = nowIso();
  writeJsonAtomicSync(contactsPath, state);
}

function parseArgs(tokens) {
  const out = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = tokens[i + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) i += 1;

    if (out[key] === undefined) {
      out[key] = value;
    } else if (Array.isArray(out[key])) {
      out[key].push(value);
    } else {
      out[key] = [out[key], value];
    }
  }
  return out;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeDisplay(value) {
  return String(value || "").trim();
}

function normalizeLookup(value) {
  return normalizeDisplay(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function escapeArg(value) {
  return String(value || "").replace(/"/g, '\\"');
}

function aliasesForName(state, name) {
  return Object.entries(state.aliases)
    .filter(([, mappedName]) => mappedName === name)
    .map(([alias]) => alias)
    .sort((a, b) => a.localeCompare(b));
}

function findByName(state, input) {
  const display = normalizeDisplay(input);
  if (!display) return { status: "not_found" };

  const lowered = display.toLowerCase();
  for (const [name, target] of Object.entries(state.contacts)) {
    if (name.toLowerCase() === lowered) {
      return {
        status: "ok",
        name,
        target,
        matchedBy: "name",
        aliases: aliasesForName(state, name),
      };
    }
  }

  for (const [alias, mappedName] of Object.entries(state.aliases)) {
    if (alias.toLowerCase() === lowered && state.contacts[mappedName]) {
      return {
        status: "ok",
        name: mappedName,
        target: state.contacts[mappedName],
        matchedBy: "alias",
        aliases: aliasesForName(state, mappedName),
      };
    }
  }

  const lookup = normalizeLookup(display);
  if (!lookup) return { status: "not_found" };

  const candidates = new Set();
  for (const [name] of Object.entries(state.contacts)) {
    if (normalizeLookup(name) === lookup) candidates.add(name);
  }
  for (const [alias, mappedName] of Object.entries(state.aliases)) {
    if (normalizeLookup(alias) === lookup && state.contacts[mappedName]) {
      candidates.add(mappedName);
    }
  }

  if (candidates.size === 0) return { status: "not_found" };
  if (candidates.size > 1) {
    return {
      status: "ambiguous",
      name: display,
      candidates: [...candidates].sort((a, b) => a.localeCompare(b)),
    };
  }

  const [resolvedName] = [...candidates];
  return {
    status: "ok",
    name: resolvedName,
    target: state.contacts[resolvedName],
    matchedBy: "normalized",
    aliases: aliasesForName(state, resolvedName),
  };
}

function suggestUpsert(name) {
  return `node scripts/contacts-map.mjs upsert --name "${escapeArg(name)}" --target "<phone-or-chatId>"`;
}

function failNotFound(name, asJson) {
  const message = `contact not found: ${name}`;
  const suggest = suggestUpsert(name);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: "contact_not_found",
          name,
          message,
          suggest,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`CONTACT_NOT_FOUND: ${name}`);
    console.log(`Add it with: ${suggest}`);
  }
  process.exit(1);
}

function failAmbiguous(name, candidates, asJson) {
  const message = `contact lookup is ambiguous: ${name}`;
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: "contact_ambiguous",
          name,
          message,
          candidates,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`CONTACT_AMBIGUOUS: ${name}`);
    console.log(`Candidates: ${candidates.join(", ")}`);
  }
  process.exit(1);
}

function resolveOrFail(state, name, asJson) {
  const found = findByName(state, name);
  if (found.status === "ok") return found;
  if (found.status === "ambiguous") {
    failAmbiguous(name, found.candidates, asJson);
  }
  failNotFound(name, asJson);
}

function listCommand(args) {
  const state = readContacts();
  const items = Object.entries(state.contacts)
    .map(([name, target]) => ({ name, target: String(target), aliases: aliasesForName(state, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          count: items.length,
          items,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (items.length === 0) {
    console.log("NO_CONTACTS");
    return;
  }

  for (const item of items) {
    const aliasSuffix = item.aliases.length > 0 ? ` aliases: ${item.aliases.join(", ")}` : "";
    console.log(`${item.name} -> ${item.target}${aliasSuffix}`);
  }
}

function resolveCommand(args) {
  const name = normalizeDisplay(args.name);
  if (!name) throw new Error("resolve requires --name <name>");
  const asJson = Boolean(args.json);
  const state = readContacts();
  const found = resolveOrFail(state, name, asJson);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          name: found.name,
          target: found.target,
          matchedBy: found.matchedBy,
          aliases: found.aliases,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(found.target);
}

function normalizeAliasInputs(values) {
  return asArray(values)
    .flatMap((value) => String(value).split(","))
    .map((value) => normalizeDisplay(value))
    .filter(Boolean);
}

function upsertCommand(args) {
  const requestedName = normalizeDisplay(args.name);
  const target = normalizeDisplay(args.target);
  const aliasInputs = normalizeAliasInputs(args.alias);

  if (!requestedName) throw new Error("upsert requires --name <name>");
  if (!target) throw new Error("upsert requires --target <phone-or-chatId>");

  let output;
  withFileLockSync(contactsPath, () => {
    const state = readContacts();
    const resolvedName = findByName(state, requestedName);

    let finalName = requestedName;
    if (resolvedName.status === "ok") {
      finalName = resolvedName.name;
    } else if (resolvedName.status === "ambiguous") {
      throw new Error(
        `upsert name is ambiguous: ${requestedName} (${resolvedName.candidates.join(", ")})`,
      );
    }

    const action = state.contacts[finalName] ? "updated" : "added";
    state.contacts[finalName] = target;

    for (const aliasRaw of aliasInputs) {
      if (normalizeLookup(aliasRaw) === normalizeLookup(finalName)) continue;
      const aliasCheck = findByName(state, aliasRaw);
      if (aliasCheck.status === "ok" && aliasCheck.name !== finalName) {
        throw new Error(`alias "${aliasRaw}" already maps to ${aliasCheck.name}`);
      }
      if (aliasCheck.status === "ambiguous") {
        const otherCandidates = aliasCheck.candidates.filter((name) => name !== finalName);
        if (otherCandidates.length > 0) {
          throw new Error(`alias "${aliasRaw}" is ambiguous (${aliasCheck.candidates.join(", ")})`);
        }
      }
      state.aliases[aliasRaw] = finalName;
    }

    writeContacts(state);

    output = {
      ok: true,
      action,
      name: finalName,
      target,
      aliases: aliasesForName(state, finalName),
      count: Object.keys(state.contacts).length,
    };
  });

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const aliasSuffix = output.aliases.length > 0 ? ` aliases: ${output.aliases.join(", ")}` : "";
  console.log(`${output.action.toUpperCase()}: ${output.name} -> ${output.target}${aliasSuffix}`);
}

function textCommand(nameTokens, args) {
  const name = normalizeDisplay(nameTokens.join(" "));
  if (!name) throw new Error("text requires a name, e.g. text Alice");
  const asJson = Boolean(args.json);
  const state = readContacts();
  const found = resolveOrFail(state, name, asJson);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "text",
          name: found.name,
          target: found.target,
          matchedBy: found.matchedBy,
          message: `resolved text ${found.name} -> ${found.target}`,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`RESOLVED_TEXT_TARGET: ${found.name} -> ${found.target}`);
}

function usage() {
  console.error(
    [
      "contacts-map.mjs",
      "  list [--json]",
      "  resolve --name <name> [--json]",
      "  upsert --name <name> --target <phone-or-chatId> [--alias <alias>] [--json]",
      "  text <name> [--json]",
    ].join("\n"),
  );
  process.exit(1);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "text") {
    const nameTokens = [];
    const flagTokens = [];
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token.startsWith("--")) {
        flagTokens.push(token);
        const next = rest[i + 1];
        if (next && !next.startsWith("--")) {
          flagTokens.push(next);
          i += 1;
        }
      } else {
        nameTokens.push(token);
      }
    }
    return textCommand(nameTokens, parseArgs(flagTokens));
  }

  const args = parseArgs(rest);

  if (command === "list") return listCommand(args);
  if (command === "resolve") return resolveCommand(args);
  if (command === "upsert") return upsertCommand(args);

  return usage();
}

try {
  main();
} catch (err) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
