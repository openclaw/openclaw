import type { Command } from "commander";
import * as cli from "./cli-shared.js";
import { resolveMatrixAccountConfig } from "./matrix/account-config.js";
import type {
  inspectMatrixDirectRooms,
  MatrixDirectRoomCandidate,
  repairMatrixDirectRooms,
} from "./matrix/direct-management.js";
import { getMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type MatrixCliDirectRoomCandidate = Omit<MatrixDirectRoomCandidate, "explicit">;
type MatrixCliDirectRoomInspection = Omit<
  Awaited<ReturnType<typeof inspectMatrixDirectRooms>>,
  "mappedRooms"
> & {
  accountId: string;
  mappedRooms: MatrixCliDirectRoomCandidate[];
};
type MatrixCliDirectRoomRepair = MatrixCliDirectRoomInspection &
  Omit<Awaited<ReturnType<typeof repairMatrixDirectRooms>>, keyof MatrixCliDirectRoomInspection> & {
    encrypted: boolean;
  };

function printDirectRoomCandidate(room: MatrixCliDirectRoomCandidate): void {
  const members =
    room.joinedMembers === null
      ? "unavailable"
      : room.joinedMembers.map((member) => cli.formatMatrixCliText(member)).join(", ") || "none";
  console.log(
    `- ${cli.formatMatrixCliText(room.roomId)} [${room.source}] strict=${
      room.strict ? "yes" : "no"
    } joined=${members}`,
  );
}

function printDirectRoomInspection(result: MatrixCliDirectRoomInspection): void {
  cli.printAccountLabel(result.accountId);
  console.log(`Peer: ${cli.formatMatrixCliText(result.remoteUserId)}`);
  console.log(`Self: ${cli.formatMatrixCliText(result.selfUserId)}`);
  console.log(`Active direct room: ${cli.formatMatrixCliText(result.activeRoomId, "none")}`);
  console.log(
    `Mapped rooms: ${
      result.mappedRoomIds.length
        ? result.mappedRoomIds.map((roomId) => cli.formatMatrixCliText(roomId)).join(", ")
        : "none"
    }`,
  );
  console.log(
    `Discovered strict rooms: ${
      result.discoveredStrictRoomIds.length
        ? result.discoveredStrictRoomIds.map((roomId) => cli.formatMatrixCliText(roomId)).join(", ")
        : "none"
    }`,
  );
  if (result.mappedRooms.length > 0) {
    console.log("Mapped room details:");
    for (const room of result.mappedRooms) {
      printDirectRoomCandidate(room);
    }
  }
}

async function runMatrixDirectRoomCommand(params: {
  accountId: string;
  userId: string;
  repair: boolean;
}): Promise<MatrixCliDirectRoomInspection | MatrixCliDirectRoomRepair> {
  const cfg = getMatrixRuntime().config.current() as CoreConfig;
  const accountConfig = params.repair
    ? resolveMatrixAccountConfig({ cfg, accountId: params.accountId })
    : undefined;
  const [{ withResolvedActionClient, withStartedActionClient }, direct] = await Promise.all([
    import("./matrix/actions/client.js"),
    import("./matrix/direct-management.js"),
  ]);
  const withClient = params.repair ? withStartedActionClient : withResolvedActionClient;
  return await withClient({ accountId: params.accountId, cfg }, async (client) => {
    const target = { client, remoteUserId: params.userId };
    if (!params.repair) {
      return toCliDirectRoomInspection(
        params.accountId,
        await direct.inspectMatrixDirectRooms(target),
      );
    }
    const encrypted = accountConfig?.encryption === true;
    const repaired = await direct.repairMatrixDirectRooms({ ...target, encrypted });
    return {
      ...toCliDirectRoomInspection(params.accountId, repaired),
      encrypted,
      createdRoomId: repaired.createdRoomId,
      changed: repaired.changed,
      directContentBefore: repaired.directContentBefore,
      directContentAfter: repaired.directContentAfter,
    };
  });
}

function toCliDirectRoomInspection(
  accountId: string,
  inspection: Omit<MatrixCliDirectRoomInspection, "accountId">,
): MatrixCliDirectRoomInspection {
  return {
    accountId,
    remoteUserId: inspection.remoteUserId,
    selfUserId: inspection.selfUserId,
    mappedRoomIds: inspection.mappedRoomIds,
    mappedRooms: inspection.mappedRooms.map(({ roomId, source, strict, joinedMembers }) => ({
      roomId,
      source,
      strict,
      joinedMembers,
    })),
    discoveredStrictRoomIds: inspection.discoveredStrictRoomIds,
    activeRoomId: inspection.activeRoomId,
  };
}

export function registerMatrixDirectCommands(root: Command): void {
  const direct = root.command("direct").description("Inspect and repair Matrix direct-room state");
  for (const name of ["inspect", "repair"] as const) {
    const repair = name === "repair";
    direct
      .command(name)
      .description(`${repair ? "Repair Matrix" : "Inspect"} direct-room mappings for a Matrix user`)
      .requiredOption("--user-id <id>", "Peer Matrix user ID")
      .option("--account <id>", "Account ID (for multi-account setups)")
      .option("--verbose", "Show detailed diagnostics")
      .option("--json", "Output as JSON")
      .action(async (options: cli.MatrixCliOptions & { userId: string }) => {
        const accountId = cli.resolveMatrixCliAccountContext(options.account).accountId;
        await cli.runMatrixCliCommand(options, {
          run: async () =>
            await runMatrixDirectRoomCommand({
              accountId,
              userId: options.userId,
              repair,
            }),
          onText: (result, verbose) => {
            printDirectRoomInspection(result);
            if (!("encrypted" in result)) {
              return;
            }
            console.log(`Encrypted room creation: ${result.encrypted ? "enabled" : "disabled"}`);
            console.log(`Created room: ${cli.formatMatrixCliText(result.createdRoomId, "none")}`);
            console.log(`m.direct updated: ${result.changed ? "yes" : "no"}`);
            if (verbose) {
              console.log(
                `m.direct before: ${cli.formatMatrixCliText(JSON.stringify(result.directContentBefore[result.remoteUserId] ?? []))}`,
              );
              console.log(
                `m.direct after: ${cli.formatMatrixCliText(JSON.stringify(result.directContentAfter[result.remoteUserId] ?? []))}`,
              );
            }
          },
          errorPrefix: `Direct room ${repair ? "repair" : "inspection"} failed`,
        });
      });
  }
}
