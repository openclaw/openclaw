import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolSchemas } from "../src/gateway/protocol/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function writeJsonSchema() {
  const definitions: Record<string, unknown> = {};
  const entries = Object.entries(ProtocolSchemas).toSorted(([a], [b]) => a.localeCompare(b));
  for (const [name, schema] of entries) {
    definitions[name] = schema;
  }

  const rootSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://openclaw.ai/protocol.schema.json",
    title: "OpenClaw Gateway Protocol",
    description: "Handshake, request/response, and event frames for the Gateway WebSocket.",
    oneOf: [
      { $ref: "#/definitions/RequestFrame" },
      { $ref: "#/definitions/ResponseFrame" },
      { $ref: "#/definitions/EventFrame" },
    ],
    discriminator: {
      propertyName: "type",
      mapping: {
        req: "#/definitions/RequestFrame",
        res: "#/definitions/ResponseFrame",
        event: "#/definitions/EventFrame",
      },
    },
    definitions,
  };

  const distDir = path.join(repoRoot, "dist");
  await fs.mkdir(distDir, { recursive: true });
  const jsonSchemaPath = path.join(distDir, "protocol.schema.json");
  const content = JSON.stringify(rootSchema, null, 2).replace(/\r\n/g, "\n");
  await fs.writeFile(jsonSchemaPath, content, "utf8");
  console.log(`wrote ${jsonSchemaPath}`);
  return { jsonSchemaPath, schemaString: content };
}

async function main() {
  await writeJsonSchema();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
