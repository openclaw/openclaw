// Qa Lab Up script supports OpenClaw repository automation.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";

const options = {
  help: { type: "boolean", short: "h" },
  "output-dir": { type: "string" },
  "gateway-port": { type: "string" },
  "qa-lab-port": { type: "string" },
  "provider-base-url": { type: "string" },
  image: { type: "string" },
  "use-prebuilt-image": { type: "boolean" },
  "bind-ui-dist": { type: "boolean" },
  "skip-ui-build": { type: "boolean" },
} as const;

function usage(): string {
  return `Usage: pnpm qa:lab:up [options]

Options:
  --output-dir <path>
  --gateway-port <port>
  --qa-lab-port <port>
  --provider-base-url <url>
  --image <name>
  --use-prebuilt-image
  --bind-ui-dist
  --skip-ui-build
  -h, --help
`;
}

function parseQaLabUpArgs(argv: readonly string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  return parseArgs({
    args: [...args],
    options,
    allowPositionals: false,
  }).values;
}

async function runQaLabUp(): Promise<number> {
  const values = parseQaLabUpArgs(process.argv.slice(2));

  if (values.help) {
    process.stdout.write(usage());
    return 0;
  }

  const parsePort = (value: string | undefined, flag: string) => {
    if (value === undefined) {
      return undefined;
    }
    const parsed = parseStrictPositiveInteger(value);
    if (parsed === undefined) {
      throw new Error(`${flag} must be a positive integer.`);
    }
    if (parsed > 65535) {
      throw new Error(`${flag} must be a TCP port from 1 to 65535.`);
    }
    return parsed;
  };

  const gatewayPort = parsePort(values["gateway-port"], "--gateway-port");
  const qaLabPort = parsePort(values["qa-lab-port"], "--qa-lab-port");

  const { runQaDockerUpCommand } = await import("../extensions/qa-lab/src/cli.runtime.ts");

  await runQaDockerUpCommand({
    outputDir: values["output-dir"],
    gatewayPort,
    qaLabPort,
    providerBaseUrl: values["provider-base-url"],
    image: values.image,
    usePrebuiltImage: values["use-prebuilt-image"],
    bindUiDist: values["bind-ui-dist"],
    skipUiBuild: values["skip-ui-build"],
  });
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runQaLabUp();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
