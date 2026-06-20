// Ios Sync Versioning script supports OpenClaw repository automation.
import path from "node:path";
import { syncIosVersioning } from "./lib/ios-version.ts";

type Mode = "check" | "write";

export function parseArgs(argv: string[]): { help: boolean; mode: Mode; rootDir: string } {
  let help = false;
  let mode: Mode = "write";
  let rootDir = path.resolve(".");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--check": {
        mode = "check";
        break;
      }
      case "--write": {
        mode = "write";
        break;
      }
      case "--root": {
        rootDir = path.resolve(readOptionValue(argv, index, "--root"));
        index += 1;
        break;
      }
      case "-h":
      case "--help": {
        help = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return { help, mode, rootDir };
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: node --import tsx scripts/ios-sync-versioning.ts [--write|--check] [--root dir]\n",
  );
}

function main(argv = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const result = syncIosVersioning({ mode: options.mode, rootDir: options.rootDir });

  if (options.mode === "check") {
    process.stdout.write("iOS versioning artifacts are up to date.\n");
  } else if (result.updatedPaths.length === 0) {
    process.stdout.write("iOS versioning artifacts already up to date.\n");
  } else {
    process.stdout.write(
      `Updated iOS versioning artifacts:\n- ${result.updatedPaths.map((filePath) => path.relative(process.cwd(), filePath)).join("\n- ")}\n`,
    );
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
