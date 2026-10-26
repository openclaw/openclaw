import { assert, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { hashTextSha256 } from "./hash.js";
import { resolveSandboxRuntimeStatusAsync } from "./runtime-status.js";
import {
  buildSandboxContainerName,
  resolveSandboxWorkspaceLayoutPaths,
  slugifySessionKey,
} from "./shared.js";

it.each(["agent", "session", "shared"] as const)(
  "separates non-profile resources with configured %s scope",
  (scope) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const id = "equal-creator-id";
      const sandbox = {
        mode: "off",
        scope,
        workspaceAccess: "rw",
        workspaceRoot: state.path("sandboxes"),
      } as const;
      const cfg: OpenClawConfig = { agents: { defaults: { sandbox } } };
      setRuntimeConfigSnapshot(cfg);
      const actors: Array<SessionCreatedActor | undefined> = [
        { type: "human", source: "profile", id },
        { type: "human", source: "channel", id },
        { type: "human", source: "unknown", id },
        { type: "agent", id },
        { type: "system", id },
        { type: "human", source: "unknown" },
        undefined,
      ];
      const layoutFor = async (sessionKey: string, classificationSessionKey?: string) => {
        const runtime = await resolveSandboxRuntimeStatusAsync({
          cfg,
          sessionKey,
          classificationSessionKey,
        });
        expect(runtime).toMatchObject({
          sessionKey,
          classificationSessionKey: classificationSessionKey ?? sessionKey,
          sandboxed: true,
          workspaceAccess: "ro",
        });
        assert(runtime.sandboxRequired, "required sandbox lost its restriction");
        return resolveSandboxWorkspaceLayoutPaths({
          ...runtime,
          cfg: { ...sandbox, workspaceAccess: runtime.workspaceAccess },
          rawSessionKey: sessionKey,
          workspaceDir: state.workspaceDir,
        });
      };
      const allLayouts: Awaited<ReturnType<typeof layoutFor>>[] = [];
      for (const [index, createdActor] of actors.entries()) {
        for (const suffix of ["one", "two"]) {
          const sessionKey = `agent:main:required-${index}-${suffix}`;
          const entry = {
            sessionId: sessionKey,
            updatedAt: 1,
            createdVia: "cron",
            createdActor,
            sandbox: "required",
          } as const;
          await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
          const layout = await layoutFor(sessionKey);
          for (const alias of [sessionKey.slice("agent:main:".length), sessionKey.toUpperCase()]) {
            expect.soft(await layoutFor(alias), alias).toEqual(layout);
            const borrowed = await layoutFor("agent:main:borrowed-runtime", alias);
            expect.soft(borrowed, alias).toEqual(layout);
          }
          allLayouts.push(layout);
        }
      }
      const [first, second] = allLayouts;
      assert(first && second, "expected two persisted profile sessions");
      expect(first.scopeKey).toBe(
        `agent:main:principal:${hashTextSha256(id).slice(0, 32)}:workspace:${hashTextSha256(state.workspaceDir).slice(0, 32)}`,
      );
      expect(second).toEqual(first);
      // Of 14 sessions, only the two profile sessions may share resources.
      for (const key of ["scopeKey", "workspaceDir"] as const) {
        expect.soft(new Set(allLayouts.map((layout) => layout[key])).size, key).toBe(13);
      }
      const containers = allLayouts.map(({ scopeKey }) =>
        buildSandboxContainerName("openclaw-sbx-", slugifySessionKey(scopeKey)),
      );
      expect.soft(new Set(containers).size).toBe(13);
    }),
);
