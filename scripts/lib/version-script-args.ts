import path from "node:path";

export type VersionScriptFormat = "json" | "shell";
export type VersionQueryCliOptions = {
  field: string | null;
  format: VersionScriptFormat;
  help: boolean;
  rootDir: string;
};
export type VersionSyncMode = "check" | "write";
export type VersionSyncCliOptions = {
  help: boolean;
  mode: VersionSyncMode;
  rootDir: string;
};

export function parseVersionQueryArgs(argv: string[]): VersionQueryCliOptions {
  let field: string | null = null;
  let format: VersionScriptFormat = "json";
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

export function parseVersionSyncArgs(argv: string[]): VersionSyncCliOptions {
  let help = false;
  let mode: VersionSyncMode = "write";
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
