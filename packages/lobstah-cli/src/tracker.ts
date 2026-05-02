import { startTracker } from "@lobstah/tracker";

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export const tracker = async (args: string[]): Promise<void> => {
  const sub = args[0];
  if (sub !== "start") {
    process.stderr.write(`unknown tracker subcommand: ${sub ?? "(none)"}\n`);
    process.exit(2);
  }
  const rest = args.slice(1);
  const portArg = flag(rest, "--port");
  const hostArg = flag(rest, "--host");

  const t = await startTracker({
    port: portArg ? Number(portArg) : undefined,
    host: hostArg,
  });

  process.stdout.write(`lobstah-tracker listening on :${t.port}\n`);
  process.stdout.write(`  registry: in-memory, TTL-bounded\n`);
  process.stdout.write(`  endpoints: GET /peers   POST /announce   POST /unannounce\n`);

  const shutdown = async (sig: string): Promise<void> => {
    process.stdout.write(`\nreceived ${sig}, shutting down...\n`);
    await t.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};
