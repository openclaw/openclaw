// Android Version script supports OpenClaw repository automation.
import path from "node:path";
import { resolveAndroidVersion } from "./lib/android-version.ts";

type CliOptions = {
  field: string | null;
  format: "json" | "shell";
  help: boolean;
  rootDir: string;
};

function parseArgs(argv: string[]): CliOptions {
  let field: string | null = null;
  let format: "json" | "shell" = "json";
  let help = false;
  let rootDir = path.resolve(".");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--field": {
        field = readOptionValue(argv, index, "--field");
        index += 1;
        break;
      }
      case "--json": {
        format = "json";
        break;
      }
      case "--shell": {
        format = "shell";
        break;
      }
      case "--root": {
        const value = readOptionValue(argv, index, "--root");
        rootDir = path.resolve(value);
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

  return { field, format, help, rootDir };
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
    "Usage: node --import tsx scripts/android-version.ts [--json|--shell] [--field name] [--root dir]\n\n",
  );
}

function main(argv = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const version = resolveAndroidVersion(options.rootDir);

  if (options.field) {
    const value = version[options.field as keyof typeof version];
    if (value === undefined) {
      throw new Error(`Unknown Android version field '${options.field}'.`);
    }
    process.stdout.write(`${value}\n`);
    return 0;
  }

  if (options.format === "shell") {
    process.stdout.write(
      [
        `OPENCLAW_ANDROID_VERSION_NAME=${version.canonicalVersion}`,
        `OPENCLAW_ANDROID_VERSION_CODE=${version.versionCode}`,
      ].join("\n") + "\n",
    );
  } else {
    process.stdout.write(`${JSON.stringify(version, null, 2)}\n`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
