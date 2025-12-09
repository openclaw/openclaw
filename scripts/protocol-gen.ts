import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolSchemas } from "../src/gateway/protocol/schema.js";
import {
  InputData,
  JSONSchemaInput,
  JSONSchemaStore,
  quicktype,
} from "quicktype-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function writeJsonSchema() {
  const definitions: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(ProtocolSchemas)) {
    definitions[name] = schema;
  }

  const rootSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://clawdis.dev/protocol.schema.json",
    title: "Clawdis Gateway Protocol",
    description: "Handshake, request/response, and event frames for the Gateway WebSocket.",
    oneOf: [
      { $ref: "#/definitions/Hello" },
      { $ref: "#/definitions/HelloOk" },
      { $ref: "#/definitions/HelloError" },
      { $ref: "#/definitions/RequestFrame" },
      { $ref: "#/definitions/ResponseFrame" },
      { $ref: "#/definitions/EventFrame" },
    ],
    definitions,
  };

  const distDir = path.join(repoRoot, "dist");
  await fs.mkdir(distDir, { recursive: true });
  const jsonSchemaPath = path.join(distDir, "protocol.schema.json");
  await fs.writeFile(jsonSchemaPath, JSON.stringify(rootSchema, null, 2));
  console.log(`wrote ${jsonSchemaPath}`);
  return { jsonSchemaPath, schemaString: JSON.stringify(rootSchema) };
}

async function writeSwiftModels(schemaString: string) {
  const schemaInput = new JSONSchemaInput(new JSONSchemaStore());
  await schemaInput.addSource({ name: "ClawdisGateway", schema: schemaString });

  const inputData = new InputData();
  inputData.addInput(schemaInput);

  const qtResult = await quicktype({
    inputData,
    lang: "swift",
    topLevel: "GatewayFrame",
    rendererOptions: {
      "struct-or-class": "struct",
      "immutable-types": "true",
      "accessLevel": "public",
    },
  });

  const swiftDir = path.join(
    repoRoot,
    "apps",
    "macos",
    "Sources",
    "ClawdisProtocol",
  );
  await fs.mkdir(swiftDir, { recursive: true });
  const swiftPath = path.join(swiftDir, "Protocol.swift");
  await fs.writeFile(swiftPath, qtResult.lines.join("\n"));
  console.log(`wrote ${swiftPath}`);
}

async function main() {
  const { schemaString } = await writeJsonSchema();
  await writeSwiftModels(schemaString);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
