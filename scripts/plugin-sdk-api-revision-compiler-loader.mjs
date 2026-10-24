import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const revisionRoot = process.env.OPENCLAW_PLUGIN_SDK_TYPESCRIPT_ROOT;
if (!revisionRoot) {
  throw new Error("Plugin SDK revision compiler root is missing");
}
const packageRoot = path.join(revisionRoot, "node_modules", "typescript");
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));

function revisionTypeScriptUrl(specifier) {
  const exportName =
    specifier === "typescript" ? "." : `./${specifier.slice("typescript/".length)}`;
  const target = packageJson.exports?.[exportName];
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new Error(`Unsupported revision TypeScript export: ${specifier}`);
  }
  return pathToFileURL(path.join(packageRoot, target)).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parentPath = context.parentURL?.startsWith("file:")
      ? new URL(context.parentURL).pathname
      : "";
    if (
      (specifier === "typescript" || specifier.startsWith("typescript/")) &&
      !parentPath.includes("/node_modules/")
    ) {
      return {
        shortCircuit: true,
        url: revisionTypeScriptUrl(specifier),
      };
    }
    return nextResolve(specifier, context);
  },
});
