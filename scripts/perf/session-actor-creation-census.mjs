/**
 * Diagnostic actor-construction counts in an isolated synthetic Gateway:
 * pass --gateway-preload <this-file> --workload-cpu-profile to
 * transcript-broadcast-measure.ts. Run sessions.list and chat.send separately.
 * Each workload CPU window writes a sibling .actors.json with exact counts,
 * session keys, and caller stacks. Never use this traced pass for timing claims.
 */
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";
import { findBundledModuleRegion } from "../lib/bundled-module-regions.mjs";

if (isMainThread) {
  const key = Symbol.for("openclaw.benchmark.actorCreationCensus");
  const owner = "src/config/sessions/session-actor-executor.ts";
  const installed = [];
  let active = false;
  let calls = [];
  globalThis[key] = (target) => {
    if (active) {
      calls.push({
        at: Date.now(),
        sessionKey: target.sessionKey,
        backend: target.database.kind,
        stack: new Error().stack?.split("\n").slice(2).join("\n"),
      });
    }
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (result.source == null || (!url.endsWith(owner) && !url.endsWith(".mjs"))) {
        return result;
      }
      const source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      const bounds = url.endsWith(owner)
        ? { start: 0, end: source.length }
        : findBundledModuleRegion(source, owner);
      if (!bounds) {
        return result;
      }
      const region = source.slice(bounds.start, bounds.end);
      let matches = 0;
      const measured = region.replace(
        /const target\s*=\s*freeze(?:Trusted)?JsonSnapshot\(structuredClone\(params\.target\)\);/g,
        (match) => {
          matches++;
          return `globalThis[Symbol.for("openclaw.benchmark.actorCreationCensus")](params.target);\n${match}`;
        },
      );
      if (matches !== 1) {
        throw new Error(`Actor census expected one executor declaration, found ${matches}: ${url}`);
      }
      installed.push(url);
      return {
        ...result,
        source: source.slice(0, bounds.start) + measured + source.slice(bounds.end),
      };
    },
  });
  process.on("message", (message) => {
    if (message?.channel !== "openclaw-gateway-bench-profile" || message.kind !== "cpu") {
      return;
    }
    if (message.action === "start") {
      calls = [];
      active = true;
    } else if (message.action === "stop") {
      active = false;
      if (installed.length === 0) {
        throw new Error("Actor census did not load the executor owner");
      }
      writeFileSync(
        `${message.profilePath}.actors.json`,
        JSON.stringify({ installed, count: calls.length, calls }, null, 2),
      );
    }
  });
  process.channel?.unref();
}
