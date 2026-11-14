/**
 * Count fallback catalog work through the real createDecisionTool constructor.
 * node --import ./scripts/tsx.mjs scripts/perf/decision-tool-catalog-measure.ts \
 *   --sample 1 [--owner-revision <full-before-commit>]
 * Alternate five before/current processes. Report first-for-selection and warm calls.
 * Only the selected complete owner module changes; its imports remain real.
 * These instrumented counts do not measure allocations, CPU or Gateway latency.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";

const { values } = parseArgs({
  options: { "owner-revision": { type: "string" }, sample: { type: "string", default: "1" } },
});
const sample = Number(values.sample);
assert(Number.isSafeInteger(sample) && sample >= 1 && sample <= 5);
const revision = values["owner-revision"];
assert(revision === undefined || /^[a-f0-9]{40}$/u.test(revision));
const git = (...args: string[]) =>
  execFileSync(process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git", args, {
    encoding: "utf8",
  }).trim();
const head = git("rev-parse", "HEAD");
assert.equal(git("status", "--porcelain", "--untracked-files=normal"), "");
const ownerPath = "src/agents/tools/decision-tool.ts";
const ownerUrl = new URL(`../../${ownerPath}`, import.meta.url);
const source = revision
  ? execFileSync(
      process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git",
      ["show", `${revision}:${ownerPath}`],
      { encoding: "utf8" },
    )
  : readFileSync(ownerUrl, "utf8");
let loaded = false;
const hook = registerHooks({
  load(url, context, next) {
    if (url !== ownerUrl.href) {
      return next(url, context);
    }
    loaded = true;
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const { createDecisionTool }: typeof import("../../src/agents/tools/decision-tool.js") =
  await import(ownerUrl.href);
hook.deregister();
assert(loaded, "selected complete owner source was not loaded");
const { createPluginMetadataSnapshotFixture } =
  await import("../../src/plugins/plugin-metadata.test-support.js");
const { setCurrentPluginMetadataSnapshotState } =
  await import("../../src/plugins/current-plugin-metadata-state.js");
const counts = { sourceRowReads: 0, rowEnumerations: 0, providerEnumerations: 0 };
const decision: ModelDecisionCapabilities = {
  protocol: "fixture",
  input: ["text"],
  limits: { maxQuestions: 3 },
};
const snapshot = createPluginMetadataSnapshotFixture({
  plugins: Array.from({ length: 8 }, (_plugin, plugin) => {
    const providers = new Proxy(
      Object.fromEntries(
        Array.from({ length: 8 }, (_provider, provider) => [
          `provider-${plugin}-${provider}`,
          {
            models: new Proxy(
              Array.from(
                { length: 128 },
                (_model, model) =>
                  new Proxy(
                    {
                      id: `model-${model}`,
                      name: `Model ${model}`,
                      provider: "row-provider-is-not-identity",
                      inference: { chat: false, decision },
                    },
                    {
                      ownKeys(target) {
                        counts.rowEnumerations++;
                        return Reflect.ownKeys(target);
                      },
                    },
                  ),
              ),
              {
                get(target, key, receiver) {
                  if (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)) {
                    counts.sourceRowReads++;
                  }
                  return Reflect.get(target, key, receiver);
                },
              },
            ),
          },
        ]),
      ),
      {
        ownKeys(target) {
          counts.providerEnumerations++;
          return Reflect.ownKeys(target);
        },
      },
    );
    return {
      id: `fixture-${plugin}`,
      contracts: { decisionProviders: Object.keys(providers) },
      modelCatalog: { providers },
    };
  }),
});
setCurrentPluginMetadataSnapshotState(snapshot, undefined, undefined, undefined, "gateway");
const selections = [
  "provider-0-0/model-0@fixture-profile",
  "provider-7-7/model-127",
  "provider-0-0/missing",
  "missing/model-0",
];
const rows = [];
try {
  for (const [index, selection] of selections.entries()) {
    for (const phase of ["first-for-selection", "warm"]) {
      for (let iteration = 0; iteration < (phase === "first-for-selection" ? 1 : 5); iteration++) {
        Object.assign(counts, { sourceRowReads: 0, rowEnumerations: 0, providerEnumerations: 0 });
        const tool = createDecisionTool("main", {
          config: { agents: { defaults: { decisionModel: selection } } },
        });
        assert(tool);
        assert(
          tool.description.includes(
            index < 2 ? "at most 3 questions" : "Provider limits are undeclared",
          ),
        );
        rows.push({
          selection,
          phase,
          iteration,
          ...counts,
          descriptionSha256: createHash("sha256").update(tool.description).digest("hex"),
        });
      }
    }
  }
  console.log(
    JSON.stringify({
      sample,
      head,
      ownerRevision: revision ?? head,
      ownerSha256: createHash("sha256").update(source).digest("hex"),
      workloadSha256: createHash("sha256")
        .update(readFileSync(import.meta.filename))
        .digest("hex"),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      hostLoad: loadavg(),
      plugins: 8,
      providersPerPlugin: 8,
      modelsPerProvider: 128,
      rows,
    }),
  );
} finally {
  setCurrentPluginMetadataSnapshotState(undefined, undefined);
}
