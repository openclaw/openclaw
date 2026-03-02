import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveMatrixAuth } from "./matrix/client/config.js";
import { createMatrixClient } from "./matrix/client/create-client.js";
import { resolveMatrixStoragePaths } from "./matrix/client/storage.js";
import { RecoveryKeyHandler } from "./matrix/recovery-key/handler.js";
import { RecoveryKeyStore } from "./matrix/recovery-key/store.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

export function registerMatrixCli(params: {
  program: Command;
  config: OpenClawConfig;
  logger: Logger;
}) {
  const { program, config, logger } = params;
  const root = program
    .command("matrix")
    .description("Matrix channel utilities")
    .addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/channels/matrix\n");

  const verify = root.command("verify").description("Device verification for E2EE");

  verify
    .command("status")
    .description("Check device verification status")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; json?: boolean }) => {
      try {
        const auth = await resolveMatrixAuth({
          cfg: config,
          accountId: options.account,
        });
        const storagePaths = resolveMatrixStoragePaths({
          homeserver: auth.homeserver,
          userId: auth.userId,
          accessToken: auth.accessToken,
          accountId: options.account,
        });
        const store = new RecoveryKeyStore(storagePaths.rootDir);
        await store.initialize();
        const state = store.getState();

        if (options.json) {
          console.log(JSON.stringify(state, null, 2));
        } else if (state.verified) {
          console.log("Verified: yes");
          console.log(`Device: ${state.deviceId ?? "unknown"}`);
          console.log(`Verified at: ${state.verifiedAt ?? "unknown"}`);
          if (state.backupVersion) {
            console.log(`Backup version: ${state.backupVersion}`);
          }
        } else {
          console.log("Verified: no");
          console.log("Run 'openclaw matrix verify recovery-key <key>' to verify this device.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(JSON.stringify({ error: msg }, null, 2));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
    });

  verify
    .command("recovery-key <key>")
    .description("Verify device using a Matrix recovery key")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--json", "Output as JSON")
    .action(async (key: string, options: { account?: string; json?: boolean }) => {
      let client;
      try {
        const auth = await resolveMatrixAuth({
          cfg: config,
          accountId: options.account,
        });
        if (!auth.encryption) {
          throw new Error(
            "E2EE is not enabled. Set channels.matrix.encryption: true in your config.",
          );
        }

        const storagePaths = resolveMatrixStoragePaths({
          homeserver: auth.homeserver,
          userId: auth.userId,
          accessToken: auth.accessToken,
          accountId: options.account,
        });

        // Create a temporary client for the verification (no sync needed)
        client = await createMatrixClient({
          homeserver: auth.homeserver,
          userId: auth.userId,
          accessToken: auth.accessToken,
          encryption: true,
          accountId: options.account,
        });

        // Prepare crypto if available
        if (client.crypto) {
          const joinedRooms = await client.getJoinedRooms();
          await (client.crypto as { prepare: (rooms?: string[]) => Promise<void> }).prepare(
            joinedRooms,
          );
        }

        const store = new RecoveryKeyStore(storagePaths.rootDir);
        await store.initialize();

        const handler = new RecoveryKeyHandler(client, store, logger);
        const result = await handler.verifyWithRecoveryKey(key);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log("Device verification completed successfully.");
          console.log(`Device: ${result.deviceId ?? "unknown"}`);
          if (result.backupVersion) {
            console.log(`Backup version: ${result.backupVersion}`);
            console.log(`Keys restored: ${result.backupKeysRestored ?? 0}`);
          }
        } else {
          console.error(`Verification failed: ${result.error}`);
          process.exitCode = 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: msg }, null, 2));
        } else {
          console.error(`Verification failed: ${msg}`);
        }
        process.exitCode = 1;
      } finally {
        // Don't call client.stop() — the Rust crypto SDK's tokio runtime panics
        // during teardown via napi. The CLI process exits immediately after this
        // so OS-level cleanup is sufficient.
      }
    });
}
