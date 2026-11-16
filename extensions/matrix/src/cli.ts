import type { Command } from "commander";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { registerMatrixAccountCommands } from "./cli-account.js";
import { registerMatrixDirectCommands } from "./cli-direct.js";
import { registerMatrixDoctorCommands } from "./cli-doctor.js";
import { registerMatrixEncryptionCommands } from "./cli-encryption.js";
import * as cli from "./cli-shared.js";
import { registerMatrixVerificationCommands } from "./cli-verification.js";
import { listMatrixOwnDevices, pruneMatrixStaleGatewayDevices } from "./matrix/actions/devices.js";
import { applyMatrixProfileUpdate } from "./profile-update.js";

function printMatrixOwnDevices(devices: Awaited<ReturnType<typeof listMatrixOwnDevices>>): void {
  if (devices.length === 0) {
    console.log("Devices: none");
    return;
  }
  for (const device of devices) {
    const labels = [device.current ? "current" : null, device.displayName]
      .filter((label): label is string => Boolean(label))
      .map((label) => cli.formatMatrixCliText(label));
    console.log(
      `- ${cli.formatMatrixCliText(device.deviceId)}${labels.length ? ` (${labels.join(", ")})` : ""}`,
    );
    const lastSeenAt = timestampMsToIsoString(device.lastSeenTs);
    if (lastSeenAt) {
      cli.printTimestamp("  Last seen", lastSeenAt);
    }
    if (device.lastSeenIp) {
      console.log(`  Last IP: ${cli.formatMatrixCliText(device.lastSeenIp)}`);
    }
  }
}

export function registerMatrixCli(params: { program: Command }): void {
  const root = params.program
    .command("matrix")
    .description("Matrix channel utilities")
    .addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/channels/matrix\n");

  registerMatrixAccountCommands(root);
  const profile = root.command("profile").description("Manage Matrix bot profile");

  profile
    .command("set")
    .description("Update Matrix profile display name and/or avatar")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--name <name>", "Profile display name")
    .option("--avatar-url <url>", "Profile avatar URL (mxc:// or http(s) URL)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (
        options: cli.MatrixCliOptions & {
          name?: string;
          avatarUrl?: string;
        },
      ) => {
        await cli.runMatrixCliCommand(options, {
          run: async () =>
            await applyMatrixProfileUpdate({
              account: options.account,
              displayName: options.name,
              avatarUrl: options.avatarUrl,
            }),
          onText: (result) => {
            cli.printAccountLabel(result.accountId);
            console.log(`Config path: ${result.configPath}`);
            console.log(
              `Profile update: name ${result.profile.displayNameUpdated ? "updated" : "unchanged"}, avatar ${result.profile.avatarUpdated ? "updated" : "unchanged"}`,
            );
            if (result.profile.convertedAvatarFromHttp && result.avatarUrl) {
              console.log(
                `Avatar converted and saved as: ${cli.formatMatrixCliText(result.avatarUrl)}`,
              );
            }
          },
          errorPrefix: "Profile update failed",
        });
      },
    );
  registerMatrixDirectCommands(root);
  registerMatrixEncryptionCommands(root);
  registerMatrixVerificationCommands(root);
  const devices = root.command("devices").description("Inspect and clean up Matrix devices");

  devices
    .command("list")
    .description("List server-side Matrix devices for this account")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: cli.MatrixCliOptions) => {
      await cli.runMatrixCliAccountCommand(options, {
        run: async ({ accountId, cfg }) => await listMatrixOwnDevices({ accountId, cfg }),
        onText: printMatrixOwnDevices,
        errorPrefix: "Device listing failed",
      });
    });

  devices
    .command("prune-stale")
    .description("Delete stale OpenClaw-managed devices for this account")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: cli.MatrixCliOptions) => {
      await cli.runMatrixCliAccountCommand(options, {
        run: async ({ accountId, cfg }) => await pruneMatrixStaleGatewayDevices({ accountId, cfg }),
        onText: (result, verbose) => {
          console.log(
            `Deleted stale OpenClaw devices: ${
              result.deletedDeviceIds.length
                ? result.deletedDeviceIds
                    .map((deviceId) => cli.formatMatrixCliText(deviceId))
                    .join(", ")
                : "none"
            }`,
          );
          console.log(`Current device: ${cli.formatMatrixCliText(result.currentDeviceId)}`);
          console.log(`Remaining devices: ${result.remainingDevices.length}`);
          if (verbose) {
            console.log("Devices before cleanup:");
            printMatrixOwnDevices(result.before);
            console.log("Devices after cleanup:");
            printMatrixOwnDevices(result.remainingDevices);
          }
        },
        errorPrefix: "Device cleanup failed",
      });
    });
  registerMatrixDoctorCommands(root);
}
