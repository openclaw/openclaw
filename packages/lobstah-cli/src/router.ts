import { defaultIdentityPath, formatPubkey, loadOrCreateIdentity } from "@lobstah/protocol";
import { startRouter } from "@lobstah/router";

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export const router = async (args: string[]): Promise<void> => {
  const portArg = flag(args, "--port");
  const hostArg = flag(args, "--host");
  const port = portArg ? Number(portArg) : undefined;

  const { identity } = await loadOrCreateIdentity();
  const pk = formatPubkey(identity.publicKey);

  const r = await startRouter({ identity, port, host: hostArg });

  process.stdout.write(`lobstah-router listening on :${r.port}\n`);
  process.stdout.write(`  identity: ${defaultIdentityPath()}\n`);
  process.stdout.write(`  pubkey:   ${pk}\n`);

  const shutdown = async (sig: string): Promise<void> => {
    process.stdout.write(`\nreceived ${sig}, shutting down...\n`);
    await r.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};
