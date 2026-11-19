import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { ComponentType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { stampAgentControls } from "openclaw/plugin-sdk/interactive-runtime";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import { parseCustomId } from "../internal/components.base.js";
import type {
  BaseComponentInteraction,
  BaseMessageInteractiveComponent,
  ComponentData,
} from "../internal/discord.js";
import { createComponentButtonInteraction } from "../test-support/component-interactions.test-support.js";
import {
  dispatchPluginInteractiveHandlerMock,
  dispatchReplyMock,
  readSessionUpdatedAtMock,
  recordInboundSessionMock,
  resetDiscordComponentRuntimeMocks,
  resolveStorePathMock,
} from "../test-support/component-runtime.js";

type Controls = typeof import("./agent-components.js");
let controls: Controls;
let buildDiscordComponentMessage: typeof import("../components.js").buildDiscordComponentMessage;
let buildDiscordPresentationComponents: typeof import("../shared-interactive.js").buildDiscordPresentationComponents;
let lastBody: unknown;

const context = (allowFrom = ["123456789"]) =>
  ({
    cfg: { channels: { discord: {} } } satisfies OpenClawConfig,
    accountId: "default",
    dmPolicy: "allowlist",
    allowFrom,
    discordConfig: {},
    token: "token",
  }) as Parameters<Controls["createAgentComponentControls"][number]>[0];

beforeAll(async () => {
  controls = await import("./agent-components.js");
  ({ buildDiscordComponentMessage } = await import("../components.js"));
  ({ buildDiscordPresentationComponents } = await import("../shared-interactive.js"));
});

beforeEach(() => {
  clearDiscordComponentEntriesForTest();
  resetDiscordComponentRuntimeMocks();
  lastBody = undefined;
  dispatchReplyMock.mockClear().mockImplementation(async (params) => {
    lastBody = params.ctx.BodyForAgent;
    return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
  });
  recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
  readSessionUpdatedAtMock.mockClear().mockReturnValue(undefined);
  resolveStorePathMock.mockClear().mockReturnValue("/tmp/openclaw-sessions-test.json");
  dispatchPluginInteractiveHandlerMock.mockReset().mockResolvedValue({
    matched: false,
    handled: false,
    duplicate: false,
  });
});

/** Renders one core-marked presentation the way a message action sends it. */
function sendMarked(blocks: Record<string, unknown>[]) {
  const { presentation } = stampAgentControls({ presentation: { blocks } });
  const spec = buildDiscordPresentationComponents(
    presentation as Parameters<typeof buildDiscordPresentationComponents>[0],
  );
  if (!spec) {
    throw new Error("expected Discord components");
  }
  const message = buildDiscordComponentMessage({ spec, sessionKey: "sender-session" });
  return message.components.map((component) => component.serialize()) as Array<{
    type: number;
    components?: Array<{ type: number; components?: Array<{ custom_id?: string }> }>;
  }>;
}

const controlIds = (components: ReturnType<typeof sendMarked>) =>
  components.flatMap((top) =>
    (top.components ?? []).flatMap((row) =>
      (row.components ?? []).flatMap((control) => (control.custom_id ? [control.custom_id] : [])),
    ),
  );

/** Routes a tap to the registered control the way the Discord client resolves it. */
async function tap(params: {
  components: ReturnType<typeof sendMarked>;
  customId: string;
  type: ComponentType;
  values?: string[];
  allowFrom?: string[];
}) {
  const ctx = context(params.allowFrom);
  const registered: BaseMessageInteractiveComponent[] = [
    ...controls.createAgentComponentControls.map((create) => create(ctx)),
    ...controls.createDiscordComponentControls.map((create) => create(ctx)),
  ];
  const key = (control: BaseMessageInteractiveComponent, id: string) =>
    (control.customIdParser ?? parseCustomId)(id).key;
  const control =
    registered.find(
      (entry) =>
        entry.type === params.type && key(entry, entry.customId) === key(entry, params.customId),
    ) ??
    registered.find((entry) => entry.type === params.type && key(entry, entry.customId) === "*");
  const update = vi.fn().mockResolvedValue(undefined);
  const fixture = createComponentButtonInteraction({
    rawData: {
      channel_id: "dm-channel",
      id: "interaction-1",
      data: { custom_id: params.customId },
      message: { id: "msg-1", components: params.components },
    } as unknown as BaseComponentInteraction["rawData"],
    values: params.values ?? [],
    update,
    acknowledge: vi.fn().mockResolvedValue(undefined),
  } as unknown as Partial<BaseComponentInteraction>);
  await control?.run(fixture.interaction, parseCustomId(params.customId).data as ComponentData);
  return { ...fixture, update };
}

it.each([
  ["typed callback", { label: "Pick", action: { type: "callback", value: "pick:a" } }, "pick:a"],
  ["legacy value", { label: "Pick", value: "/pick a" }, "/pick a"],
])("delivers a %s button after the component registry is gone", async (_name, button, value) => {
  const components = sendMarked([{ type: "buttons", buttons: [button] }]);
  const [customId] = controlIds(components);
  clearDiscordComponentEntriesForTest();

  const { reply, update } = await tap({
    components,
    customId: customId!,
    type: ComponentType.Button,
  });

  expect(reply).not.toHaveBeenCalled();
  expect(lastBody).toBe(`callback_data: ${value}`);
  // Single use: the tap consumes the controls and keeps the rest of the message.
  expect(update).toHaveBeenCalledExactlyOnceWith({
    components: [expect.objectContaining({ type: ComponentType.Container, components: [] })],
  });
  expect(dispatchPluginInteractiveHandlerMock.mock.calls[0]?.[0]).toMatchObject({
    data: `::${value}`,
  });
});

it("delivers an agent select choice after the component registry is gone", async () => {
  const components = sendMarked([
    { type: "select", placeholder: "Size", options: [{ label: "M", value: "size:m" }] },
  ]);
  const [customId] = controlIds(components);
  clearDiscordComponentEntriesForTest();

  await tap({
    components,
    customId: customId!,
    type: ComponentType.StringSelect,
    values: ["::size:m"],
  });

  expect(lastBody).toBe("callback_data: size:m");
});

it("consumes only the agent's controls and keeps reusable ones", async () => {
  const components = sendMarked([
    {
      type: "buttons",
      buttons: [
        { label: "Pick", value: "pick" },
        { label: "Docs", action: { type: "url", url: "https://example.com/docs" } },
        { label: "Refresh", value: "refresh", reusable: true },
      ],
    },
  ]);
  const [pickId, refreshId] = controlIds(components);

  const pick = await tap({ components, customId: pickId!, type: ComponentType.Button });
  expect(pick.update).toHaveBeenCalledExactlyOnceWith({
    components: [
      expect.objectContaining({
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              expect.objectContaining({ label: "Docs", url: "https://example.com/docs" }),
            ],
          },
        ],
      }),
    ],
  });

  const refresh = await tap({ components, customId: refreshId!, type: ComponentType.Button });
  expect(refresh.update).not.toHaveBeenCalled();
  expect(lastBody).toBe("callback_data: refresh");
});

it("keeps duplicate agent values distinct in one message", () => {
  const components = sendMarked([
    {
      type: "buttons",
      buttons: [
        { label: "A", value: "same" },
        { label: "B", value: "same" },
      ],
    },
    { type: "select", placeholder: "One", options: [{ label: "X", value: "x" }] },
    { type: "select", placeholder: "Two", options: [{ label: "X", value: "x" }] },
  ]);
  const ids = controlIds(components);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
});

it("rejects an agent control tapped by a sender outside the allowlist", async () => {
  const components = sendMarked([{ type: "buttons", buttons: [{ label: "A", value: "a" }] }]);
  const [customId] = controlIds(components);

  const { reply, update } = await tap({
    components,
    customId: customId!,
    type: ComponentType.Button,
    allowFrom: ["999"],
  });

  expect(reply).toHaveBeenCalledWith({
    content: "You are not authorized to use this button.",
    ephemeral: true,
  });
  expect(update).not.toHaveBeenCalled();
  expect(dispatchReplyMock).not.toHaveBeenCalled();
});
