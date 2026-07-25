/**
 * QA scenario execution roots for `config/knip.config.ts`.
 *
 * Scenarios declare their runnable script in YAML rather than importing it, so
 * Knip cannot reach these files statically. Reading the manifests keeps the entry
 * list generated from the same source the QA runner uses instead of a hand-copied
 * list that silently rots when a scenario moves.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export function listQaScenarioExecutionEntries(dir = "qa/scenarios"): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listQaScenarioExecutionEntries(entryPath);
    }
    if (!entry.isFile() || (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))) {
      return [];
    }
    const document = YAML.parse(fs.readFileSync(entryPath, "utf8")) as {
      scenario?: { execution?: { kind?: unknown; path?: unknown } };
    };
    const execution = document.scenario?.execution;
    return execution?.kind !== "flow" && typeof execution?.path === "string"
      ? [execution.path]
      : [];
  });
  return [...new Set(entries)].toSorted((left, right) => left.localeCompare(right));
}
