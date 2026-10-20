import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveWhatsAppAccount,
  type WhatsAppQaDriverObservedMessage,
  type WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { describe, expect, it, vi } from "vitest";
import { fingerprintQaCredentialId } from "../../qa-credentials-fingerprint.runtime.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import {
  applyQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayConfigPatches,
} from "../../suite-planning.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";
import {
  createArchive,
  createDriver,
  observedMessage,
  phones,
  groupJid,
} from "./runtime.test-support.js";
import { whatsappScenarioImplementations } from "./scenario-implementations.js";
import { runWhatsAppApprovalScenario } from "./whatsapp-live.approvals.js";
import { buildWhatsAppQaConfig, parseWhatsAppQaCredentialPayload } from "./whatsapp-live.config.js";
import {
  resolveWhatsAppQaMessageTargets,
  type WhatsAppQaScenarioImplementation,
  type WhatsAppQaScenarioMetadata,
  type WhatsAppQaScenarioRun,
} from "./whatsapp-live.contracts.js";
import { isTransientWhatsAppQaDriverError } from "./whatsapp-live.driver.js";
import {
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
} from "./whatsapp-live.gateway.js";
import { runWhatsAppStructuredInboundChecks } from "./whatsapp-live.media.js";
import { waitForScenarioObservedMessage } from "./whatsapp-live.observations.js";
import { unpackWhatsAppAuthArchive } from "./whatsapp-live.setup.js";

type Scenario = WhatsAppQaScenarioMetadata & WhatsAppQaScenarioImplementation;
type MessageRun = Exclude<WhatsAppQaScenarioRun, { kind: "approval" }>;
type Context = Parameters<NonNullable<MessageRun["afterSend"]>>[0];
type WhatsAppQaConfigBase = Parameters<typeof buildWhatsAppQaConfig>[0];
type WhatsAppQaConfigParams = Parameters<typeof buildWhatsAppQaConfig>[1];
type Hook = "afterReply" | "afterSend" | "verify";

function createGateway(overrides: Partial<Context["gateway"]> = {}): Context["gateway"] {
  return {
    call: async () => ({}),
    restart: async () => {},
    workspaceDir: "/tmp/openclaw-whatsapp-qa",
    ...overrides,
  };
}

function createContext(
  overrides: Partial<Context> & {
    scenario?: Scenario;
  } = {},
): Context {
  const { scenario, ...contextOverrides } = overrides;
  const workspaceDir = contextOverrides.gatewayWorkspaceDir ?? "/tmp/openclaw-whatsapp-qa";
  return {
    driver: createDriver(),
    ...phones,
    gateway: {
      call: async () => {
        throw new Error("WhatsApp scenario test did not expect a Gateway call");
      },
      restart: async () => {},
      workspaceDir,
    },
    gatewayTarget: "+15550000001",
    gatewayWorkspaceDir: workspaceDir,
    requestStartedAt: new Date("2026-06-21T12:00:00.000Z"),
    scenarioId: scenario?.id ?? "whatsapp-canary",
    sent: { messageId: "driver-message-1" },
    sutAccountId: "sut",
    target: "+15550000002",
    targetKind: "dm",
    ...contextOverrides,
  };
}

function buildConfig(
  options: Partial<WhatsAppQaConfigParams> = {},
  base: WhatsAppQaConfigBase = {},
) {
  return buildWhatsAppQaConfig(base, {
    allowFrom: ["+15550000001"],
    authDir: "/tmp/openclaw-whatsapp-qa-auth",
    dmPolicy: "allowlist",
    ownerAllowFrom: ["+15550000001"],
    sutAccountId: "sut",
    ...options,
  });
}

function getWhatsAppScenario(id: string): Scenario {
  const scenario = requireFlowScenario(readQaScenarioById(id));
  const name = scenario.execution.config?.whatsappScenario;
  const implementation =
    typeof name === "string" ? whatsappScenarioImplementations[name] : undefined;
  if (!implementation) {
    throw new Error(`missing WhatsApp test implementation for ${id}`);
  }
  return {
    ...implementation,
    id,
    timeoutMs: scenario.execution.timeoutMs ?? 60_000,
  };
}

function updateObservedMessage(
  messages: WhatsAppQaDriverObservedMessage[],
  index: number,
  patch: Partial<WhatsAppQaDriverObservedMessage>,
): void {
  messages[index] = {
    ...expectDefined(messages[index], `WhatsApp observed message ${index}`),
    observedAt: new Date().toISOString(),
    ...patch,
  };
}
function messageScenario<THook extends Hook = never>(
  source: string | Scenario,
  hooks: THook[] = [],
): {
  scenario: Scenario;
  run: MessageRun & Required<Pick<MessageRun, THook>>;
} {
  const scenario = typeof source === "string" ? getWhatsAppScenario(source) : source;
  const run = scenario.buildRun();
  if (run.kind === "approval") {
    throw new Error(`${scenario.id} unexpectedly built an approval run`);
  }
  for (const hook of hooks) {
    if (!run[hook]) {
      throw new Error(`${scenario.id} missing ${hook}`);
    }
  }
  return {
    scenario,
    run: run as MessageRun & Required<Pick<MessageRun, THook>>,
  };
}

