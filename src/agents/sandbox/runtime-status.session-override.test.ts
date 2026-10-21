import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSandboxContext } from "./context.js";
import {
  resolvePreparedSandboxRuntimeStatus,
  resolveSandboxRuntimeStatusAsync,
  resolveSandboxRuntimeStatusesForPersistedSessions,
  withSandboxRuntimeStatusesInWorker,
  type SandboxRuntimeStatusParams,
} from "./runtime-status.js";

const optionalStatus = { sandboxed: false, sandboxRequired: false };
const requiredStatus = { sandboxed: true, sandboxRequired: true };

it("uses canonical classification identity in exact, batch, and context resolution", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
    setRuntimeConfigSnapshot(cfg);
    const optional = "agent:main:optional";
    const required = "agent:main:required";
    const classify = (sessionKey: string, classificationSessionKey?: string) =>
      resolveSandboxRuntimeStatusAsync({ cfg, sessionKey, classificationSessionKey });
    for (const sessionKey of [optional, required]) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          sandboxMode: "off",
          ...(sessionKey === required ? { sandbox: "required" as const } : {}),
        },
      );
    }
    expect((await classify("optional")).sandboxed).toBe(false);
    expect(await classify(optional, required)).toMatchObject(requiredStatus);
    expect(await classify(required, optional)).toMatchObject(optionalStatus);
    const [persisted] = await resolveSandboxRuntimeStatusesForPersistedSessions([
      { cfg, agentId: "main", env: state.env, sessionKeys: [optional, required] },
    ]);
    expect(persisted).toMatchObject([optionalStatus, requiredStatus]);
    const native = "agent:main:dashboard:incognito-batch";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: native },
      { sessionId: "native", updatedAt: 1, sandbox: "required", sandboxMode: "off" },
    );
    await expect(
      withSandboxRuntimeStatusesInWorker(
        ["optional", required, native].map((sessionKey) => ({
          cfg,
          agentId: "main",
          sessionKey,
        })),
        { env: state.env, cwd: state.workspaceDir, assertCurrent() {} },
        (statuses) => statuses,
      ),
    ).resolves.toMatchObject([optionalStatus, requiredStatus, requiredStatus]);
    // An opted-out session must not start or prepare any sandbox backend.
    await expect(
      resolveSandboxContext({
        config: cfg,
        sessionKey: optional,
        agentId: "main",
        workspaceDir: state.workspaceDir,
      }),
    ).resolves.toBeNull();
  });
});

it("classifies a trusted patch candidate without using the old row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:candidate";
    const prepared = (
      preparedSessionEntry: NonNullable<SandboxRuntimeStatusParams["preparedSessionEntry"]> | null,
    ) => resolvePreparedSandboxRuntimeStatus({ cfg, sessionKey, preparedSessionEntry });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "candidate", updatedAt: 1 },
    );
    expect((await resolveSandboxRuntimeStatusAsync({ cfg, sessionKey })).sandboxed).toBe(true);
    expect(prepared({ sandboxMode: "off" }).sandboxed).toBe(false);
    expect(prepared(null).sandboxed).toBe(true);
    expect(
      prepared({
        sandbox: "required",
        sandboxMode: "off",
        createdActor: { type: "human", source: "profile", id: "creator" },
      }),
    ).toMatchObject({
      ...requiredStatus,
      isolationSubject: { kind: "profile", profileId: "creator" },
      workspaceAccess: "ro",
    });
  });
});
