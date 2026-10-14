// Private desktop entrypoint; setup policy stays with the browser plugin owner.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readBrowserHostConfig } from "./src/browser/extension-host-config.js";
import {
  NativeHostSetupContextError,
  normalizeExtensionInstallWaitMs,
} from "./src/browser/extension-install.js";
import { runBrowserExtensionSetup } from "./src/browser/extension-setup.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      action: { type: "string" },
      "wait-ms": { type: "string", default: "1000" },
    },
    allowPositionals: false,
    strict: true,
  });
  const action = values.action;
  if (action !== "inspect" && action !== "install" && action !== "verify") {
    throw new Error("An explicit Chrome setup action is required");
  }
  const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await runBrowserExtensionSetup({
      action,
      bundledDir: path.join(pluginRoot, "chrome-extension"),
      pluginRoot,
      cfg: await readBrowserHostConfig(),
      waitMs: normalizeExtensionInstallWaitMs(values["wait-ms"]),
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof NativeHostSetupContextError
      ? `${error.message}\n`
      : "Chrome setup could not finish. Check the local browser runtime.\n",
  );
  process.exitCode = 1;
});
