// Load TypeScript instrumentation without redirecting built Gateway package imports
// through the controller checkout's tsconfig aliases. This must be the first loader.
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { register } from "tsx/esm/api";

register({ tsconfig: false });

if (isMainThread) {
  const instrumentationSource = new URL("../../src/", import.meta.url).href;
  const packages = new Set(["@openclaw/normalization-core", "@openclaw/worker-runtime"]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const packageName = specifier.split("/").slice(0, 2).join("/");
      if (!context.parentURL?.startsWith(instrumentationSource) || !packages.has(packageName)) {
        return nextResolve(specifier, context);
      }
      // Worker telemetry imports source instrumentation. Its internal workspace
      // dependencies still use the measured build's compiled package exports.
      const buildRoot = path.dirname(path.dirname(path.resolve(process.argv[1])));
      const resolve = createRequire(
        path.join(buildRoot, "packages", packageName.slice("@openclaw/".length), "package.json"),
      );
      return nextResolve(pathToFileURL(resolve.resolve(specifier)).href, context);
    },
  });
}
