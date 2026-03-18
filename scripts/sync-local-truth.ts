import { syncCommand } from "../src/commands/sync.js";

type ParsedArgs = {
  targetHome: string;
  repoSource?: string;
  repoDest?: string;
  apply: boolean;
  settingsOnly: boolean;
  json: boolean;
  help: boolean;
};

function printHelp(): void {
  console.log(`Usage: bun scripts/sync-local-truth.ts --target-home <path> [options]

Options:
  --repo-source <path>   Repo source directory (default: current working directory)
  --repo-dest <path>     Relative repo destination under the target home
  --apply                Write add/update operations and managed setting additions
  --settings-only        Only add managed settings for ~/agents + Deb envs
  --json                 Output JSON
  -h, --help             Show this help
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    targetHome: "",
    apply: false,
    settingsOnly: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--target-home":
        parsed.targetHome = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--repo-source":
        parsed.repoSource = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--repo-dest":
        parsed.repoDest = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--apply":
        parsed.apply = true;
        break;
      case "--settings-only":
        parsed.settingsOnly = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  if (!parsed.targetHome.trim()) {
    throw new Error("--target-home is required");
  }

  await syncCommand(
    {
      log: (...args) => console.log(...args),
      error: (...args) => console.error(...args),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
    {
      targetHome: parsed.targetHome,
      repoSource: parsed.repoSource,
      repoDest: parsed.repoDest,
      apply: parsed.apply,
      settingsOnly: parsed.settingsOnly,
      json: parsed.json,
    },
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
