import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import { NativeSubagentsSnapshotSchema } from "../../../packages/gateway-protocol/src/schema/native-subagents.js";
import { captureAgentHarnessLifecycleHooks } from "./registry-lifecycle.js";
import type { AgentHarness, AgentHarnessNativeSubagents } from "./types.js";

const validateSnapshot = lazyCompile(NativeSubagentsSnapshotSchema);

/** Observe retained work even when its parent's selected runtime has since changed. */
export async function withNativeSubagentsRead<T>(
  params: Parameters<NonNullable<AgentHarness["readNativeSubagents"]>>[0],
  consume: (
    snapshot: AgentHarnessNativeSubagents | undefined,
    assertCurrent: () => void,
  ) => Promise<T>,
): Promise<T> {
  const owners = captureAgentHarnessLifecycleHooks("readNativeSubagents");
  let active = true;
  const assertCurrent = () => {
    params.assertCurrent();
    if (!active || owners.some((owner) => !owner.isCurrent())) {
      throw new Error("Native subagent observation owner changed");
    }
  };
  try {
    assertCurrent();
    const snapshots = await Promise.all(
      owners.map(async (owner) => {
        const observed = await owner.prepare({ ...params, assertCurrent });
        assertCurrent();
        if (observed !== undefined && !validateSnapshot(observed)) {
          throw new Error("Invalid native subagent observation");
        }
        return (
          observed && {
            coverage: observed.coverage,
            children: observed.children.map((child) => ({
              id: `${owner.registration.harness.id}:${child.id}`,
              label: child.label,
              status: child.status,
            })),
            truncated: observed.truncated,
          }
        );
      }),
    );
    const available = snapshots.filter((observed) => observed !== undefined);
    const children = available.flatMap((observed) => observed.children);
    const snapshot: AgentHarnessNativeSubagents | undefined = available.length
      ? {
          coverage: "live",
          children: children.slice(0, 128),
          truncated: children.length > 128 || available.some((observed) => observed.truncated),
        }
      : undefined;
    assertCurrent();
    if (snapshot !== undefined && !validateSnapshot(snapshot)) {
      throw new Error("Invalid combined native subagent observation");
    }
    return await consume(snapshot, assertCurrent);
  } finally {
    active = false;
  }
}
