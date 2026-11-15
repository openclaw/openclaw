import { pathToFileURL } from "node:url";

type QaE2eArgs = {
  help: boolean;
  outputPath?: string;
};

function usage(): string {
  return `Usage: pnpm qa:e2e [--output <path>]

Options:
  --output <path>  Markdown report output path
  -h, --help       Display help
`;
}

function parseQaE2eArgs(argv: readonly string[]): QaE2eArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let outputPath = "";
  let positionalMode = false;
  const setOutputPath = (value: string) => {
    if (outputPath) {
      throw new Error("qa:e2e output path was provided more than once");
    }
    outputPath = value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (positionalMode) {
      if (!outputPath && arg.trim()) {
        setOutputPath(arg.trim());
        continue;
      }
      throw new Error(`Unexpected qa:e2e argument: ${arg}`);
    }
    if (arg === "--") {
      positionalMode = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    const inlineOutput = arg.startsWith("--output=") ? arg.slice("--output=".length).trim() : null;
    if (inlineOutput !== null) {
      if (!inlineOutput) {
        throw new Error("--output requires a value");
      }
      setOutputPath(inlineOutput);
      continue;
    }
    if (arg === "--output") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("-")) {
        throw new Error("--output requires a value");
      }
      setOutputPath(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown qa:e2e option: ${arg}`);
    }
    if (outputPath) {
      throw new Error(`Unexpected qa:e2e argument: ${arg}`);
    }
    setOutputPath(arg.trim());
  }
  return outputPath ? { help: false, outputPath } : { help: false };
}

async function main(): Promise<number> {
  const args = parseQaE2eArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  process.env.OPENCLAW_BUILD_PRIVATE_QA = "1";
  process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "0";
  const { isQaSelfCheckSuccessful, runQaE2eSelfCheck } =
    await import("../extensions/qa-lab/api.js");
  const result = args.outputPath
    ? await runQaE2eSelfCheck({ outputPath: args.outputPath })
    : await runQaE2eSelfCheck();
  process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
  return isQaSelfCheckSuccessful(result) ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
