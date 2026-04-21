import {
  archiveOutboundPdfToShoarchive,
  registerCreatedPdfInShoarchive,
} from "../src/shoarchive/pdf-shoarchive.js";

type Args = {
  pdf?: string;
  workspaceRoot?: string;
  recipient?: string;
  via?: string;
  deliveredAt?: string;
  timezone?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    switch (current) {
      case "--pdf":
        args.pdf = next;
        i += 1;
        break;
      case "--workspace-root":
        args.workspaceRoot = next;
        i += 1;
        break;
      case "--recipient":
        args.recipient = next;
        i += 1;
        break;
      case "--via":
        args.via = next;
        i += 1;
        break;
      case "--delivered-at":
        args.deliveredAt = next;
        i += 1;
        break;
      case "--timezone":
        args.timezone = next;
        i += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pdf) {
    throw new Error("Missing required --pdf <path>");
  }
  const pdfPath = args.pdf;
  const workspaceRoot = args.workspaceRoot;
  const deliveredAt = args.deliveredAt ? new Date(args.deliveredAt) : undefined;

  const result =
    args.recipient && deliveredAt
      ? await archiveOutboundPdfToShoarchive({
          sourcePath: pdfPath,
          recipient: args.recipient,
          via: args.via ?? "WhatsApp",
          workspaceRoot: workspaceRoot ?? process.env.HOME + "/.openclaw/workspace",
          deliveredAt,
          timezone: args.timezone,
        })
      : await registerCreatedPdfInShoarchive({
          sourcePath: pdfPath,
          workspaceRoot,
          timezone: args.timezone,
        });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
