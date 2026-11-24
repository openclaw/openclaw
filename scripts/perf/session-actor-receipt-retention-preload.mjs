/**
 * Retention diagnostics only: pass this file with team-shape-stress.ts
 * --mode retention --gateway-preload <this-file>. Never use it for timing gates.
 * Counts span the private team-shape-stress start/stop IPC events; the telemetry
 * sampler has its own timestamps. No receipt or entry reference is retained.
 */
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const key = "openclaw.benchmark.session-actor-receipt-retention";
  const state = {
    enabled: 0,
    committed: 0,
    committedWithHostPreimage: 0,
    appendShaped: 0,
    appendShapedWithHostPreimage: 0,
    appendInitializationOutcomes: 0,
    successfulRestores: 0,
    successfulNonemptyRestores: 0,
  };
  globalThis[Symbol.for(key)] = state;
  const access = `globalThis[Symbol.for(${JSON.stringify(key)})]`;
  const installed = [];
  const committedAnchor = "result = committed;";
  const restoreAnchor = "receipt.postimage.entry = reference.entry;";
  const restoreOwner = "restoreSessionActorCommittedOutcome";
  const counterName = "__openclawReceiptRetentionCommit";
  const countCommit = `
function ${counterName}(phase, hasPreimage, hasAppend, hasInitialEntry) {
  const counts = ${access};
  if (!counts.enabled) return;
  counts.committed++;
  if (hasPreimage) counts.committedWithHostPreimage++;
  const append = phase === "appendTranscriptEvent" || (phase === "appendToolResult" && hasAppend);
  if (!append) return;
  if (hasInitialEntry) { counts.appendInitializationOutcomes++; return; }
  counts.appendShaped++;
  if (hasPreimage) counts.appendShapedWithHostPreimage++;
}
`;
  const uniqueAnchor = (source, anchor, bundle) => {
    const offset = source.indexOf(anchor);
    if (offset < 0 || source.indexOf(anchor, offset + anchor.length) !== -1) {
      throw new Error(`Receipt retention diagnostic requires one ${anchor} anchor in ${bundle}`);
    }
    return offset;
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!/^file:.*\/session-actor-(?:durable|memory-owner)-[^/]+\.mjs$/.test(url)) {
        return result;
      }
      const bundle = path.basename(fileURLToPath(url));
      if (result.source == null) {
        throw new Error(`Receipt retention diagnostic has no source for ${bundle}`);
      }
      let source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      if (bundle.startsWith("session-actor-durable-")) {
        uniqueAnchor(source, committedAnchor, bundle);
        if (source.includes(counterName)) {
          throw new Error(`Receipt retention diagnostic is already installed in ${bundle}`);
        }
        source =
          countCommit +
          source.replace(
            committedAnchor,
            `${committedAnchor}\n${counterName}(committed.receipt.phase, Boolean(entryReference), Boolean(committed.receipt.transcript.append), Boolean(committed.receipt.transcript.append?.initialEntry));`,
          );
        installed.push({ hook: "committed-outcome", bundle });
      } else if (source.includes(restoreOwner) || source.includes(restoreAnchor)) {
        const declaration = `function ${restoreOwner}(`;
        const ownerOffset = uniqueAnchor(source, declaration, bundle);
        const restoreOffset = uniqueAnchor(source, restoreAnchor, bundle);
        const ownerEnd = source.indexOf("\n}", ownerOffset);
        if (ownerEnd < 0 || restoreOffset < ownerOffset || restoreOffset > ownerEnd) {
          throw new Error(
            `Receipt retention diagnostic restore anchor is outside its owner in ${bundle}`,
          );
        }
        source = source.replace(
          restoreAnchor,
          `${restoreAnchor}\nif (${access}.enabled) { ${access}.successfulRestores++; if (Boolean(receipt.postimage.entry)) ${access}.successfulNonemptyRestores++; }`,
        );
        installed.push({ hook: "frozen-entry-restoration", bundle });
      }
      return { ...result, source };
    },
  });
  let startedAtEpochMs;
  let lifecycle = "idle";
  process.on("message", (message) => {
    if (message?.channel !== "team-shape-stress") {
      return;
    }
    if (message.action === "start") {
      if (lifecycle !== "idle") {
        throw new Error("Receipt retention diagnostic was started more than once");
      }
      for (const name of Object.keys(state)) {
        state[name] = 0;
      }
      startedAtEpochMs = performance.timeOrigin + performance.now();
      state.enabled = 1;
      lifecycle = "running";
    } else if (message.action === "stop") {
      state.enabled = 0;
      if (lifecycle !== "running" || typeof message.output !== "string") {
        throw new Error("Receipt retention diagnostic received an invalid stop");
      }
      lifecycle = "stopped";
      if (
        installed.filter(({ hook }) => hook === "committed-outcome").length !== 1 ||
        installed.filter(({ hook }) => hook === "frozen-entry-restoration").length > 1
      ) {
        throw new Error(
          "Receipt retention diagnostic requires one committed hook and at most one restore hook",
        );
      }
      const endedAtEpochMs = performance.timeOrigin + performance.now();
      writeFileSync(
        path.join(message.output, "receipt-reference-counts.json"),
        JSON.stringify(
          {
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            counts: Object.fromEntries(
              Object.entries(state).filter(([name]) => name !== "enabled"),
            ),
            installedHookCount: installed.length,
            installedHooks: installed,
            scope:
              "Main isolate; private start/stop IPC span, not the exact telemetry timestamps. Append-shaped counts do not prove worker omission or entry identity. Successful restores count only executions after the guarded assignment. All counter state is numeric; no receipt or entry graph is retained.",
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
    }
  });
  process.channel?.unref();
}
