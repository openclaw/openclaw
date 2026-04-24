#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

const { fetchMemorySearch } = await jiti.import("../src/gateway/memory-search-helper.ts");

const parseArgs = (argv) => {
  const options = {};

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--query") {
      options.query = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--agent-id") {
      options.agentId = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--url") {
      options.url = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--timeout-ms") {
      const rawTimeout = Number(argv[index + 1]);
      if (!Number.isFinite(rawTimeout) || rawTimeout < 1) {
        throw new Error("Invalid --timeout-ms value.");
      }
      options.timeoutMs = rawTimeout;
      index += 1;
      continue;
    }

    if (value === "--max-results") {
      const rawMaxResults = Number(argv[index + 1]);
      if (!Number.isFinite(rawMaxResults) || rawMaxResults < 1) {
        throw new Error("Invalid --max-results value.");
      }
      options.maxResults = Math.floor(rawMaxResults);
      index += 1;
      continue;
    }

    if (value === "--min-score") {
      const rawMinScore = Number(argv[index + 1]);
      if (!Number.isFinite(rawMinScore)) {
        throw new Error("Invalid --min-score value.");
      }
      options.minScore = rawMinScore;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  if (typeof options.query !== "string" || !options.query.trim()) {
    throw new Error("--query is required.");
  }

  return options;
};

const getErrorCode = (error) => {
  if (error && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && code.trim()) {
      return code;
    }
  }
  return "memory_search_failed";
};

const toStructuredError = (error, options) => {
  const message = error instanceof Error ? error.message : String(error);

  return {
    ok: false,
    code: getErrorCode(error),
    message,
    details: {
      gatewayUrl: options.url ?? null,
      agentId: options.agentId ?? null,
      query: options.query ?? null,
      maxResults: options.maxResults ?? null,
      minScore: options.minScore ?? null,
    },
  };
};

const main = async () => {
  const options = parseArgs(process.argv);

  try {
    const result = await fetchMemorySearch(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(toStructuredError(error, options), null, 2)}\n`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(toStructuredError(error, {}), null, 2)}\n`);
  process.exitCode = 1;
});
