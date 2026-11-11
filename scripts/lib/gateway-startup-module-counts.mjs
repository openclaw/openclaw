import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

/**
 * Counts loaded modules, not every filesystem read or native asset.
 * @param {string} text
 * @returns {{ files: number, groups: Record<string, number> }}
 */
export function summarizeGatewayModuleLoads(text) {
  const modules = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    const { url } = JSON.parse(line);
    const pathname = new URL(url).pathname;
    const dependency = pathname.split("/node_modules/").at(-1);
    const group =
      dependency !== pathname
        ? dependency.startsWith("@")
          ? dependency.split("/").slice(0, 2).join("/")
          : dependency.split("/")[0]
        : pathname.includes("/dist/extensions/")
          ? `extensions/${pathname.split("/dist/extensions/")[1].split("/")[0]}`
          : "core";
    modules.set(pathname, group);
  }
  /** @type {Record<string, number>} */
  const groups = {};
  for (const group of modules.values()) {
    groups[group] = (groups[group] ?? 0) + 1;
  }
  return { files: modules.size, groups };
}

const output = process.env.OPENCLAW_BENCH_MODULE_COUNTS;
if (output) {
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url.startsWith("file:")) {
        appendFileSync(output, `${JSON.stringify({ url })}\n`);
      }
      return result;
    },
  });
}
