#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

const { runDesktopEventsHelper } = await jiti.import("../src/gateway/desktop-events-helper.ts");

const parseArgs = (argv) => {
  const options = {};

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--url") {
      options.url = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--token") {
      options.token = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--password") {
      options.password = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--json-stream") {
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return options;
};

const toStructuredError = (error) => ({
  type: "bridge.error",
  code: "desktop_events_failed",
  message: error instanceof Error ? error.message : String(error),
});

const main = async () => {
  const options = parseArgs(process.argv);
  await runDesktopEventsHelper({
    ...options,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
};

main().catch((error) => {
  process.stdout.write(`${JSON.stringify(toStructuredError(error))}\n`);
  process.exitCode = 1;
});

