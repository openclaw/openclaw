#!/usr/bin/env node

import { createExtensionImportBoundaryChecker } from "./lib/extension-import-boundary-checker.mts";
import { runAsScript } from "./lib/ts-guard-utils.mts";

const checker = createExtensionImportBoundaryChecker({
  roots: ["test/helpers"],
  boundaryLabel: "test helper",
  rule: "Rule: test/helpers/** must not import bundled plugin files directly",
  cleanMessage: "No test-helper import boundary violations found.",
  inventoryTitle: "Test-helper extension import boundary inventory:",
});

export const main = checker.main;

runAsScript(import.meta.url, main);
