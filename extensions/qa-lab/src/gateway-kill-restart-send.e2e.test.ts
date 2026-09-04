import fs from "node:fs/promises";
import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
} from "./suite-runtime-agent-session.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe.skipIf(process.platform === "win32")("gateway hard-kill recovery", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "hard-kill recovery test cleanup failed");
    }
  });

  it("tombstones orphaned mutating work without overwriting newer config", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());
    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());
    const owner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await owner.stop()).errors).toEqual([]);
    });
    const gateway = await owner.start({
      repoRoot,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      forcedRuntime: "openclaw",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: (cfg) => ({
        ...cfg,
        plugins: {
          ...cfg.plugins,
          slots: { ...cfg.plugins?.slots, memory: "none" },
          entries: {
            ...cfg.plugins?.entries,
            acpx: { enabled: false },
            "memory-core": { enabled: false },
          },
        },
        tools: {
          ...cfg.tools,
          alsoAllow: ["qa_restart_wait", "qa_restart_unsafe_probe"],
          codeMode: { enabled: false },
        },
      }),
    });
    const conversation = { id: "kill-restart-send", kind: "direct" as const };
    const sessionKey = buildAgentSessionKey({
      agentId: "qa",
      channel: "qa-channel",
      accountId: transport.accountId,
      peer: { kind: "direct", id: `dm:${conversation.id}` },
      dmScope: gateway.cfg.session?.dmScope,
      identityLinks: gateway.cfg.session?.identityLinks,
    });
    try {
      await transport.waitReady({ gateway });
      await transport.sendInbound({
        accountId: transport.accountId,
        conversation,
        senderId: conversation.id,
        text: "Mutating restart wait QA check. Original prompt marker: KILL-RESTART-MUTATING-PROMPT.",
      });
      const pending = await transport.waitForCondition(
        async () => {
          const entry = (await readRawQaSessionStore({ gateway }))[sessionKey];
          if (entry?.status !== "running") {
            return undefined;
          }
          const transcript = await readSessionTranscriptSummary({ gateway }, sessionKey);
          return (transcript.assistantToolCallCounts.qa_restart_wait ?? 0) >
            (transcript.completedToolCallCounts.qa_restart_wait ?? 0)
            ? { entry, transcript }
            : undefined;
        },
        120_000,
        25,
      );
      const pid = gateway.pid;
      expect(pid).not.toBeNull();
      // Kill the owned process group so no gateway or descendant can drain.
      expect(signalQaPosixProcessGroup(pid!, "SIGKILL")).toBeUndefined();
      await waitForQaTransportCondition(
        () => (!isQaPosixProcessGroupAlive(pid!) ? true : undefined),
        30_000,
        25,
      );
      await gateway.restartAfterStateMutation(async ({ configPath }) => {
        const orphan = (await readRawQaSessionStore({ gateway }))[sessionKey];
        expect(orphan).toMatchObject({ sessionId: pending.entry.sessionId, status: "running" });
        expect(orphan?.abortedLastRun).not.toBe(true);
        const cfg = asOptionalRecord(JSON.parse(await fs.readFile(configPath, "utf8"))) ?? {};
        const agents = asOptionalRecord(cfg.agents) ?? {};
        const next = {
          ...cfg,
          agents: {
            ...agents,
            defaults: {
              ...asOptionalRecord(agents.defaults),
              timeoutSeconds: 654,
            },
          },
        };
        await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      });
      expect(gateway.pid).not.toBe(pid);
      await transport.waitReady({ gateway });
      await transport.waitForCondition(
        async () => {
          if (!gateway.logs().includes("tombstoned main-session restart recovery")) {
            return undefined;
          }
          const entry = (await readRawQaSessionStore({ gateway }))[sessionKey];
          return entry?.status === "failed" ? true : undefined;
        },
        120_000,
        25,
      );
      expect(gateway.logs()).toContain("marked 1 startup-orphaned main session(s)");
      expect(gateway.logs()).not.toContain("dispatching restart-safe recovery");
      const repairedConfig = asOptionalRecord(
        JSON.parse(await fs.readFile(gateway.configPath, "utf8")),
      );
      expect(
        asOptionalRecord(asOptionalRecord(repairedConfig?.agents)?.defaults)?.timeoutSeconds,
      ).toBe(654);
      const settled = await transport.waitForCondition(
        async () => {
          const entry = (await readRawQaSessionStore({ gateway }))[sessionKey];
          return entry?.status === "failed" ? entry : undefined;
        },
        30_000,
        25,
      );
      expect(settled.sessionId).toBe(pending.entry.sessionId);
      await transport.waitForOutbound({
        conversation,
        sinceIndex: 0,
        textIncludes: "couldn't continue this session after a gateway restart",
        timeoutMs: 30_000,
      });
    } catch (error) {
      const diagnostics = await Promise.allSettled([
        readRawQaSessionStore({ gateway }),
        readSessionTranscriptSummary({ gateway }, sessionKey, { allowEmpty: true }),
      ]);
      throw new Error(
        `${String(error)}\nsessions=${JSON.stringify(diagnostics)}\nbus=${JSON.stringify(state.getSnapshot())}\ngateway=${gateway.logs()}`,
        { cause: error },
      );
    }
    // Heavily loaded hosts stretch child boots and the pending checkpoint wait,
    // so the budget leaves real headroom before flaking.
  }, 600_000);
});
