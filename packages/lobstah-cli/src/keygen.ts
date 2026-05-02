import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { defaultIdentityPath, formatPubkey, loadOrCreateIdentity } from "@lobstah/protocol";

export const keygen = async (args: string[]): Promise<void> => {
  const force = args.includes("--force");
  const path = defaultIdentityPath();

  if (force && existsSync(path)) {
    await unlink(path);
  }

  const { identity, created } = await loadOrCreateIdentity(path);
  const pk = formatPubkey(identity.publicKey);

  process.stdout.write(`${created ? "created" : "loaded"} identity\n`);
  process.stdout.write(`  path:    ${path}\n`);
  process.stdout.write(`  pubkey:  ${pk}\n`);
};
