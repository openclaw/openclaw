import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const schemaPath = path.join(repoRoot, "dist", "protocol.schema.json");
const outPath = path.join(repoRoot, "dist", "protocol.proto");

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
};

type Root = {
  definitions: Record<string, JsonSchema>;
};

const lines: string[] = [];
const emittedMessages = new Set<string>();
const pendingMessages = new Map<string, JsonSchema>();

function toProtoIdent(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^[^a-zA-Z_]/, "_")
    .replace(/_{2,}/g, "_");
}

function toMessageName(name: string): string {
  const cleaned = toProtoIdent(name);
  return cleaned
    .split("_")
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

function refName(ref: string): string {
  const last = ref.split("/").at(-1) ?? ref;
  return toMessageName(last);
}

function ensureInlineMessage(name: string, schema: JsonSchema): string {
  const msg = toMessageName(name);
  if (!emittedMessages.has(msg) && !pendingMessages.has(msg)) {
    pendingMessages.set(msg, schema);
  }
  return msg;
}

function unwrapNullable(schema: JsonSchema): JsonSchema {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!variants) {
    return schema;
  }
  const nonNull = variants.filter((v) => !(v.type === "null"));
  if (nonNull.length === 1) {
    return nonNull[0];
  }
  return schema;
}

function fieldType(
  schema: JsonSchema,
  parentMessage: string,
  fieldName: string,
): { type: string; repeated?: boolean } {
  const s = unwrapNullable(schema);

  if (s.$ref) {
    return { type: refName(s.$ref) };
  }

  if (s.allOf?.length) {
    return fieldType(s.allOf[0], parentMessage, fieldName);
  }

  if (s.type === "array" && s.items) {
    const item = fieldType(s.items, parentMessage, `${fieldName}_item`);
    return { type: item.type, repeated: true };
  }

  if (s.enum) {
    // Keep wire compatibility simple: represent enums as string now.
    return { type: "string" };
  }

  if (s.type === "object" || s.properties || s.additionalProperties) {
    if (s.properties && Object.keys(s.properties).length > 0) {
      const inline = ensureInlineMessage(`${parentMessage}_${fieldName}`, s);
      return { type: inline };
    }
    if (typeof s.additionalProperties === "object") {
      const value = fieldType(s.additionalProperties, parentMessage, `${fieldName}_value`);
      return { type: `map<string, ${value.type}>` };
    }
    return { type: "google.protobuf.Struct" };
  }

  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (t) {
    case "string":
      return { type: "string" };
    case "integer":
      return { type: "int64" };
    case "number":
      return { type: "double" };
    case "boolean":
      return { type: "bool" };
    default:
      return { type: "google.protobuf.Value" };
  }
}

function emitMessage(name: string, schema: JsonSchema): void {
  const messageName = toMessageName(name);
  if (emittedMessages.has(messageName)) {
    return;
  }
  emittedMessages.add(messageName);

  const props = schema.properties ?? {};
  const entries = Object.entries(props);

  lines.push(`message ${messageName} {`);
  if (schema.description) {
    lines.push(`  // ${schema.description.replace(/\n/g, " ")}`);
  }

  if (entries.length === 0) {
    // Preserve unknown payloads safely.
    lines.push("  google.protobuf.Struct value = 1;");
    lines.push("}");
    lines.push("");
    return;
  }

  let tag = 1;
  for (const [rawField, propSchema] of entries) {
    const fName = toProtoIdent(rawField).toLowerCase();
    const t = fieldType(propSchema, messageName, rawField);
    const prefix = t.repeated ? "repeated " : "";
    lines.push(`  ${prefix}${t.type} ${fName} = ${tag};`);
    tag += 1;
  }

  lines.push("}");
  lines.push("");
}

async function main() {
  const raw = await fs.readFile(schemaPath, "utf8");
  const root = JSON.parse(raw) as Root;

  lines.push('syntax = "proto3";');
  lines.push("");
  lines.push("package openclaw.gateway.v1;");
  lines.push("");
  lines.push('import "google/protobuf/struct.proto";');
  lines.push("");
  lines.push("// Generated from dist/protocol.schema.json");
  lines.push("// Compatibility mirror of current JSON/WebSocket protocol.");
  lines.push("// Migration path: keep wire JSON stable while introducing typed connectors.");
  lines.push("");

  // Seed pending with top-level definitions
  for (const [name, schema] of Object.entries(root.definitions)) {
    pendingMessages.set(toMessageName(name), schema);
  }

  // Drain pending queue (supports inline-generated messages)
  while (pendingMessages.size > 0) {
    const [msgName, schema] = pendingMessages.entries().next().value as [string, JsonSchema];
    pendingMessages.delete(msgName);
    emitMessage(msgName, schema);
  }

  await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
