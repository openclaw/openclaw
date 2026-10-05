import { vi } from "vitest";
import { updateSessionGoalStatus, clearSessionGoal } from "../../config/sessions/goals.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { rotateDeviceToken } from "../../infra/device-pairing-tokens.js";
import { removePairedDevice } from "../../infra/device-pairing.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
  linkCanonicalUserProfileEmail,
} from "../../state/user-profile-writes.js";
import { factoryRestartChanges } from "./main-session-recovery-factory-read.test-support.js";
import {
  createOriginalIssuerFixture,
  legacyIssuerChanges,
  acceptedTurnChanges,
} from "./main-session-recovery-original-issuer.test-support.js";

export async function applyOriginalIssuerStartupChange(input: {
  change:
    | (typeof legacyIssuerChanges)[number]
    | (typeof acceptedTurnChanges)[number]
    | (typeof factoryRestartChanges)[number]
    | "accepted issuer mismatch";
  fixture: Awaited<ReturnType<typeof createOriginalIssuerFixture>>;
  cfg: Awaited<ReturnType<typeof createOriginalIssuerFixture>>["cfg"];
  entry: NonNullable<ReturnType<typeof loadSessionEntry>>;
  currentTarget: { agentId: string; sessionKey: string };
  index: number;
  expectedActorId: number;
  noGoal: boolean;
}) {
  const {
    change,
    fixture: { profile, deviceId, originalPairing, changeGrant },
    entry,
    currentTarget,
    index,
    expectedActorId,
    noGoal,
  } = input;
  let cfg = input.cfg;
  if (change === "accepted issuer mismatch") {
    const accepted = entry.mainRestartRecovery!.turnIntent!;
    await replaceSessionEntry(currentTarget, {
      ...entry,
      mainRestartRecovery: {
        ...entry.mainRestartRecovery!,
        turnIntent: {
          ...accepted,
          issuer: {
            ...accepted.issuer,
            factoryActor: { ...accepted.issuer.factoryActor, accountId: expectedActorId + 1 },
          },
        },
      },
    });
  } else if (change === "uncaptured issuer") {
    await replaceSessionEntry(currentTarget, {
      ...entry,
      restartRecoveryGoal: undefined,
      status: "interrupted",
      abortedLastRun: true,
    });
  } else if (!noGoal && change === "manual pause") {
    await updateSessionGoalStatus({ ...currentTarget, status: "paused" });
  } else if (change === "cancel") {
    await clearSessionGoal(currentTarget);
  } else if (!noGoal && change === "complete") {
    await updateSessionGoalStatus({ ...currentTarget, status: "complete" });
  } else if (change === "role revoked") {
    await setCanonicalUserProfileRole(profile.id, "revoked");
  } else if (change === "alias moved") {
    const replacement = await ensureCanonicalUserProfileForEmail(
      `replacement-${index}@example.test`,
    );
    await linkCanonicalUserProfileEmail(`issuer-${index}@example.test`, replacement.id);
  } else if (change === "device removed") {
    await removePairedDevice(deviceId);
  } else if (change === "token rotated same time") {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(originalPairing!.tokens!.operator!.createdAtMs);
    try {
      await rotateDeviceToken({
        deviceId,
        role: "operator",
        callerScopes: ["operator.admin"],
        scopes: ["operator.read"],
      });
    } finally {
      clock.mockRestore();
    }
  } else if (change === "goal changed") {
    await replaceSessionEntry(currentTarget, {
      ...entry,
      goal: { ...entry.goal!, id: "replacement-goal" },
    });
  } else if (change === "SID changed") {
    await replaceSessionEntry(currentTarget, { ...entry, sessionId: "replacement-session" });
  } else if (change === "lifecycle changed") {
    await replaceSessionEntry(currentTarget, {
      ...entry,
      lifecycleRevision: "replacement-life",
    });
  } else if (change === "auth changed") {
    cfg = {
      ...cfg,
      gateway: { ...cfg.gateway, auth: { mode: "token", token: "synthetic-new-auth" } },
    };
  } else if (change === "source role broadened") {
    cfg = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        roles: {
          ...cfg.gateway!.roles!,
          definitions: {
            engineer: {
              ...cfg.gateway!.roles!.definitions.engineer!,
              sessions: { others: "write" },
            },
          },
        },
      },
    };
  } else if (change === "model revoked") {
    cfg = {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        roles: {
          ...cfg.gateway!.roles,
          definitions: {
            engineer: {
              ...cfg.gateway!.roles!.definitions.engineer!,
              modelPolicy: { allow: ["fixture/forbidden"] },
            },
          },
        },
      },
    };
  } else if (change === "grant ended") {
    changeGrant("ended");
  } else if (change === "grant unavailable") {
    changeGrant("unavailable");
  } else if (change === "unknown effect") {
    await replaceSessionEntry(currentTarget, {
      ...entry,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "uncertain-effect",
    });
  } else if (
    change === "missing factory actor" ||
    change === "actor mismatch" ||
    change === "host mismatch"
  ) {
    const savedIntent = noGoal
      ? entry.mainRestartRecovery!.turnIntent!
      : entry.mainRestartRecovery!.goalIntent!;
    const savedActor = savedIntent.issuer.factoryActor!;
    await replaceSessionEntry(currentTarget, {
      ...entry,
      mainRestartRecovery: {
        ...entry.mainRestartRecovery!,
        ...(noGoal
          ? {
              turnIntent: {
                ...entry.mainRestartRecovery!.turnIntent!,
                issuer: {
                  ...savedIntent.issuer,
                  factoryActor: {
                    ...savedActor,
                    accountId:
                      change === "actor mismatch" ? savedActor.accountId + 1 : savedActor.accountId,
                  },
                },
              },
            }
          : {
              goalIntent: {
                ...entry.mainRestartRecovery!.goalIntent!,
                issuer: {
                  ...savedIntent.issuer,
                  factoryActor: {
                    ...savedActor,
                    accountId:
                      change === "actor mismatch" ? savedActor.accountId + 1 : savedActor.accountId,
                  },
                },
              },
            }),
      },
    });
    if (change === "host mismatch" || change === "missing factory actor") {
      const saved = loadSessionEntry(currentTarget)!;
      const corrupted = structuredClone(saved);
      // Mimic malformed historical actor bytes outside the trusted producer contract.
      Object.defineProperty(
        (noGoal
          ? corrupted.mainRestartRecovery!.turnIntent!
          : corrupted.mainRestartRecovery!.goalIntent!
        ).issuer,
        "factoryActor",
        {
          value:
            change === "missing factory actor"
              ? undefined
              : { host: "github.com", accountId: savedActor.accountId },
          enumerable: true,
        },
      );
      await replaceSessionEntry(currentTarget, corrupted);
    }
  }
  return cfg;
}
