import type { App } from "@slack/bolt";
import {
  loadSessionWorktreeLifecycleForTest,
  withRegisteredChannelIngress,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { slackPlugin } from "../../channel-plugin-api.js";
import { setSlackRuntime } from "../runtime.js";
import {
  createSlackTestAccount,
  createInboundSlackTestContext,
} from "./message-handler/prepare.test-helpers.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.each(["restored", "revoked"] as const)(
  "handles archived Slack slash reset through shared dispatch: %s",
  async (mode) => {
    await withOpenClawTestState(
      { label: "slack-slash-archive", scenario: "minimal" },
      async (state) => {
        const storePath = state.path("sessions.json");
        const source = { storePath, sessionKey: "agent:main:slack:slash:u1" };
        const target = { storePath, sessionKey: "agent:main:main" };
        const cfg: OpenClawConfig = {
          commands: { native: false },
          session: { store: storePath },
          channels: { slack: { dmPolicy: "allowlist", allowFrom: ["U1"] } },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        await upsertSessionEntry({
          ...source,
          entry: { sessionId: "source-history", updatedAt: 1 },
        });
        await appendSessionTranscriptMessageByIdentity({
          ...source,
          sessionId: "source-history",
          message: { role: "user", content: "Source history survives", timestamp: 1 },
        });
        const sourceHistory = loadTranscriptEventsSync({ ...source, sessionId: "source-history" });
        await patchSessionEntry({ ...source, update: () => ({ archivedAt: 2 }) });
        await upsertSessionEntry({
          ...target,
          entry: {
            sessionId: "target-history",
            updatedAt: 1,
            ...(mode === "revoked"
              ? { worktree: { id: "held-target", branch: "test", repoRoot: state.root } }
              : {}),
          },
        });
        await appendSessionTranscriptMessageByIdentity({
          ...target,
          sessionId: "target-history",
          message: { role: "user", content: "Retain this history", timestamp: 1 },
        });
        const previousHistory = loadTranscriptEventsSync({
          ...target,
          sessionId: "target-history",
        });
        await patchSessionEntry({ ...target, update: () => ({ archivedAt: 2 }) });
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        if (mode === "revoked") {
          const lifecycle = await loadSessionWorktreeLifecycleForTest();
          vi.spyOn(lifecycle, "restoreSessionWorktree").mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return () => {};
          });
        }

        await withRegisteredChannelIngress(
          { plugin: slackPlugin, config: cfg, setRuntime: setSlackRuntime },
          async (runtime) => {
            const commands = new Map<unknown, (args: unknown) => Promise<void>>();
            const app = {
              client: { chat: {} },
              command: (name: unknown, handler: (args: unknown) => Promise<void>) => {
                commands.set(name, handler);
              },
            } as unknown as App;
            const ctx = createInboundSlackTestContext({
              cfg,
              accountId: "default",
              app,
              channelRuntime: runtime.channel,
            });
            const errors = vi.fn();
            ctx.runtime.error = errors;
            setSlackRuntime(runtime);
            ctx.slashCommand = {
              enabled: true,
              name: "openclaw",
              sessionPrefix: "slack:slash",
              ephemeral: true,
            };
            ctx.resolveChannelName = async () => ({ name: "directmessage", type: "im" });
            ctx.resolveUserName = async () => ({ name: "Ada" });
            const admittedPolicy = await ctx.readRuntimeContext();
            expect(admittedPolicy.isRuntimePolicyCurrent()).toBe(true);
            await registerSlackMonitorSlashCommands({ ctx, account: createSlackTestAccount() });
            const handler = [...commands.values()][0];
            if (!handler) {
              throw new Error("Missing registered Slack slash command");
            }
            const respond = vi.fn().mockResolvedValue(undefined);
            const pending = handler({
              body: {},
              context: { teamId: "T1", isEnterpriseInstall: false },
              client: app.client,
              command: {
                user_id: "U1",
                user_name: "Ada",
                channel_id: "D123",
                channel_name: "directmessage",
                text: "/reset",
                trigger_id: mode === "revoked" ? "trigger-2" : "trigger-1",
              },
              ack: vi.fn().mockResolvedValue(undefined),
              respond,
            });
            if (mode === "revoked") {
              try {
                const boundary = await Promise.race([
                  entered.promise.then(() => "entered" as const),
                  pending.then(() => "settled" as const),
                ]);
                if (boundary !== "entered") {
                  throw new Error(
                    `Restore did not enter the held boundary: replies=${JSON.stringify(respond.mock.calls)} errors=${JSON.stringify(errors.mock.calls)} source=${JSON.stringify(getSessionEntry(source))}`,
                  );
                }
                const revoked: OpenClawConfig = {
                  ...cfg,
                  channels: { slack: { dmPolicy: "disabled" } },
                };
                setRuntimeConfigSnapshot(revoked, revoked);
                expect(admittedPolicy.isRuntimePolicyCurrent()).toBe(false);
              } finally {
                release.resolve();
              }
            }
            await pending;
            if (mode === "revoked") {
              expect(getSessionEntry(target)?.archivedAt).toBe(2);
            }
            expect(respond).toHaveBeenCalledWith(
              expect.objectContaining({
                text:
                  mode === "revoked"
                    ? "Sorry, something went wrong handling that command."
                    : "✅ Session reset.",
              }),
            );
          },
        );

        expect(getSessionEntry(source)).toMatchObject({ sessionId: "source-history" });
        expect(getSessionEntry(source)?.archivedAt).toBeUndefined();
        expect(getSessionEntry(target)).toMatchObject({ sessionId: "target-history" });
        expect(getSessionEntry(target)?.archivedAt).toBe(mode === "revoked" ? 2 : undefined);
        expect(loadTranscriptEventsSync({ ...source, sessionId: "source-history" })).toEqual(
          sourceHistory,
        );
        const afterHistory = loadTranscriptEventsSync({ ...target, sessionId: "target-history" });
        if (mode === "revoked") {
          expect(afterHistory).toEqual(previousHistory);
          return;
        }
        expect(afterHistory.slice(0, previousHistory.length)).toEqual(previousHistory);
        expect(afterHistory.slice(previousHistory.length)).toContainEqual(
          expect.objectContaining({ type: "reset", reason: "reset" }),
        );
      },
    );
  },
);
