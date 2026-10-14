import assert from "node:assert/strict";
import { z } from "zod";
import { quote, type Catalog, type Item } from "./postgres-schema-catalog.mts";

export type TriggerDefinition = {
  name: string;
  table: string;
  event: string;
  columns: string[];
  condition: string | null;
  body: string;
  functionName: string;
};

// This is the canonical non-search UPDATE-trigger subset, not arbitrary SQLite SQL.
function parseTrigger(item: Item, data: Catalog): TriggerDefinition {
  const source = item.source.replace(/\s+/g, " ").trim();
  const match =
    /^CREATE TRIGGER (?:IF NOT EXISTS )?(\w+) AFTER (INSERT|UPDATE|DELETE)(?: OF ([\w, ]+))? ON (\w+)(?: WHEN (.*?))? BEGIN (UPDATE .*?;) END;?$/i.exec(
      source,
    );
  if (!match) {
    throw new Error(`Unsupported trigger definition: ${item.name}`);
  }
  const [, name, event, watched, table, when, body] = match;
  const update = /^UPDATE (\w+) SET (\w+) = (\w+ \+ 1|NULL) WHERE (.*);$/i.exec(body!);
  const reference = "(?:NEW|OLD)\\.\\w+";
  const equality = `\\w+ = (?:${reference}|[0-9]+)`;
  const where = new RegExp(
    `^(?:${equality}(?: AND ${equality})*|\\w+ IN \\(OLD\\.\\w+, NEW\\.\\w+\\))$`,
    "i",
  );
  if (
    !update ||
    !where.test(update[4]!) ||
    !data.tables.some((entry) => entry.name === update[1]) ||
    (update[3] !== "NULL" && update[3] !== `${update[2]} + 1`)
  ) {
    throw new Error(`Unsupported trigger update: ${item.name}`);
  }
  if (when && !when.split(/ OR /i).every((term) => /^NEW\.\w+ IS (?:NOT )?OLD\.\w+$/i.test(term))) {
    throw new Error(`Unsupported trigger condition: ${item.name}`);
  }
  const condition =
    when
      ?.replace(/\bIS NOT\b/gi, "IS DISTINCT FROM")
      .replace(/\bIS (?=OLD\.)/gi, "IS NOT DISTINCT FROM ") ?? null;
  return {
    name: name!,
    table: table!,
    event: event!.toUpperCase(),
    columns: watched?.split(/,\s*/) ?? [],
    condition,
    body: body!,
    functionName: `openclaw_${table}_trigger`,
  };
}

export function translatePostgresTriggers(data: Catalog): TriggerDefinition[] {
  const triggers: TriggerDefinition[] = [];
  const families = new Set([
    "session_entry_snapshots",
    "session_conversations",
    "memory_index_sources",
    "memory_index_chunks",
  ]);
  for (const item of data.objects.filter((entry) => entry.kind === "trigger")) {
    if (item.source.includes("_fts")) {
      item.pendingCapability = "search";
      continue;
    }
    if (!families.has(item.table)) {
      throw new Error(`Unsupported non-search trigger family: ${item.table}.${item.name}`);
    }
    const trigger = parseTrigger(item, data);
    triggers.push(trigger);
    item.sql = `CREATE TRIGGER ${quote(trigger.name)} AFTER ${trigger.event}${trigger.columns.length ? ` OF ${trigger.columns.map(quote).join(", ")}` : ""} ON ${quote(trigger.table)} FOR EACH ROW${trigger.condition ? ` WHEN (${trigger.condition})` : ""} EXECUTE FUNCTION ${quote(trigger.functionName)}();`;
    delete item.reason;
    delete item.category;
    delete item.design;
  }
  for (const functionName of new Set(triggers.map((item) => item.functionName))) {
    const family = triggers.filter((item) => item.functionName === functionName);
    const updates = new Set(family.map((item) => item.body));
    const statements =
      updates.size === 1
        ? `  ${family[0]!.body}`
        : `${family.map((item, index) => `  ${index ? "ELSIF" : "IF"} TG_OP = '${item.event}' THEN\n    ${item.body}`).join("\n")}\n  END IF;`;
    const body = `BEGIN\n${statements}\n  RETURN NULL;\nEND;`;
    data.objects.push({
      kind: "triggerFunction",
      table: family[0]!.table,
      name: functionName,
      source: body,
      sql: `CREATE FUNCTION ${quote(functionName)}() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $trigger$\n${body}\n$trigger$;`,
    });
  }
  return triggers;
}

export async function assertPostgresTriggers(
  data: Catalog,
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  const literal = `'${data.schema.replaceAll("'", "''")}'`;
  const result = await query(`SELECT coalesce(json_agg(json_build_object(
    'name', t.tgname, 'table', c.relname, 'event', t.tgtype,
    'columns', ARRAY(SELECT a.attname FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY k(num, position) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.position),
    'definition', pg_get_triggerdef(t.oid, true), 'functionName', p.proname,
    'body', btrim(p.prosrc), 'enabled', t.tgenabled, 'language', l.lanname,
    'functionSchema', pn.nspname, 'config', p.proconfig
  ) ORDER BY t.tgname), '[]'::json) AS triggers FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
  JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=${literal} AND NOT t.tgisinternal`);
  // Ignore PostgreSQL's redundant deparser parentheses/identifier case, never string contents.
  const condition = (value: string | null) =>
    value
      ?.replace(/\b(\w+\.\w+) IS NOT DISTINCT FROM (\w+\.\w+)/gi, "NOT ($1 IS DISTINCT FROM $2)")
      .replace(/[()\s"]/g, "")
      .toLowerCase() ?? null;
  const expected = data.objects
    .filter((item) => item.kind === "trigger" && !item.pendingCapability)
    .map((item) => parseTrigger(item, data))
    .map((item) => ({
      name: item.name,
      table: item.table,
      columns: item.columns,
      functionName: item.functionName,
      event: { INSERT: 5, UPDATE: 17, DELETE: 9 }[item.event],
      condition: condition(item.condition),
      body: data.objects.find(
        (entry) => entry.kind === "triggerFunction" && entry.name === item.functionName,
      )!.source,
      enabled: "O",
      language: "plpgsql",
      functionSchema: data.schema,
      config: [`search_path=${quote(data.schema)}`],
    }));
  const facts = z
    .array(
      z.object({
        name: z.string(),
        table: z.string(),
        event: z.number(),
        columns: z.array(z.string()),
        definition: z.string(),
        functionName: z.string(),
        body: z.string(),
        enabled: z.string(),
        language: z.string(),
        functionSchema: z.string(),
        config: z.array(z.string()).nullable(),
      }),
    )
    .parse(result);
  const actual = facts.map(({ definition, ...item }) =>
    Object.assign(item, {
      body: item.body.trim(),
      condition: condition(/ WHEN \((.*)\) EXECUTE FUNCTION /.exec(definition)?.[1] ?? null),
      config: item.config?.map((entry) =>
        entry.replace(`=${data.schema}`, `=${quote(data.schema)}`),
      ),
    }),
  );
  const sorted = <T extends { name: string }>(items: T[]) =>
    items.toSorted((a, b) => a.name.localeCompare(b.name, "en"));
  assert.deepEqual(
    sorted(actual),
    sorted(expected),
    "PostgreSQL trigger definitions differ from canonical SQLite",
  );
}
