#!/usr/bin/env node
/**
 * ClaWorks Nexus — local pack registry HTTP server (port 8080 by default).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CLAWORKS_NEXUS_PORT || "8080");
const host = process.env.CLAWORKS_NEXUS_HOST || "127.0.0.1";
const catalog =
  process.env.CLAWORKS_NEXUS_CATALOG?.trim() || path.join(root, "..", "claworks-packs");

const { createNexusServer } =
  await import("../packages/claworks-runtime/src/interfaces/nexus/server.ts");

const nexus = await createNexusServer(catalog);
await nexus.listen(port, host);

console.log(`ClaWorks Nexus listening on http://${host}:${port}`);
console.log(`Catalog: ${catalog}`);
console.log(`Packages: ${nexus.entries.map((e) => e.slug).join(", ") || "(none)"}`);
console.log("");
console.log("Examples:");
console.log(`  curl "http://${host}:${port}/api/packages?family=claworks-pack"`);
console.log(
  `  curl "http://${host}:${port}/api/packages/base/versions/1.0.0/artifacts/generic" -o base.tgz`,
);
