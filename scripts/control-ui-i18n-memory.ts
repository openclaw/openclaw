import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONTROL_UI_LOCALE_ENTRIES } from "./lib/control-ui-i18n-config.ts";
import {
  bootstrapControlUiMemory,
  exportControlUiMemory,
  pinControlUiMemory,
  restoreControlUiMemory,
  readControlUiMemoryPin,
  CONTROL_UI_MEMORY_ASSETS,
} from "./lib/control-ui-i18n-storage.ts";

function output(key: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, key + "=" + value + "\n");
  }
  console.log(key + "=" + value);
}

function main() {
  const [command, store, repository, revision] = process.argv.slice(2);
  const root = process.cwd();
  const pin = readControlUiMemoryPin(path.join(root, CONTROL_UI_MEMORY_ASSETS));
  if (command === "paths") {
    output("core", CONTROL_UI_MEMORY_ASSETS + (pin ? "/*.catalog.jsonl" : "/*.tm.jsonl"));
    output("pin", pin ? CONTROL_UI_MEMORY_ASSETS + "/memory-revision.json" : "");
    return;
  }
  if (command === "status") {
    output("active", String(Boolean(pin)));
    if (pin) {
      if (pin.repository !== process.env.CONTROL_UI_MEMORY_REPOSITORY) {
        throw new Error(
          "Configure CONTROL_UI_MEMORY_REPOSITORY to the bootstrapped canonical repository",
        );
      }
      const [owner, name] = pin.repository.split("/");
      output("owner", owner!);
      output("repository", name!);
      output("revision", pin.revision);
    }
    return;
  }
  if (!store) {
    throw new Error(
      "Usage: control-ui-i18n-memory.ts export <store> | bootstrap <store> <owner/repo> <commit> | restore <store> <owner/repo> | pin <store> <owner/repo> <commit> | status",
    );
  }
  const locales = CONTROL_UI_LOCALE_ENTRIES.map(({ locale }) => locale);
  if (command === "export") {
    exportControlUiMemory(root, store, locales);
  } else if (command === "bootstrap" && repository && revision) {
    bootstrapControlUiMemory(root, store, repository, revision, locales);
  } else if (command === "restore" && repository) {
    restoreControlUiMemory(root, store, repository);
  } else if (command === "pin" && repository && revision) {
    pinControlUiMemory(root, store, repository, revision);
  } else {
    throw new Error("Invalid memory command or missing repository/revision");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
