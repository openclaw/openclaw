// PR 1 — Validate command stub
// TODO: implement schema validation, integrity check, mutable instruction policy

import { resolve } from "node:path";
import { Command } from "commander";

export const validateCommand = new Command("validate")
  .description("Validate manifest schema + integrity + mutable instruction policy")
  .argument("[path]", "Package directory", ".")
  .action(async (packagePath: string) => {
    const resolved = resolve(packagePath);
    console.log(`validate: stub — checking ${resolved}`);
    // PR 1 implementation goes here.
  });
