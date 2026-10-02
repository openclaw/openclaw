import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  listMatrixCryptoUnsafeState,
  recoverMatrixCryptoUnsafeState,
} from "./matrix/crypto-unsafe-state-doctor.js";
import { getMatrixRuntime } from "./runtime.js";
import { sanitizeMatrixPathSegment } from "./storage-paths.js";

export function registerMatrixDoctorCommands(root: Command): void {
  const doctor = root
    .command("doctor")
    .description("Inspect and recover Matrix crypto storage refusal");
  doctor
    .command("inspect")
    .description("List accounts blocked by an unsafe crypto final save (read-only)")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const stateDir = getMatrixRuntime().state.resolveStateDir(process.env, os.homedir);
      const roots = await listMatrixCryptoUnsafeState(stateDir);
      const accounts = roots.map((rootDir) => ({
        account: path.basename(path.dirname(path.dirname(rootDir))),
        rootDir,
      }));
      if (options.json) {
        console.log(JSON.stringify({ blocked: accounts }, null, 2));
      } else {
        console.log(
          accounts.length
            ? `Matrix crypto refusal: ${accounts.length} account store(s) blocked`
            : "No Matrix crypto refusal markers found.",
        );
        for (const account of accounts) {
          console.log(`- ${account.account}: ${account.rootDir}`);
        }
      }
    });
  doctor
    .command("recover")
    .description("Accept rollback to a validated SQLite snapshot and clear one account's refusal")
    .requiredOption("--account <id>", "Blocked account ID")
    .requiredOption(
      "--accept-snapshot-rollback",
      "Acknowledge that keys from the failed owner may be lost",
    )
    .action(async (options: { account: string; acceptSnapshotRollback?: boolean }) => {
      const stateDir = getMatrixRuntime().state.resolveStateDir(process.env, os.homedir);
      const account = sanitizeMatrixPathSegment(normalizeAccountId(options.account));
      const roots = (await listMatrixCryptoUnsafeState(stateDir)).filter(
        (rootDir) => path.basename(path.dirname(path.dirname(rootDir))) === account,
      );
      if (roots.length !== 1) {
        throw new Error(
          `Expected exactly one blocked Matrix crypto store for account ${account}; found ${roots.length}. Refusing ambiguous recovery.`,
        );
      }
      await recoverMatrixCryptoUnsafeState({
        storageRootDir: roots[0]!,
        acceptSnapshotRollback: options.acceptSnapshotRollback === true,
      });
      console.log(`Matrix crypto refusal cleared for account ${account}; restart the Gateway.`);
    });
}
