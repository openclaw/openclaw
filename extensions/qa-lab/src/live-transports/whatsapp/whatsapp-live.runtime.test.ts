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
import { buildWhatsAppQaConfig, parseWhatsAppQaCredentialPayload } from "./whatsapp-live.config.js";
import {
  resolveWhatsAppQaMessageTargets,
  type WhatsAppQaScenarioImplementation,
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

type Scenario = WhatsAppQaScenarioImplementation & { id: string; timeoutMs: number };
type MessageRun = Exclude<WhatsAppQaScenarioRun, { kind: "approval" }>;
type Context = Parameters<NonNullable<MessageRun["afterSend"]>>[0];
type Hook = "afterReply" | "afterSend" | "verify";

const workspaceDir = "/tmp/openclaw-whatsapp-qa";
function createGateway(overrides: Partial<Context["gateway"]> = {}): Context["gateway"] {
  return { call: async () => ({}), restart: async () => {}, workspaceDir, ...overrides };
}
function createContext({
  scenario,
  ...overrides
}: Partial<Context> & { scenario?: Scenario } = {}): Context {
  return {
    driver: createDriver(),
    ...phones,
    gateway: createGateway({
      call: async () => {
        throw new Error("Unexpected Gateway call");
      },
    }),
    gatewayTarget: phones.driverPhoneE164,
    gatewayWorkspaceDir: workspaceDir,
    requestStartedAt: new Date("2026-06-21T12:00:00.000Z"),
    scenarioId: scenario?.id ?? "whatsapp-canary",
    sent: { messageId: "driver-message-1" },
    sutAccountId: "sut",
    target: phones.sutPhoneE164,
    targetKind: "dm",
    ...overrides,
  };
}
function buildConfig(
  options: Partial<Parameters<typeof buildWhatsAppQaConfig>[1]> = {},
  base: Parameters<typeof buildWhatsAppQaConfig>[0] = {},
) {
  return buildWhatsAppQaConfig(base, {
    allowFrom: [phones.driverPhoneE164],
    authDir: "/tmp/openclaw-whatsapp-qa-auth",
    dmPolicy: "allowlist",
    ownerAllowFrom: [phones.driverPhoneE164],
    sutAccountId: "sut",
    ...options,
  });
}
function getWhatsAppScenario(id: string): Scenario {
  const flow = requireFlowScenario(readQaScenarioById(id));
  const name = flow.execution.config?.whatsappScenario;
  const implementation =
    typeof name === "string" ? whatsappScenarioImplementations[name] : undefined;
  if (!implementation) {
    throw new Error(`Missing WhatsApp implementation for ${id}`);
  }
  return { ...implementation, id, timeoutMs: flow.execution.timeoutMs ?? 60_000 };
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

  it("runs group media, audio and poll probes against the group target", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const shapes: Partial<WhatsAppQaDriverObservedMessage>[] = [
      { kind: "media", hasMedia: true, mediaType: "image/png" },
      {
        kind: "media",
        hasMedia: true,
        mediaType: "application/pdf",
        mediaFileName: "whatsapp-qa-group.pdf",
      },
      { kind: "media", hasMedia: true, mediaType: "audio/ogg; codecs=opus" },
      {},
      { kind: "poll", poll: { options: ["alpha", "beta"] } },
    ];
    const messages = shapes.map((shape, index) =>
      observedMessage("group-" + index, {
        fromJid: groupJid,
        text: "",
        observedAt: `2026-06-21T12:00:0${index + 2}.000Z`,
        ...shape,
      }),
    );
    const context = createContext({
      target: groupJid,
      gatewayTarget: groupJid,
      targetKind: "group",
      driver: createDriver({
        waitForMessage: async ({ match }) =>
          expectDefined(messages.find(match), "matching group observation"),
      }),
      gateway: createGateway({
        call: async (method, payload) => {
          const data = payload as Record<string, unknown>;
          calls.push({ method, payload: data });
          const { message, question } = data;
          if (typeof question === "string" && question) {
            updateObservedMessage(messages, 4, { poll: { options: ["alpha", "beta"], question } });
          }
          if (typeof message === "string") {
            if (message.endsWith("_IMAGE")) {
              updateObservedMessage(messages, 0, { text: message });
            }
            if (message.endsWith("_DOCUMENT")) {
              updateObservedMessage(messages, 1, { text: message });
            }
            if (message.endsWith("_AUDIO")) {
              updateObservedMessage(messages, 2, {});
              updateObservedMessage(messages, 3, { text: message });
            }
          }
          return {};
        },
      }),
    });
    for (const kind of ["media", "audio", "poll"]) {
      const { scenario, run } = messageScenario(`whatsapp-group-outbound-${kind}`, ["afterReply"]);
      await run.afterReply(
        observedMessage(kind, { fromJid: groupJid, text: String(run.matchText) }),
        { ...context, scenarioId: scenario.id },
      );
    }
    expect(calls.map(({ method }) => method)).toEqual(["send", "send", "send", "poll"]);
    expect(calls.every(({ payload }) => payload.to === groupJid)).toBe(true);
  });

  it("isolates quoted and fresh Gateway sends", async () => {
    const { scenario, run } = messageScenario("whatsapp-reply-context-isolation", ["afterReply"]);
    const calls: Record<string, unknown>[] = [];
    let waits = 0;
    const context = createContext({
      scenario,
      gateway: createGateway({
        call: async (_method, payload) => {
          calls.push(payload as Record<string, unknown>);
          return {};
        },
      }),
      driver: createDriver({
        waitForMessage: async ({ match }) => {
          const base = observedMessage(`reply-${++waits}`, {
            observedAt: new Date().toISOString(),
            text: String(calls[waits - 1]?.message),
          });
          if (waits === 1) {
            expect(match(base)).toBe(false);
            expect(match({ ...base, quoted: { messageId: "wrong-trigger" } })).toBe(false);
            const quoted = { ...base, quoted: { messageId: "driver-message-1" } };
            expect(match(quoted)).toBe(true);
            return quoted;
          }
          expect(match({ ...base, text: "wrong fresh marker" })).toBe(false);
          expect(match(base)).toBe(true);
          return base;
        },
      }),
    });
    await run.afterReply(observedMessage("initial", { text: String(run.matchText) }), context);
    expect(calls.map((call) => call.replyToId)).toEqual(["driver-message-1", undefined]);
    expect(waits).toBe(2);
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
        const cfg = applyQaSuiteGatewayConfigPatches(initialConfig, patches) as Parameters<
          typeof buildWhatsAppQaConfig
        >[0];
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
    "restores mention gating after activation (failure=%s)",
    async (failProbe) => {
      const { scenario, run } = messageScenario("whatsapp-group-activation-always", ["afterReply"]);
      expect(run).toMatchObject({ target: "group", input: "/activation always" });
      const sent: Array<{ to: string; text: string }> = [];
      const alwaysMarker = /\bWHATSAPP_QA_ACTIVATION_ALWAYS_[A-Z0-9]+\b/u;
      const quietMarker = /\bWHATSAPP_QA_ACTIVATION_QUIET_[A-Z0-9]+\b/u;
      const restoreIndex = () =>
        sent.findIndex(({ to, text }) => to === groupJid && text.trim() === "/activation mention");
      let alwaysMatched = false;
      let quietReads = 0;
      const driver = createDriver({
        sendText: async (to, text) => {
          sent.push({ to, text });
          return { messageId: "driver-message-" + sent.length };
        },
        getObservedMessages: () => {
          if (sent.some(({ text }) => quietMarker.test(text))) {
            quietReads++;
          }
          return [];
        },
        waitForMessage: async ({ match }) => {
          const restoring = restoreIndex() >= 0;
          if (failProbe && !restoring) {
            throw new Error("forced always-mode probe failure");
          }
          const probe = sent.findLast(
            ({ text }) => alwaysMarker.test(text) && !/\bopenclawqa\b/iu.test(text),
          );
          const reply = observedMessage(restoring ? "restore" : "always", {
            fromJid: groupJid,
            observedAt: new Date().toISOString(),
            text: restoring
              ? "Activation: mention"
              : expectDefined(probe, "unmentioned always probe").text,
          });
          if (!restoring) {
            expect(
              match({
                ...reply,
                text: reply.text.replace(alwaysMarker, "WHATSAPP_QA_ACTIVATION_ALWAYS_WRONG"),
              }),
            ).toBe(false);
          }
          expect(match(reply)).toBe(true);
          if (!restoring) {
            alwaysMatched = true;
          }
          return reply;
        },
      });
      vi.useFakeTimers({ now: new Date("2026-06-21T12:00:02.000Z") });
      try {
        const result = run.afterReply(
          observedMessage("activation", {
            fromJid: groupJid,
            text: "Activation: always",
          }),
          createContext({
            driver,
            scenario,
            gatewayTarget: groupJid,
            target: groupJid,
            sent: { messageId: "activation-command-message" },
          }),
        );
        const outcome = failProbe
          ? expect(result).rejects.toThrow("forced always-mode probe failure")
          : result;
        await vi.runAllTimersAsync();
        await outcome;
      } finally {
        vi.useRealTimers();
      }
      expect(restoreIndex()).toBeGreaterThanOrEqual(0);
      if (!failProbe) {
        for (const probe of [
          sent.find(({ text }) => alwaysMarker.test(text)),
          sent.slice(restoreIndex() + 1).find(({ text }) => quietMarker.test(text)),
        ]) {
          expect(probe?.to).toBe(groupJid);
          expect(probe?.text).not.toMatch(/\bopenclawqa\b/i);
        }
        expect(alwaysMatched).toBe(true);
        expect(quietReads).toBeGreaterThan(0);
      }
    },
  );

  it("quotes the SUT reply without mentioning it for reply-to-bot activation", async () => {
    const { scenario, run } = messageScenario("whatsapp-group-reply-to-bot-triggers", [
      "afterReply",
    ]);
    expect(run.target).toBe("group");
    expect(run.input).toMatch(/\bopenclawqa\b/iu);
    expect(run.input).toMatch(/\bWHATSAPP_QA_REPLY_TO_BOT_SEED_[A-Z0-9]+\b/u);
    const participantJid = "15550000002@s.whatsapp.net";
    const sends: Array<{
      to: string;
      text: string;
      options: Parameters<WhatsAppQaDriverSession["sendText"]>[2];
    }> = [];
    let matched = false;
    const driver = createDriver({
      sendText: async (to, text, options) => {
        sends.push({ to, text, options });
        return { messageId: `driver-quoted-${sends.length}` };
      },
      waitForMessage: async ({ match }) => {
        const trigger = sends.find(({ options }) => options?.quotedMessageKey);
        const marker = expectDefined(
          /\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u.exec(trigger?.text ?? "")?.[0],
          "quoted trigger marker",
        );
        const candidate = observedMessage("final", {
          fromJid: groupJid,
          observedAt: new Date().toISOString(),
          text: marker,
        });
        expect(match({ ...candidate, text: "WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_WRONG" })).toBe(false);
        expect(match(candidate)).toBe(false);
        const quoted = { ...candidate, quoted: { messageId: "driver-quoted-1" } };
        expect(match(quoted)).toBe(true);
        matched = true;
        return quoted;
      },
    });
    const seed = observedMessage("sut-seed-reply", {
      fromJid: groupJid,
      participantJid,
      text: "WHATSAPP_QA_REPLY_TO_BOT_SEED_TEST",
    });
    await run.afterReply(
      seed,
      createContext({
        driver,
        scenario,
        target: groupJid,
        gatewayTarget: groupJid,
        sent: { messageId: "driver-seed-message" },
      }),
    );
    const quoted = expectDefined(
      sends.find(({ options }) => options?.quotedMessageKey),
      "quoted send",
    );
    expect(quoted.to).toBe(groupJid);
    expect(quoted.text).toMatch(/\bWHATSAPP_QA_REPLY_TO_BOT_TRIGGER_[A-Z0-9]+\b/u);
    expect(quoted.text).not.toMatch(/\bopenclawqa\b|@\d/iu);
    expect(quoted.options?.quotedMessageKey).toMatchObject({
      fromMe: false,
      id: "sut-seed-reply",
      messageText: seed.text,
      participant: participantJid,
      remoteJid: groupJid,
    });
    expect(matched).toBe(true);
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

  it("requires the second delivery chunk's tail marker and quote", async () => {
    const { run } = messageScenario("whatsapp-reply-delivery-shape", ["afterReply"]);
    const token = String(run.matchText);
    const chunk = (id: string, text: string, quoted = true) =>
      observedMessage(id, {
        observedAt: new Date().toISOString(),
        text,
        ...(quoted ? { quoted: { messageId: "driver-message-1" } } : {}),
      });
    let waits = 0;
    const driver = createDriver({
      waitForMessage: async ({ match }) => {
        if (++waits === 1) {
          const first = chunk("chunk-1", `${token}_LONG_BEGIN`);
          expect(match(first)).toBe(true);
          return first;
        }
        expect(match(chunk("chunk-2", "second chunk without the tail marker"))).toBe(false);
        expect(match(chunk("chunk-3", `${token}_LONG_END`, false))).toBe(false);
        const tail = chunk("chunk-4", `${token}_LONG_END`);
        expect(match(tail)).toBe(true);
        return tail;
      },
    });
    await run.afterReply(
      observedMessage("initial", {
        observedAt: "2026-06-05T01:00:00.500Z",
        text: token,
      }),
      createContext({
        driver,
        gateway: createGateway(),
        requestStartedAt: new Date("2026-06-05T01:00:00.000Z"),
        scenarioId: "whatsapp-reply-delivery-shape",
      }),
    );
    expect(waits).toBe(2);
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