function statusReactionFixture(...emojis: Array<"👀" | "✅">) {
  const { scenario, run } = messageScenario("whatsapp-status-reaction-lifecycle", ["afterReply"]);
  const reactions = emojis.map((emoji, index) =>
    observedMessage(emoji === "👀" ? "reaction-queued" : "reaction-done", {
      kind: "reaction",
      observedAt: `2026-06-21T12:00:0${index + 1}.000Z`,
      reaction: { emoji, messageId: "trigger-1" },
      text: "",
    }),
  );
  const context = createContext({
    driver: createDriver({ getObservedMessages: () => reactions }),
    scenario,
    sent: { messageId: "trigger-1" },
  });
  return { context, run };
}

describe("WhatsApp QA live runtime", () => {
  it("can remove copied Signal sessions while preserving other auth archive state", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-qa-test-"));
    try {
      const preserved = [
        "creds.json",
        "device-list-15550000001.json",
        "lid-mapping-123_reverse.json",
        "sender-key-120363000@g.us--123_1--5.json",
      ];
      const sessions = ["session-123_1.0.json", "session-123_1.5.json"];
      const entries = Object.fromEntries([...preserved, ...sessions].map((file) => [file, "{}\n"]));
      const archiveBase64 = await createArchive(tempRoot, entries);
      const authDir = await unpackWhatsAppAuthArchive({
        archiveBase64,
        clearSignalSessions: true,
        label: "driver",
        parentDir: tempRoot,
      });
      for (const file of preserved) {
        await expect(fs.readFile(path.join(authDir, file), "utf8")).resolves.toBe("{}\n");
      }
      for (const file of sessions) {
        await expect(fs.stat(path.join(authDir, file))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(["+15550000002", "+15550000001"])(
    "validates credential phones with SUT %s",
    (sutPhoneE164) => {
      const parse = () =>
        parseWhatsAppQaCredentialPayload({
          driverPhoneE164: "15550000001",
          sutPhoneE164,
          driverAuthArchiveBase64: "driver",
          sutAuthArchiveBase64: "sut",
        });
      if (sutPhoneE164 === "+15550000001") {
        expect(parse).toThrow("requires two distinct WhatsApp phone numbers");
        return;
      }
      expect(parse()).toEqual({
        ...phones,
        driverAuthArchiveBase64: "driver",
        sutAuthArchiveBase64: "sut",
      });
    },
  );

  it("derives a stable non-secret credential fingerprint", () => {
    expect(fingerprintQaCredentialId("cred-stale-row")).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(fingerprintQaCredentialId(undefined)).toBeUndefined();
  });

  it.each([undefined, groupJid])(
    "observes native WhatsApp reactions with group=%s",
    async (group) => {
      const { scenario, run } = messageScenario(
        group ? "whatsapp-group-agent-message-action-react" : "whatsapp-agent-message-action-react",
        ["afterSend"],
      );
      const triggerId = group ? "group-trigger-message-1" : "driver-trigger-message-1";
      const reaction = observedMessage("reaction-event-1", {
        ...(group ? { fromJid: group } : {}),
        kind: "reaction",
        text: "👍",
        observedAt: "2026-06-21T12:00:02.000Z",
        reaction: {
          emoji: "👍",
          messageId: triggerId,
          ...(group ? { participant: "15550000001@s.whatsapp.net" } : {}),
        },
      });
      const rejected = [
        {
          ...reaction,
          ...(group ? { fromJid: "120363999999999999@g.us" } : { fromPhoneE164: "+15550000003" }),
        },
        { ...reaction, reaction: { ...reaction.reaction, emoji: "👎" } },
        { ...reaction, reaction: { ...reaction.reaction, messageId: "other-message" } },
      ];
      const context = createContext({
        scenario,
        sent: { messageId: triggerId },
        ...(group
          ? { gatewayTarget: group, target: group, targetKind: "group" as const }
          : { gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway" }),
        driver: createDriver({
          waitForMessage: async ({ match }) => {
            for (const candidate of rejected) {
              expect(match(candidate)).toBe(false);
            }
            expect(match(reaction)).toBe(true);
            return reaction;
          },
        }),
      });
      expect(await run.afterSend(context)).toMatch(
        group ? /group agent message reaction/i : /\breaction\b/i,
      );
    },
  );

  it("runs WhatsApp group direct Gateway media, audio, and poll probes against the group target", async () => {
    const gatewayCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const observations: Array<[string, Partial<WhatsAppQaDriverObservedMessage>]> = [
      ["image", { hasMedia: true, kind: "media", mediaType: "image/png" }],
      [
        "document",
        {
          hasMedia: true,
          kind: "media",
          mediaFileName: "whatsapp-qa-group.pdf",
          mediaType: "application/pdf",
        },
      ],
      ["audio", { hasMedia: true, kind: "media", mediaType: "audio/ogg; codecs=opus" }],
      ["audio-text", {}],
      ["poll", { kind: "poll", poll: { options: ["alpha", "beta"] } }],
    ];
    const observedMessages = observations.map(([name, overrides], index) =>
      observedMessage(`group-${name}-1`, {
        fromJid: groupJid,
        text: "",
        observedAt: `2026-06-21T12:00:0${index + 2}.000Z`,
        ...overrides,
      }),
    );
    const driver = createDriver({
      waitForMessage: async (params) => {
        const match = observedMessages.find((message) => params.match(message));
        if (!match) {
          throw new Error("missing matching group observation");
        }
        return match;
      },
    });
    const context = createContext({
      driver,
      gateway: createGateway({
        call: async (method, payload) => {
          gatewayCalls.push({ method, payload: payload as Record<string, unknown> });
          const { message, question } = payload as Record<string, unknown>;
          if (typeof question === "string" && question) {
            updateObservedMessage(observedMessages, 4, {
              poll: { options: ["alpha", "beta"], question },
            });
          }
          if (typeof message !== "string") {
            return {};
          }
          if (message.endsWith("_IMAGE")) {
            updateObservedMessage(observedMessages, 0, { text: message });
          }
          if (message.endsWith("_DOCUMENT")) {
            updateObservedMessage(observedMessages, 1, { text: message });
          }
          if (message.endsWith("_AUDIO")) {
            updateObservedMessage(observedMessages, 2, {});
            updateObservedMessage(observedMessages, 3, { text: message });
          }
          return {};
        },
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      }),
      gatewayTarget: groupJid,
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      target: groupJid,
      targetKind: "group",
    });

    for (const [index, kind] of ["media", "audio", "poll"].entries()) {
      const { scenario, run } = messageScenario(`whatsapp-group-outbound-${kind}`, ["afterReply"]);
      await run.afterReply(
        observedMessage(`reply-${index + 1}`, { fromJid: groupJid, text: String(run.matchText) }),
        { ...context, scenarioId: scenario.id },
      );
    }

    expect(gatewayCalls.map(({ method }) => method)).toEqual(["send", "send", "send", "poll"]);
    expect(gatewayCalls.every(({ payload }) => payload.to === groupJid)).toBe(true);
  });

  it("requires the reply-context isolation quoted send to carry quote metadata", async () => {
    const { scenario, run } = messageScenario("whatsapp-reply-context-isolation", ["afterReply"]);

    const gatewayCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let waitCount = 0;
    const driver = createDriver({
      waitForMessage: async (params) => {
        waitCount += 1;
        const messageText = String(gatewayCalls[waitCount - 1]?.payload.message);
        const base = observedMessage(`sut-reply-${waitCount}`, {
          observedAt: new Date().toISOString(),
          text: messageText,
        });
        if (waitCount === 1) {
          expect(params.match(base)).toBe(false);
          expect(params.match({ ...base, quoted: { messageId: "wrong-trigger" } })).toBe(false);
          const quoted = { ...base, quoted: { messageId: "driver-message-1" } };
          expect(params.match(quoted)).toBe(true);
          return quoted;
        }
        expect(params.match({ ...base, text: "wrong fresh marker" })).toBe(false);
        expect(params.match(base)).toBe(true);
        return base;
      },
    });
    const context = createContext({
      driver,
      gateway: createGateway({
        call: async (method, payload) => {
          gatewayCalls.push({ method, payload: payload as Record<string, unknown> });
          return {};
        },
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      }),
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      scenario,
    });

    await run.afterReply(
      observedMessage("initial-reply", { text: String(run.matchText) }),
      context,
    );

    expect(gatewayCalls.map(({ payload }) => payload.replyToId)).toEqual([
      "driver-message-1",
      undefined,
    ]);
    expect(waitCount).toBe(2);
  });

  it("asserts batched reply-to mode quotes the second queued message", async () => {
    const { scenario, run } = messageScenario("whatsapp-reply-to-mode-batched", [
      "afterSend",
      "verify",
    ]);

    const sentTexts: string[] = [];
    const context = createContext({
      driver: createDriver({
        sendText: async (_to, text) => {
          sentTexts.push(text);
          return { messageId: "second-batched-message" };
        },
      }),
      scenario,
      sent: { messageId: "first-batched-message" },
    });

    await run.afterSend(context);
    const firstMarker = run.input.match(/\bWHATSAPP_QA_BATCHED_FIRST_[A-Z0-9]+\b/u)?.[0];
    const finalMarker = String(run.matchText);
    expect(firstMarker).toEqual(expect.any(String));
    expect(sentTexts[0]).toContain(finalMarker);
    expect(sentTexts[0]).not.toContain(firstMarker);

    expect(() =>
      run.verify?.(
        observedMessage("reply-1", { quoted: { messageId: "second-batched-message" } }),
        context,
      ),
    ).not.toThrow();
  });

  it("waits for media from the user-path WhatsApp upload-file scenario", async () => {
    const { scenario, run } = messageScenario("whatsapp-agent-message-action-upload-file", [
      "afterSend",
    ]);

    const token = /\bWHATSAPP_QA_AGENT_UPLOAD_[A-Z0-9]+\b/u.exec(run.input)?.[0];
    if (!token) {
      throw new Error("missing upload token in scenario input");
    }
    const media = Promise.withResolvers<WhatsAppQaDriverObservedMessage>();
    const waitForMessage = vi.fn(() => media.promise);
    const context = createContext({
      driver: createDriver({
        waitForMessage,
      }),
      scenario,
      sent: { messageId: "trigger-1" },
    });

    let settled = false;
    const pending = run.afterSend(context).then((details) => {
      settled = true;
      return details;
    });
    await Promise.resolve();
    expect(waitForMessage).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    media.resolve(
      observedMessage("media-1", {
        hasMedia: true,
        kind: "media",
        mediaType: "image/png",
        observedAt: "2026-06-21T12:00:02.000Z",
        text: token,
      }),
    );
    expect(await pending).toContain("upload-file media");
  });

  it.each([true, false])(
    "validates WhatsApp status reaction ordering: ordered=%s",
    async (ordered) => {
      const { context, run } = ordered
        ? statusReactionFixture("👀", "✅")
        : statusReactionFixture("✅", "👀");
      vi.useFakeTimers({ now: new Date("2026-06-21T12:00:00.000Z") });
      try {
        const result = run.afterReply(
          observedMessage("reply-1", {
            observedAt: "2026-06-21T12:00:03.000Z",
          }),
          context,
        );
        const outcome = ordered
          ? expect(result).resolves.toContain("👀 -> ✅")
          : expect(result).rejects.toThrow(
              "timed out waiting for WhatsApp status reaction sequence",
            );
        await vi.runAllTimersAsync();
        await outcome;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("uses opposite DM peers for driver sends and Gateway sends", () => {
    expect(
      resolveWhatsAppQaMessageTargets({
        ...phones,
        scenarioTarget: "dm",
      }),
    ).toEqual({
      driverTarget: "+15550000002",
      gatewayTarget: "+15550000001",
    });
    expect(
      resolveWhatsAppQaMessageTargets({
        ...phones,
        groupJid: "120363000000000000@g.us",
        scenarioTarget: "group",
      }),
    ).toEqual({
      driverTarget: "120363000000000000@g.us",
      gatewayTarget: "120363000000000000@g.us",
    });
  });

  it("routes WhatsApp Gateway DM helper calls to the driver peer", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const context = createContext({
      scenarioId: "whatsapp-reply-context-isolation",
      gateway: createGateway({
        call: async (method, payload) => {
          calls.push({ method, payload: payload as Record<string, unknown> });
          return {};
        },
      }),
    });

    await callWhatsAppGatewaySend(context, {
      label: "quoted",
      message: "WHATSAPP_QA_QUOTED",
      replyToId: "driver-message-1",
    });
    await callWhatsAppGatewayPoll(context, {
      label: "poll",
      options: ["alpha", "beta"],
      question: "WHATSAPP_QA_POLL",
    });
    await callWhatsAppGatewayMessageAction(context, {
      action: "react",
      label: "react",
      params: {
        emoji: "👍",
        messageId: "driver-message-1",
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls.map(({ payload }) => payload)).toMatchObject([
      { to: "+15550000001" },
      { to: "+15550000001" },
      {
        params: { emoji: "👍", messageId: "driver-message-1", to: "+15550000001" },
        conversationReadOrigin: "direct-operator",
      },
    ]);
  });

  it("derives live-frontier selection from taxonomy and provider eligibility", () => {
    const scenarioIds = resolveLiveTransportQaScenarioIds({
      channelId: "whatsapp",
      providerMode: "live-frontier",
      supportsModuleFlows: true,
    });

    expect(scenarioIds).toContain("whatsapp-canary");
    expect(scenarioIds).toContain("whatsapp-mention-gating");
    expect(scenarioIds).not.toContain("whatsapp-native-new-command");
  });

  it("patches the effective WhatsApp policy for default and named SUT accounts", async () => {
    const policies = [
      ["access-control-dm-disabled", "dmPolicy", "disabled", "allowlist"],
      ["access-control-dm-open", "dmPolicy", "open", "allowlist"],
      ["access-control-group-disabled", "groupPolicy", "disabled", "open"],
      ["access-control-group-open", "groupPolicy", "open", "disabled"],
      ["pairing-block", "dmPolicy", "pairing", "allowlist"],
    ] as const;
    for (const accountId of ["default", "work"]) {
      for (const [name, key, value, stale] of policies) {
        const id = "whatsapp-" + name;
        const accounts = { [accountId]: { [key]: stale } };
        const initialConfig = buildConfig(
          { sutAccountId: accountId },
          {
            channels: { whatsapp: { accounts } },
          },
        );
        const scenario = readQaScenarioById(id);
        const flow = scenario.execution.kind === "flow" ? scenario.execution.flow : undefined;
        expect(JSON.stringify(flow), id).not.toContain('"patchConfig"');
        const patches = collectQaSuiteGatewayConfigPatches([scenario], accountId);
        const cfg = applyQaSuiteGatewayConfigPatches(
          initialConfig,
          patches,
        ) as WhatsAppQaConfigBase;
        const effective = resolveWhatsAppAccount({ cfg, accountId });
        expect(effective[key], id + ":" + accountId + ":effective").toBe(value);
        if (value === "pairing") {
          expect(effective.allowFrom).toEqual(["+15550000000"]);
        }
      }
    }
  });

  it("preserves configured command owners while adding the WhatsApp QA driver", () => {
    const cfg = buildConfig(
      {},
      {
        commands: { ownerAllowFrom: ["telegram:existing-owner"] },
      },
    );

    expect(cfg.commands?.ownerAllowFrom).toEqual(["telegram:existing-owner", "+15550000001"]);
  });

  it.each([false, true])(
    "restores mention gating after activation probe (failure=%s)",
    async (failProbe) => {
      const { scenario, run } = messageScenario("whatsapp-group-activation-always", ["afterReply"]);
      expect(run).toMatchObject({ target: "group", input: "/activation always" });
      const sent: Array<{ text: string; to: string }> = [];
      const alwaysMarker = /\bWHATSAPP_QA_ACTIVATION_ALWAYS_[A-Z0-9]+\b/u;
      const quietMarker = /\bWHATSAPP_QA_ACTIVATION_QUIET_[A-Z0-9]+\b/u;
      let alwaysMatched = false;
      let quietReads = 0;
      const driver = createDriver({
        sendText: async (to, text) => {
          sent.push({ text, to });
          return { messageId: "driver-message-" + sent.length };
        },
        getObservedMessages: () => {
          if (sent.some(({ text }) => quietMarker.test(text))) {
            quietReads++;
          }
          return [];
        },
        waitForMessage: async ({ match }) => {
          const restoring = sent.some(
            ({ text, to }) => to === groupJid && text.trim() === "/activation mention",
          );
          if (failProbe && !restoring) {
            throw new Error("forced always-mode probe failure");
          }
          const probe = sent.findLast(
            ({ text }) => alwaysMarker.test(text) && !/\bopenclawqa\b/iu.test(text),
          );
          const reply = observedMessage(
            restoring ? "sut-activation-restore" : "sut-activation-observation-0",
            {
              fromJid: groupJid,
              observedAt: new Date().toISOString(),
              text: restoring
                ? "Activation: mention"
                : expectDefined(probe, "unmentioned always probe").text,
            },
          );
          if (!restoring) {
            expect(
              match({
                ...reply,
                messageId: "sut-activation-wrong-marker",
                text: reply.text.replace(alwaysMarker, "WHATSAPP_QA_ACTIVATION_ALWAYS_WRONG"),
              }),
            ).toBe(false);
          }
          if (!match(reply)) {
            throw new Error("activation scenario waited for an unexpected message");
          }
          if (!restoring) {
            alwaysMatched = true;
          }
          return reply;
        },
      });
      const context = createContext({
        driver,
        scenario,
        gatewayTarget: groupJid,
        target: groupJid,
        gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-workspace",
        sent: { messageId: "activation-command-message" },
      });
      vi.useFakeTimers({ now: new Date("2026-06-21T12:00:02.000Z") });
      try {
        const result = run.afterReply(
          observedMessage("sut-activation-command-reply", {
            fromJid: groupJid,
            text: "Activation: always",
          }),
          context,
        );
        const outcome = failProbe
          ? expect(result).rejects.toThrow("forced always-mode probe failure")
          : result;
        await vi.runAllTimersAsync();
        await outcome;
      } finally {
        vi.useRealTimers();
      }
      const restoreIndex = sent.findIndex(
        ({ text, to }) => to === groupJid && text.trim() === "/activation mention",
      );
      expect(restoreIndex).toBeGreaterThanOrEqual(0);
      if (!failProbe) {
        const probe = sent.find(({ text }) => alwaysMarker.test(text));
        expect(probe?.to).toBe(groupJid);
        expect(probe?.text).not.toMatch(/\bopenclawqa\b/i);
        expect(alwaysMatched).toBe(true);
        const quiet = sent.slice(restoreIndex + 1).find(({ text }) => quietMarker.test(text));
        expect(quiet?.to).toBe(groupJid);
        expect(quiet?.text).not.toMatch(/\bopenclawqa\b/i);
        expect(quietReads).toBeGreaterThan(0);
      }
    },
  );

  it("quotes the observed SUT reply without an explicit mention for reply-to-bot activation", async () => {
    const { scenario, run } = messageScenario("whatsapp-group-reply-to-bot-triggers", [
      "afterReply",
    ]);

    expect(run.target).toBe("group");
    expect(run.input).toMatch(/\bopenclawqa\b/iu);
    expect(run.input).toMatch(/\bWHATSAPP_QA_REPLY_TO_BOT_SEED_[A-Z0-9]+\b/u);

    const participantJid = "15550000002@s.whatsapp.net";
    const sendTextCalls: Array<{
      options: Parameters<WhatsAppQaDriverSession["sendText"]>[2];
      text: string;
      to: string;
    }> = [];
    let finalReplyMatched = false;
    const driver = createDriver({
      sendText: async (to, text, options) => {
        sendTextCalls.push({ options, text, to });
        return { messageId: `driver-quoted-${sendTextCalls.length}` };
      },
      waitForMessage: async (params) => {
        const matches = params.match;
        const quotedTrigger = sendTextCalls.find((call) => call.options?.quotedMessageKey);
        const marker = quotedTrigger
          ? /\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u.exec(quotedTrigger.text)?.[0]
          : undefined;
        if (!marker) {
          throw new Error("reply-to-bot scenario waited before sending the quoted trigger");
        }
        const candidate = observedMessage("sut-reply-to-bot-final", {
          fromJid: groupJid,
          observedAt: new Date().toISOString(),
          text: marker ?? "",
        });
        expect(
          matches({
            ...candidate,
            messageId: "sut-reply-to-bot-wrong-marker",
            text: "WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_WRONG",
          }),
        ).toBe(false);
        expect(matches(candidate)).toBe(false);
        const quotedCandidate = {
          ...candidate,
          quoted: { messageId: "driver-quoted-1" },
        };
        if (matches(quotedCandidate)) {
          finalReplyMatched = true;
          return quotedCandidate;
        }
        throw new Error("reply-to-bot scenario waited for an unexpected message");
      },
    });
    const seedReply = observedMessage("sut-seed-reply", {
      fromJid: groupJid,
      participantJid,
      text: "WHATSAPP_QA_REPLY_TO_BOT_SEED_TEST",
    });

    await run.afterReply(
      seedReply,
      createContext({
        driver,
        gatewayTarget: groupJid,
        gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-workspace",
        scenario,
        sent: { messageId: "driver-seed-message" },
        target: groupJid,
      }),
    );

    const quotedSend = sendTextCalls.find((call) => call.options?.quotedMessageKey);
    expect(quotedSend?.to).toBe(groupJid);
    expect(quotedSend?.text).toMatch(/\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u);
    expect(quotedSend?.text).not.toMatch(/\bopenclawqa\b/i);
    expect(quotedSend?.text).not.toMatch(/@\d/u);
    expect(quotedSend?.options?.quotedMessageKey).toMatchObject({
      fromMe: false,
      id: "sut-seed-reply",
      messageText: seedReply.text,
      participant: participantJid,
      remoteJid: groupJid,
    });
    expect(finalReplyMatched).toBe(true);
  });

  it("defines quote-reply scenarios for DM and group replies", () => {
    const scenarios = ["whatsapp-reply-to-message", "whatsapp-group-reply-to-message"].map(
      getWhatsAppScenario,
    );
    const runs = scenarios.map((scenario) => messageScenario(scenario, ["verify"]));

    expect(runs.map(({ scenario, run }) => [scenario.requiresGroupJid, run.target])).toEqual([
      [undefined, "dm"],
      [true, "group"],
    ]);
    expect(runs[0]?.run.input).not.toContain("openclawqa");
    expect(runs[1]?.run.input).toMatch(/^openclawqa\b/u);

    for (const { run } of runs) {
      const context = createContext({ sent: { messageId: "trigger-message-id" } });
      const reply = observedMessage("reply", {
        observedAt: "2026-06-05T01:00:01.000Z",
        text: "reply",
      });
      expect(() =>
        run.verify({ ...reply, quoted: { messageId: "trigger-message-id" } }, context),
      ).not.toThrow();
      expect(() => run.verify(reply, context)).toThrow(
        "expected reply quote trigger-message-id, got <missing>",
      );
    }
  });

  it("seeds the structured-message location check through text context", () => {
    const { run } = messageScenario("whatsapp-inbound-structured-messages");

    expect(run.input).toContain("37.774900, -122.419400");
    expect(run.input).toContain("WhatsApp location marker");
    expect(run.input).toContain("WhatsApp contact marker");
    expect(run.input).toContain("WhatsApp sticker marker");
    expect(run.input).toContain("exact marker before structured inbound checks");
  });

  it("sends a WhatsApp-routable contact card in the structured-message check", async () => {
    const sendContact = vi.fn(async () => ({ messageId: "contact-1" }));
    const driver = createDriver({
      sendContact,
      sendLocation: vi.fn(async () => ({ messageId: "location-1" })),
      sendMedia: vi.fn(async () => ({ messageId: "document-1" })),
      sendSticker: vi.fn(async () => ({ messageId: "sticker-1" })),
    });

    await runWhatsAppStructuredInboundChecks({
      contactToken: "CONTACT_TOKEN",
      documentToken: "DOCUMENT_TOKEN",
      driver,
      ...phones,
      locationToken: "LOCATION_TOKEN",
      stickerToken: "STICKER_TOKEN",
      target: "+15550000002",
      waitForStructuredReply: async () => {},
    });

    expect(sendContact).toHaveBeenCalledWith(
      "+15550000002",
      expect.objectContaining({
        vcard: expect.stringContaining("waid=15550000001:+15550000001"),
      }),
    );
  });

  it("adds safe diagnostics when a WhatsApp scenario reply wait observes nothing", async () => {
    const driver = createDriver({
      waitForMessage: async () => {
        throw new Error("timed out waiting for WhatsApp QA driver message");
      },
    });
    const context = createContext({
      driver,
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      requestStartedAt: new Date("2026-06-05T01:00:00.000Z"),
    });

    await expect(
      waitForScenarioObservedMessage(context, {
        observedAfter: new Date("2026-06-05T01:00:00.000Z"),
        match: () => true,
      }),
    ).rejects.toThrow("observed 0 WhatsApp driver message(s) after wait lower bound");
  });

  it("defines WhatsApp final-message accounting as a settled two-chunk assertion", () => {
    const { run } = messageScenario("whatsapp-stream-final-message-accounting");

    expect(run.input).toContain("WhatsApp long final QA check");
    expect(run).toMatchObject({
      matchText: "WHATSAPP-LONG-FINAL-BEGIN",
      expectedJoinedSutTextIncludes: ["WHATSAPP-LONG-FINAL-BEGIN", "WHATSAPP-LONG-FINAL-END"],
      expectedSutMessageCount: 2,
      settleMs: 4_000,
    });
  });

  it("requires the long-reply delivery-shape tail marker in the second chunk", async () => {
    const { run } = messageScenario("whatsapp-reply-delivery-shape", ["afterReply"]);
    const token = String(run.matchText);
    let waitCallCount = 0;
    const chunk = (id: string, text: string, quoted = true) =>
      observedMessage(id, {
        observedAt: new Date().toISOString(),
        text,
        ...(quoted ? { quoted: { messageId: "driver-message-1" } } : {}),
      });
    const driver = createDriver({
      waitForMessage: async (params) => {
        waitCallCount += 1;
        if (waitCallCount === 1) {
          const firstChunk = chunk("chunk-1", `${token}_LONG_BEGIN`);
          expect(params.match(firstChunk)).toBe(true);
          return firstChunk;
        }

        const missingTailMarker = chunk("chunk-2", "second chunk without the tail marker");
        const missingQuoteChunk = chunk("chunk-3", `${token}_LONG_END`, false);
        const tailChunk = chunk("chunk-4", `${token}_LONG_END`);
        expect(params.match(missingTailMarker)).toBe(false);
        expect(params.match(missingQuoteChunk)).toBe(false);
        expect(params.match(tailChunk)).toBe(true);
        return tailChunk;
      },
    });
    const context = createContext({
      driver,
      gateway: createGateway({
        workspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      }),
      gatewayWorkspaceDir: "/tmp/openclaw-whatsapp-qa-gateway",
      requestStartedAt: new Date("2026-06-05T01:00:00.000Z"),
      scenarioId: "whatsapp-reply-delivery-shape",
    });

    await run.afterReply(
      observedMessage("initial-reply", {
        observedAt: "2026-06-05T01:00:00.500Z",
        text: token,
      }),
      context,
    );

    expect(waitCallCount).toBe(2);
  });

  it("targets group approval reactions at the approval prompt participant", async () => {
    const scenario = getWhatsAppScenario("whatsapp-approval-exec-group-reaction-native");
    const run = scenario.buildRun();
    if (run.kind !== "approval") {
      throw new Error("expected approval scenario run");
    }
    const sendReaction = vi.fn(async () => ({ messageId: "reaction-1" }));
    let approvalId = "";
    let waitCount = 0;
    const driver = createDriver({
      sendReaction,
      waitForMessage: async ({ match }) => {
        waitCount += 1;
        const isPending = waitCount === 1;
        const message = observedMessage(isPending ? "approval-message-1" : "approval-resolved-1", {
          fromJid: "12345@g.us",
          observedAt: isPending ? "2026-06-28T02:00:00.000Z" : "2026-06-28T02:00:01.000Z",
          participantJid: "999@lid",
          text: isPending
            ? `Exec approval required\nID: ${approvalId}\n` +
              `Pending command:\nprintf '%s\\n' '${run.token}'\n\n` +
              "React with:\n\n👍 Allow Once\n👎 Deny"
            : `✅ Exec approval allow-once. ID: ${approvalId}`,
        });
        if (!match(message)) {
          throw new Error(`approval test message ${waitCount} did not match`);
        }
        return message;
      },
    });
    const gateway = {
      call: async (method: string, payload: { id?: string }) => {
        if (method === "exec.approval.request") {
          approvalId = payload.id ?? "";
          return { id: approvalId, status: "accepted" };
        }
        if (method === "exec.approval.waitDecision") {
          return { decision: "allow-once" };
        }
        throw new Error(`unexpected gateway call ${method}`);
      },
    } as Parameters<typeof runWhatsAppApprovalScenario>[0]["gateway"];

    await runWhatsAppApprovalScenario({
      driver,
      gateway,
      run,
      scenario,
      sutAccountId: "work",
      sutPhoneE164: phones.sutPhoneE164,
      turnSourceTo: "12345@g.us",
    });

    expect(sendReaction).toHaveBeenCalledWith("12345@g.us", "approval-message-1", "👍", {
      fromMe: false,
      participant: "999@lid",
    });
  });

  it("enables WhatsApp native exec and plugin approval delivery for approval scenarios", () => {
    const cfg = buildConfig({ overrides: { approvals: { exec: true, plugin: true } } });

    expect(cfg.approvals?.exec).toEqual({ enabled: true, mode: "session" });
    expect(cfg.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    const account = cfg.channels?.whatsapp?.accounts?.sut;
    expect(account?.allowFrom).toEqual(["+15550000001"]);
    expect(account).not.toHaveProperty("execApprovals");
  });

  it("enables WhatsApp audio preflight with the OpenAI transcription provider", () => {
    const cfg = buildConfig({ overrides: { audioPreflight: true } });

    expect(cfg.plugins?.allow).toContain("whatsapp");
    expect(cfg.tools?.media?.audio).toEqual({ enabled: true });
    expect(cfg.tools?.media?.models?.[0]).toEqual({
      provider: "openai",
      model: "gpt-4o-transcribe",
      capabilities: ["audio"],
    });
  });

  it("enables WhatsApp action discovery for the user-path agent reaction scenario", () => {
    const scenario = getWhatsAppScenario("whatsapp-agent-message-action-react");
    const cfg = buildConfig({ overrides: scenario.configOverrides });

    expect(cfg.channels?.whatsapp).toMatchObject({
      actions: { reactions: true },
      reactionLevel: "minimal",
    });
    expect(cfg.tools?.alsoAllow).toContain("message");
  });

  it("defines the WhatsApp audio preflight scenario as mock-backed audio media", () => {
    const { scenario, run: scenarioRun } = messageScenario("whatsapp-audio-preflight");

    expect(readQaScenarioById(scenario.id).plugins).toEqual(["openai"]);
    expect(scenarioRun.expectReply).toBe(true);
    expect(scenarioRun.matchText).toBe("WHATSAPP_QA_AUDIO_TRANSCRIPT_OK");
    expect(scenarioRun.sendMode).toMatchObject({
      fileName: "whatsapp-qa-audio.ogg",
      kind: "media",
      mediaType: "audio/ogg; codecs=opus",
    });
    expect(scenarioRun.sendMode?.kind === "media" && scenarioRun.sendMode.mediaBuffer.length).toBe(
      1_303,
    );
  });

  it("defines group audio gating as captionless audio driven by mock transcription sentinel", () => {
    const { run: scenarioRun } = messageScenario("whatsapp-group-audio-gating");
    const triggerSentinel = Buffer.from("OPENCLAW_QA_GROUP_AUDIO_TRIGGER", "utf8");

    expect(scenarioRun.input).toBe("");
    expect(scenarioRun.matchText).toBe("WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK");
    expect(scenarioRun.quietInput).toBe("");
    expect(scenarioRun.quietMatchText).toBeUndefined();
    expect(scenarioRun.sendMode).toMatchObject({
      fileName: "whatsapp-qa-group-audio.ogg",
      kind: "media",
      mediaType: "audio/ogg; codecs=opus",
    });
    expect(scenarioRun.quietSendMode).toMatchObject({
      fileName: "whatsapp-qa-group-audio-quiet.ogg",
      kind: "media",
      mediaType: "audio/ogg; codecs=opus",
    });
    expect(
      scenarioRun.sendMode?.kind === "media" &&
        scenarioRun.quietSendMode?.kind === "media" &&
        scenarioRun.quietSendMode.mediaBuffer.length === 1_303 &&
        scenarioRun.sendMode.mediaBuffer.includes(triggerSentinel) &&
        !scenarioRun.quietSendMode.mediaBuffer.includes(triggerSentinel),
    ).toBe(true);
  });

  it("keeps pending-history group context enabled through the supported config path", () => {
    const scenario = getWhatsAppScenario("whatsapp-group-pending-history-context");
    const cfg = buildConfig({
      groupJid,
      overrides: scenario.configOverrides,
    });
    const supportedHistoryLimit =
      cfg.channels?.whatsapp?.historyLimit ?? cfg.messages?.groupChat?.historyLimit;

    expect(supportedHistoryLimit).toEqual(expect.any(Number));
    expect(supportedHistoryLimit).toBeGreaterThan(0);
    expect(cfg.channels?.whatsapp?.accounts?.sut?.replyToMode).toBe("all");
    expect(cfg.messages?.inbound?.byChannel?.whatsapp).toBe(0);
    expect(cfg.channels?.whatsapp?.accounts?.sut?.groups?.[groupJid]?.requireMention).toBe(true);
  });

  it("requires pending-history group replies to expose resolved SUT phone attribution", async () => {
    const { scenario, run } = messageScenario("whatsapp-group-pending-history-context");
    const unresolvedReply = observedMessage("sut-lid-reply", {
      fromJid: groupJid,
      fromPhoneE164: null,
      text: run.matchText.toString(),
    });
    const driver = createDriver({
      getObservedMessages: () => [unresolvedReply],
      waitForMessage: async (params) => {
        expect(params.match(unresolvedReply)).toBe(false);
        throw new Error("timed out waiting for WhatsApp QA driver message");
      },
    });

    await expect(
      waitForScenarioObservedMessage(
        createContext({
          driver,
          gatewayTarget: groupJid,
          scenarioId: scenario.id,
          target: groupJid,
          targetKind: "group",
        }),
        {
          match: (message) => message.text.includes(run.matchText.toString()),
          observedAfter: new Date("2026-06-21T12:00:00.000Z"),
        },
      ),
    ).rejects.toThrow("fromExpectedSut=no");
  });

  it("can configure a group scenario as sender allowlist-blocked instead of open mention-gated", () => {
    const cfg = buildConfig({
      allowFrom: ["+15550000000"],
      groupJid: "120363000000000000@g.us",
      overrides: {
        blockGroupSender: true,
        groupPolicy: "allowlist",
      },
    });

    const account = cfg.channels?.whatsapp?.accounts?.sut;
    expect(account?.groupPolicy).toBe("allowlist");
    expect(account?.groupAllowFrom).toEqual(["+15550000001"]);
    expect(account?.groupAllowFrom).not.toContain("+15550000000");
    expect(account?.groups).toBeUndefined();
  });
  it("uses automatic visible replies for WhatsApp group mention gating", () => {
    const { run: scenarioRun } = messageScenario("whatsapp-mention-gating");
    expect(scenarioRun.input).toContain("openclawqa reply with only this exact marker");
    expect(scenarioRun.input).not.toContain("visible reply tool check");

    const cfg = buildConfig({
      groupJid: "120363000000000000@g.us",
    });
    expect(cfg.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(cfg.messages?.groupChat?.mentionPatterns).toContain("\\bopenclawqa\\b");
  });
  it("classifies WhatsApp driver connection closures as retryable", () => {
    expect(isTransientWhatsAppQaDriverError(new Error("Connection Closed"))).toBe(true);
    expect(isTransientWhatsAppQaDriverError(new Error("status 440: session conflict"))).toBe(true);
    expect(isTransientWhatsAppQaDriverError(new Error("Stream Errored (conflict)"))).toBe(true);
    expect(
      isTransientWhatsAppQaDriverError(
        new Error("timed out after 45000ms waiting for WhatsApp QA driver pending notifications"),
      ),
    ).toBe(true);
    expect(
      isTransientWhatsAppQaDriverError(
        new Error("timed out waiting for WhatsApp QA driver message"),
      ),
    ).toBe(false);
    expect(isTransientWhatsAppQaDriverError(new Error("timed out waiting"))).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
