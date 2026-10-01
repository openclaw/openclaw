#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeStandaloneInstallers } from "./lib/standalone-installers.mjs";

const root = path.resolve(process.argv[3] ?? fileURLToPath(new URL("..", import.meta.url)));
writeStandaloneInstallers(
  root,
  path.resolve(process.argv[2] ?? path.join(root, "dist/installers")),
);
