import { parseArgs } from "node:util";
import { runQaDockerUpCommand } from "../extensions/qa-lab/src/cli.runtime.ts";

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    "output-dir": { type: "string" },
    "gateway-port": { type: "string" },
    "qa-lab-port": { type: "string" },
    "provider-base-url": { type: "string" },
    image: { type: "string" },
    "use-prebuilt-image": { type: "boolean" },
    "skip-ui-build": { type: "boolean" },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`Usage: pnpm qa:lab:up [options]

Options:
  --output-dir <path>
  --gateway-port <port>
  --qa-lab-port <port>
  --provider-base-url <url>
  --image <name>
  --use-prebuilt-image
  --skip-ui-build
  -h, --help
`);
  process.exit(0);
}

const parsePort = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
};

await runQaDockerUpCommand({
  outputDir: values["output-dir"],
  gatewayPort: parsePort(values["gateway-port"]),
  qaLabPort: parsePort(values["qa-lab-port"]),
  providerBaseUrl: values["provider-base-url"],
  image: values.image,
  usePrebuiltImage: values["use-prebuilt-image"],
  skipUiBuild: values["skip-ui-build"],
});
