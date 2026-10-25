import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { resolvePlaywrightChromiumExecutablePath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { toErrorObject } from "./error-format.mts";

export async function launchControlUiObservationBrowser(options: {
  viewport: { width: number; height: number };
  artifactDir: string;
  artifactPrefix: string;
  headless: boolean;
  colorScheme: "light" | "dark";
  isMobile?: boolean;
  hasTouch?: boolean;
}) {
  const server = await chromium.launchServer({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: options.headless,
    host: "127.0.0.1",
  });
  const child = server.process();
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (data: Buffer) => stderr.push(data));
  const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
    } else {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
  });
  const close = async () => {
    let closeError: Error | undefined;
    try {
      // Retire this sample's browser outside the measurement interval.
      await server.close();
    } catch (error) {
      closeError = toErrorObject(error, "Failed to close observation Chromium");
    }
    const exit = await stopped;
    await writeFile(
      path.join(options.artifactDir, `${options.artifactPrefix}.browser-stderr.log`),
      Buffer.concat(stderr),
    );
    await writeFile(
      path.join(options.artifactDir, `${options.artifactPrefix}.browser-process.json`),
      JSON.stringify({ pid: child.pid, ...exit, owner: "control-ui-observation" }, null, 2),
    );
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Owned observation Chromium exited with ${exit.code}/${exit.signal}`, {
        cause: closeError,
      });
    }
    if (closeError !== undefined) {
      throw closeError;
    }
  };
  try {
    const ownedBrowser = await chromium.connect(server.wsEndpoint());
    const context = await ownedBrowser.newContext({
      viewport: options.viewport,
      serviceWorkers: "block",
      colorScheme: options.colorScheme,
      isMobile: options.isMobile,
      hasTouch: options.hasTouch,
    });
    return { context, close, processId: child.pid };
  } catch (error) {
    await close();
    throw error;
  }
}
