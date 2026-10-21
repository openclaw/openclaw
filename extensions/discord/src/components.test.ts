import assert from "node:assert/strict";
import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  type APIContainerComponent,
} from "discord-api-types/v10";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  registerDiscordComponentEntries,
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "./components-registry.js";
import { clearDiscordComponentEntriesForTest } from "./components-registry.test-support.js";
import {
  buildDiscordComponentCustomId,
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  buildDiscordModalCustomId,
  parseDiscordComponentCustomId,
  parseDiscordComponentCustomIdForInteraction,
  parseDiscordModalCustomId,
  parseDiscordModalCustomIdForInteraction,
  readDiscordComponentSpec,
  coerceDiscordComponentParam,
  createDiscordFormModal,
  type DiscordComponentEntry,
  type DiscordModalEntry,
} from "./components.js";
import type { DiscordComponentBlock, DiscordComponentSelectSpec } from "./components.types.js";
import { RoleSelectMenu, StringSelectMenu, UserSelectMenu } from "./internal/components.message.js";
import { BaseComponentInteraction, createInteraction } from "./internal/interactions.js";
import {
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "./internal/test-builders.test-support.js";
import { setDiscordRuntime } from "./runtime.js";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

type DiscordRuntime = Parameters<typeof import("./runtime.js").setDiscordRuntime>[0];

const { clearRuntime: clearDiscordRuntime } = createPluginRuntimeStore<DiscordRuntime>({
  pluginId: "discord",
  errorMessage: "Discord runtime not initialized",
});

function requireSpec(raw: Parameters<typeof readDiscordComponentSpec>[0]) {
  const spec = readDiscordComponentSpec(raw);
  assert(spec, "Expected component spec to be parsed");
  return spec;
}

const modalSpec = (field: Record<string, unknown>) => ({
  modal: { title: "Details", fields: [field] },
});
const selectSpec = (limits: Record<string, number>) => ({
  blocks: [
    {
      type: "actions",
      select: { type: "string", ...limits, options: [{ label: "One", value: "one" }] },
    },
  ],
});
function expectInvalidModal(field: Record<string, unknown>, property: string) {
  expect(() => readDiscordComponentSpec(modalSpec(field))).toThrow(
    `components.modal.fields[0].${property}`,
  );
}
const linkAccessory = {
  type: "button",
  button: {
    label: " Read ",
    style: "link",
    url: "https://example.com",
    emoji: { id: "123456789012345678", name: "guide", animated: true },
  },
};
const textComponent = (content: string) => ({ type: 10, content });
const actionSpec = (buttons: Record<string, unknown>[]) => ({
  blocks: [{ type: "actions", buttons }],
});
const textField = { id: "fld_1", name: "name", label: "Name", type: "text" as const };
const buttonEntry = (id: string, label: string): DiscordComponentEntry => ({
  id,
  kind: "button",
  label,
});
const makeModal = (id: string, fields: DiscordModalEntry["fields"] = []): DiscordModalEntry => ({
  id,
  title: "Details",
  fields,
});
const sectionSpec = (text: string | string[]) => ({
  type: "section",
  ...(typeof text === "string" ? { text } : { texts: text }),
  accessory: linkAccessory,
});
const sectionComponent = (...texts: string[]) => ({
  type: 9,
  components: texts.map(textComponent),
  accessory: {
    label: "Read",
    emoji: { id: "123456789012345678", name: "guide", animated: true },
  },
});
const lookupComponent = (id: string) =>
  resolveDiscordComponentEntryWithPersistence({ id, consume: false });
const lookupModal = (id: string) => resolveDiscordModalEntryWithPersistence({ id, consume: false });
function withUndefined<T, U extends Record<string, undefined>>(value: T, fields: U) {
  return Object.assign({}, value, fields);
}
function expectAbsent(value: unknown, ...keys: string[]) {
  for (const key of keys) {
    expect(value).not.toHaveProperty(key);
  }
}

describe("discord components", () => {
  it("round-trips custom id values that contain separators", () => {
    const componentId = "button=a;two space%3B";
    const modalId = "modal=x;y space%3D";

    const componentCustomId = buildDiscordComponentCustomId({ componentId, modalId });
    expect(componentCustomId).not.toContain(componentId);
    expect(componentCustomId).toContain("space");
    expect(parseDiscordComponentCustomId(componentCustomId)).toEqual({ componentId, modalId });
    expect(parseDiscordComponentCustomIdForInteraction(componentCustomId).data).toMatchObject({
      cid: componentId,
      mid: modalId,
    });

    const modalCustomId = buildDiscordModalCustomId(modalId);
    expect(modalCustomId).not.toContain(modalId);
    expect(modalCustomId).toContain("space");
    expect(parseDiscordModalCustomId(modalCustomId)).toBe(modalId);
    expect(parseDiscordModalCustomIdForInteraction(modalCustomId).data).toMatchObject({
      mid: modalId,
    });
  });

  it.each([
    { label: "minimum", accentColor: 0, expected: 0 },
    { label: "negative", accentColor: -1, expected: undefined },
    { label: "fractional", accentColor: 1.5, expected: undefined },
    { label: "above maximum", accentColor: 0x1000000, expected: undefined },
  ])("serializes $label numeric container accent colors safely", ({ accentColor, expected }) => {
    const spec = requireSpec({
      text: "Status",
      container: { accentColor },
    });
    const serialized = buildDiscordComponentMessage({ spec }).components[0]?.serialize() as
      | { accent_color?: unknown }
      | undefined;

    if (expected === undefined) {
      expect(serialized).not.toHaveProperty("accent_color");
    } else {
      expect(serialized?.accent_color).toBe(expected);
    }
  });

  it("serializes disabled link buttons", () => {
    const linkButton = {
      label: "Open docs",
      style: "link",
      url: "https://example.com/docs",
      disabled: true,
      emoji: { name: "📖" },
    };
    const spec = requireSpec(actionSpec([linkButton]));
    const result = buildDiscordComponentMessage({ spec });
    const serialized = result.components[0]?.serialize() as
      | { components?: Array<{ components?: Array<Record<string, unknown>> }> }
      | undefined;
    const button = serialized?.components?.[0]?.components?.[0];

    expect(button).toMatchObject({
      ...linkButton,
      style: ButtonStyle.Link,
    });
    expect(result.entries).toHaveLength(0);
  });

  it("requires options for modal select fields", () => {
    expect(() =>
      readDiscordComponentSpec(modalSpec({ type: "select", label: "Priority" })),
    ).toThrow("options");
  });

  it("rejects malformed component count and length limits", () => {
    const invalid = (raw: Parameters<typeof readDiscordComponentSpec>[0], error: string) =>
      expect(() => readDiscordComponentSpec(raw)).toThrow(error);
    const options = [{ label: "One", value: "one" }];
    invalid(selectSpec({ minValues: -1 }), "components.blocks[0].select.minValues");
    expectInvalidModal({ type: "text", label: "Name", maxLength: 0 }, "maxLength");
    expectInvalidModal({ type: "select", label: "Priority", minValues: 0, options }, "minValues");
    expectInvalidModal({ type: "checkbox", label: "Choices", maxValues: 25, options }, "maxValues");
    invalid(selectSpec({ maxValues: 0 }), "components.blocks[0].select.maxValues");
    expectInvalidModal(
      { type: "radio", label: "Choice", minValues: 1, options },
      "minValues/maxValues",
    );
  });

  it.each([
    ["top-level text", { text: "    body  " }, textComponent("    body  ")],
    ["text block", { blocks: [{ type: "text", text: "    body  " }] }, textComponent("    body  ")],
    ["section text", { blocks: [sectionSpec("    body  ")] }, sectionComponent("    body  ")],
    [
      "section texts",
      { blocks: [sectionSpec(["    first  ", "    second  "])] },
      sectionComponent("    first  ", "    second  "),
    ],
  ])("preserves %s whitespace through parsing and serialization", (_label, raw, expected) => {
    const spec = requireSpec(raw);
    expect(buildDiscordComponentMessage({ spec }).components[0]?.serialize()).toMatchObject({
      type: 17,
      components: [expected],
    });
  });

  it.each([
    [" \n\t ", "cannot be empty"],
    [1, "must be a string"],
  ])("retains required component body validation: %s", (text, error) => {
    expect(() => readDiscordComponentSpec({ blocks: [{ type: "text", text }] })).toThrow(
      `components.blocks[0].text ${error}`,
    );
  });

  it("parses stringified component specs from MCP object transports", () => {
    const raw = JSON.stringify({ blocks: [{ type: "text", text: "Choose" }] });

    expect(readDiscordComponentSpec(coerceDiscordComponentParam(raw))).toMatchObject({
      blocks: [{ type: "text", text: "Choose" }],
    });
    expect(coerceDiscordComponentParam("not json")).toBe("not json");
  });

  it("requires attachment references for file blocks", () => {
    expect(() =>
      readDiscordComponentSpec({
        blocks: [{ type: "file", file: "https://example.com/report.pdf" }],
      }),
    ).toThrow("attachment://");
    expect(() =>
      readDiscordComponentSpec({
        blocks: [{ type: "file", file: "attachment://" }],
      }),
    ).toThrow("filename");
  });
});

describe("discord component registry", () => {
  beforeEach(() => {
    // The runtime slot is global across Vitest files; discard sibling mocks
    // before this suite opens its persistent registry stores.
    clearDiscordRuntime();
    clearDiscordComponentEntriesForTest();
    vi.restoreAllMocks();
  });

  afterEach(clearDiscordRuntime);

  const componentsRegistryStateModuleUrl = new URL(
    "./components-registry-state.ts",
    import.meta.url,
  ).href;

  it("registers and consumes component entries", async () => {
    await registerDiscordComponentEntries({
      entries: [buttonEntry("btn_1", "Confirm")],
      modals: [makeModal("mdl_1", [textField])],
      messageId: "msg_1",
      ttlMs: 1000,
    });

    expect(await lookupComponent("btn_1")).toMatchObject({ messageId: "msg_1" });
    expect(await lookupModal("mdl_1")).toMatchObject({ messageId: "msg_1" });
    expect(await resolveDiscordComponentEntryWithPersistence({ id: "btn_1" })).toMatchObject({
      id: "btn_1",
    });
    await expect(resolveDiscordComponentEntryWithPersistence({ id: "btn_1" })).resolves.toBeNull();
  });

  it.each([
    ["row", true, false, true],
    ["row", false, true, false],
    ["row", undefined, true, true],
    ["section", false, true, false],
  ] as const)(
    "preserves %s button reuse=%s over card reuse=%s through delivery (expected %s)",
    async (placement, buttonReusable, cardReusable, expectedReusable) => {
      const { sendDiscordComponentMessage } = await import("./send.components.js");
      const button = {
        label: "Refresh",
        callbackData: "refresh",
        ...(buttonReusable === undefined ? {} : { reusable: buttonReusable }),
      };
      const spec = requireSpec({
        reusable: cardReusable,
        blocks: [
          placement === "row"
            ? { type: "actions", buttons: [button] }
            : { type: "section", text: "Actions", accessory: { type: "button", button } },
        ],
      });
      const { rest, requests, close } = await createDiscordLoopbackRest();
      onTestFinished(close);

      const delivery = await sendDiscordComponentMessage("channel:789", spec, {
        cfg: { channels: { discord: { token: "fixture-token" } } },
        rest,
        token: "fixture-token",
      });
      expect(delivery.messageId).toBe("loopback-message");
      const sent = requests.find((request) => request.method === "POST");
      expect(sent?.path).toBe("/v10/channels/789/messages");
      expect(sent?.body).not.toContain("reusable");

      const sentBody: {
        components?: Array<{
          components?: Array<{
            components?: Array<{ custom_id?: string }>;
            accessory?: { custom_id?: string };
          }>;
        }>;
      } = JSON.parse(sent?.body ?? "{}");
      const block = sentBody.components?.[0]?.components?.[0];
      const customId = block?.components?.[0]?.custom_id ?? block?.accessory?.custom_id;
      assert(customId, "Expected a delivered Discord button custom id");
      const componentId = parseDiscordComponentCustomId(customId)?.componentId;
      assert(componentId, "Expected a registered Discord component id");

      const registered = await lookupComponent(componentId);
      expect(registered).toMatchObject({ reusable: expectedReusable, callbackData: "refresh" });
      const firstInteraction = await resolveDiscordComponentEntryWithPersistence({
        id: componentId,
        consume: !registered?.reusable,
      });
      expect(firstInteraction?.id).toBe(componentId);
      const secondInteraction = await lookupComponent(componentId);
      expect(Boolean(secondInteraction)).toBe(expectedReusable);
    },
  );

  it("shares persistent registry state across duplicate state modules", async () => {
    const first = (await import(
      `${componentsRegistryStateModuleUrl}?t=first-${Date.now()}`
    )) as typeof import("./components-registry-state.js");
    const second = (await import(
      `${componentsRegistryStateModuleUrl}?t=second-${Date.now()}`
    )) as typeof import("./components-registry-state.js");

    first.discordComponentRegistryState.persistentRegistryDisabled = true;

    expect(second.discordComponentRegistryState).toBe(first.discordComponentRegistryState);
    expect(second.discordComponentRegistryState.persistentRegistryDisabled).toBe(true);
    clearDiscordComponentEntriesForTest();
  });

  it("expires component entries registered while the process clock is invalid", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      await registerDiscordComponentEntries({
        entries: [buttonEntry("btn_invalid_clock", "Invalid clock")],
        modals: [],
        ttlMs: 1000,
      });

      await expect(lookupComponent("btn_invalid_clock")).resolves.toBeNull();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  function createPersistentRegistryStore() {
    return {
      register: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn(),
      consume: vi.fn(),
      delete: vi.fn(),
    };
  }

  function installPersistentRegistryStores() {
    const componentStore = createPersistentRegistryStore();
    const modalStore = createPersistentRegistryStore();
    const openKeyedStore = vi.fn((opts: { namespace: string }) =>
      opts.namespace === "discord.components" ? componentStore : modalStore,
    );
    setDiscordRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);
    return { componentStore, modalStore, openKeyedStore };
  }

  it("persists component and modal entries when runtime state is available", async () => {
    const { componentStore, modalStore, openKeyedStore } = installPersistentRegistryStores();
    const { register: componentRegister, lookup: componentLookup } = componentStore;
    const { register: modalRegister, lookup: modalLookup } = modalStore;
    const persistedButton = buttonEntry("btn_persisted", "Persisted");
    const persistedModal = { id: "mdl_persisted", title: "Persisted", fields: [] };
    componentLookup.mockResolvedValue({ version: 1, entry: persistedButton });
    modalLookup.mockResolvedValue({ version: 1, entry: persistedModal });
    const button = buttonEntry("btn_1", "Confirm");
    const modal = makeModal("mdl_1");

    const now = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await registerDiscordComponentEntries({
        entries: [button],
        modals: [modal],
        ttlMs: 1000,
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(componentRegister).toHaveBeenCalledTimes(1);
    const expectRegistration = (
      register: typeof componentRegister,
      entry: DiscordComponentEntry | DiscordModalEntry,
    ) =>
      expect(register).toHaveBeenCalledWith(
        entry.id,
        {
          version: 1,
          entry: { ...entry, createdAt: now, expiresAt: now + 1000 },
        },
        { ttlMs: 1000 },
      );
    expectRegistration(componentRegister, button);
    expectRegistration(modalRegister, modal);

    clearDiscordComponentEntriesForTest();
    await expect(lookupComponent("btn_persisted")).resolves.toStrictEqual(persistedButton);
    await expect(lookupModal("mdl_persisted")).resolves.toStrictEqual(persistedModal);
    expect(componentLookup).toHaveBeenCalledWith("btn_persisted");
    expect(modalLookup).toHaveBeenCalledWith("mdl_persisted");
    expect(openKeyedStore).toHaveBeenCalledTimes(4);
  });

  it("omits undefined component fields before persisting registry state", async () => {
    const { componentStore, modalStore } = installPersistentRegistryStores();
    const componentRegister = componentStore.register;
    const modalRegister = modalStore.register;

    const componentEntry = withUndefined(
      { ...buttonEntry("btn_undefined", "Approve"), callbackData: "approve" },
      { modalId: undefined, sessionKey: undefined },
    );
    const field = withUndefined(textField, { description: undefined, placeholder: undefined });
    const modalEntry = withUndefined(makeModal("mdl_undefined", [field]), {
      sessionKey: undefined,
    });

    await registerDiscordComponentEntries({
      entries: [componentEntry],
      modals: [modalEntry],
      ttlMs: 1000,
    });

    expect(componentRegister).toHaveBeenCalledTimes(1);
    expect(modalRegister).toHaveBeenCalledTimes(1);

    const persistedComponent = componentRegister.mock.calls[0]?.[1] as
      | { entry: Record<string, unknown> }
      | undefined;
    expect(persistedComponent?.entry.callbackData).toBe("approve");
    expectAbsent(persistedComponent?.entry, "modalId", "sessionKey", "messageId");

    const modalPayload = modalRegister.mock.calls[0]?.[1] as
      | { entry: { fields?: Array<Record<string, unknown>> } }
      | undefined;
    expectAbsent(modalPayload?.entry.fields?.[0], "description", "placeholder");
    expectAbsent(modalPayload?.entry, "sessionKey", "messageId");

    const inMemoryComponent = await lookupComponent("btn_undefined");
    expect(inMemoryComponent).toHaveProperty("modalId", undefined);
    expect(inMemoryComponent).toHaveProperty("sessionKey", undefined);
  });

  it("falls back to the in-memory registry when persistent state cannot open", async () => {
    const warn = vi.fn();
    setDiscordRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable", { cause: new TypeError("disk busy") });
        }),
      },
      logging: { getChildLogger: () => ({ warn }) },
    } as never);

    await registerDiscordComponentEntries({
      entries: [buttonEntry("btn_fallback", "Fallback")],
      modals: [],
    });

    expect(await lookupComponent("btn_fallback")).toMatchObject({
      id: "btn_fallback",
      kind: "button",
      label: "Fallback",
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
    expect(warn).toHaveBeenCalledWith(
      "Discord persistent component registry state failed",
      expect.objectContaining({
        error: "Error: sqlite unavailable",
        errorName: "Error",
        errorMessage: "sqlite unavailable",
        errorCause: "TypeError: disk busy",
        errorCauseName: "TypeError",
        errorCauseMessage: "disk busy",
      }),
    );
  });
});
const generatedId = (prefix: string) =>
  expect.stringMatching(new RegExp(`^${prefix}_[A-Za-z0-9_-]{8}$`));

function readContainer(result: ReturnType<typeof buildDiscordComponentMessage>) {
  const container = result.components[0]?.serialize() as APIContainerComponent | undefined;
  if (container?.type !== ComponentType.Container) {
    throw new Error("Expected a Discord component container");
  }
  return container;
}

function selectBlock(select: DiscordComponentSelectSpec): DiscordComponentBlock[] {
  return [{ type: "actions", select }];
}

function buttonBlock(length: number): DiscordComponentBlock[] {
  return [
    {
      type: "actions",
      buttons: Array.from({ length }, (_, index) => ({ label: `Button ${index + 1}` })),
    },
  ];
}

describe("discord select components", () => {
  it.each([
    ["string", ComponentType.StringSelect, "select"],
    ["user", ComponentType.UserSelect, "user select"],
    ["role", ComponentType.RoleSelect, "role select"],
    ["mentionable", ComponentType.MentionableSelect, "mentionable select"],
    ["channel", ComponentType.ChannelSelect, "channel select"],
  ] as const)("preserves %s payload and metadata", (type, componentType, defaultLabel) => {
    const options = [
      {
        label: "Primary",
        value: "primary",
        description: "First choice",
        emoji: { name: "1️⃣" },
        default: true,
      },
    ];
    const result = buildDiscordComponentMessage({
      spec: {
        reusable: false,
        blocks: selectBlock({
          type,
          callbackData: "select:callback",
          callbackDataKind: "callback",
          minValues: 0,
          maxValues: 2,
          options,
          allowedUsers: ["user-1"],
        }),
      },
      sessionKey: "session-1",
      agentId: "agent-1",
      accountId: "default",
    });
    const row = readContainer(result).components[0];
    if (row?.type !== ComponentType.ActionRow) {
      throw new Error("Expected a Discord action row");
    }
    const select = expectDefined(row.components[0], "select component");
    const entry = expectDefined(result.entries[0], "select entry");
    expect(entry.id).toEqual(generatedId("sel"));

    expect(select).toEqual({
      type: componentType,
      ...(type === "string" ? { options } : {}),
      custom_id: `occomp:cid=${entry.id}`,
      min_values: 0,
      max_values: 2,
    });
    expect(result.entries).toEqual([
      {
        id: entry.id,
        kind: "select",
        label: defaultLabel,
        callbackData: "select:callback",
        callbackDataKind: "callback",
        selectType: type,
        ...(type === "string" ? { options: [{ value: "primary", label: "Primary" }] } : {}),
        allowedUsers: ["user-1"],
        sessionKey: "session-1",
        agentId: "agent-1",
        accountId: "default",
        reusable: false,
        consumptionGroupId: generatedId("grp"),
        consumptionGroupEntryIds: [entry.id],
      },
    ]);
  });

  it("preserves modal identity, required values, and callback payload", async () => {
    const fields = [
      ["select", ComponentType.StringSelect, StringSelectMenu, "Priority", 1, 1, undefined],
      ["role-select", ComponentType.RoleSelect, RoleSelectMenu, "Roles", 0, 2, false],
      ["user-select", ComponentType.UserSelect, UserSelectMenu, "Owner", 1, 1, true],
    ] as const;
    const options = () => [{ label: "High", value: "high", default: true }];
    const result = buildDiscordComponentMessage({
      spec: {
        modal: {
          title: "Select details",
          callbackData: "codex:modal",
          allowedUsers: ["discord:user-1"],
          fields: fields.map(
            ([type, _wireType, _constructor, label, minValues, maxValues, required]) => ({
              type,
              label,
              minValues,
              maxValues,
              required,
              placeholder: `Pick ${label.toLowerCase()}`,
              ...(type === "select" ? { options: options() } : {}),
            }),
          ),
        },
      },
    });
    const modalEntry = expectDefined(result.modals[0], "modal entry");
    expect(modalEntry).toMatchObject({
      callbackData: "codex:modal",
      allowedUsers: ["discord:user-1"],
    });
    expect(result.entries[0]).toMatchObject({ kind: "modal-trigger", modalId: modalEntry.id });
    expect(buildDiscordComponentMessageFlags(result.components)).toBe(MessageFlags.IsComponentsV2);
    expect(modalEntry.id).toEqual(generatedId("mdl"));
    const ids = modalEntry.fields.map((field) => field.id);
    expect(ids).toEqual([generatedId("fld"), generatedId("fld"), generatedId("fld")]);
    expect(new Set(ids).size).toBe(3);
    const modal = createDiscordFormModal(modalEntry);
    expect(modal.components).toMatchObject(
      fields.map((field) => ({
        component: expect.any(field[2]),
      })),
    );

    const expectedSerialized = {
      title: "Select details",
      custom_id: `ocmodal:mid=${modalEntry.id}`,
      components: fields.map(
        ([type, componentType, , label, min_values, max_values, required], index) => ({
          type: ComponentType.Label,
          label,
          component: {
            type: componentType,
            ...(type === "select" ? { options: options() } : {}),
            custom_id: ids[index],
            placeholder: `Pick ${label.toLowerCase()}`,
            min_values,
            max_values,
            required,
          },
        }),
      ),
    };
    expect(modal.serialize()).toEqual(expectedSerialized);

    const loopback = await createDiscordLoopbackRest();
    try {
      const client = createInternalTestClient();
      client.rest = loopback.rest;
      const interaction = createInteraction(
        client,
        createInternalComponentInteractionPayload({
          id: "interaction-1",
          token: "interaction-token",
        }),
      );
      if (!(interaction instanceof BaseComponentInteraction)) {
        throw new Error("Expected a Discord button interaction");
      }
      await interaction.showModal(modal);

      expect(loopback.requests).toMatchObject([
        {
          method: "POST",
          path: "/v10/interactions/interaction-1/interaction-token/callback",
        },
      ]);
      expect(loopback.requests[0]?.body).toBe(
        JSON.stringify({ type: InteractionResponseType.Modal, data: expectedSerialized }),
      );
    } finally {
      await loopback.close();
    }
  });

  it.each([
    ["no preceding row", [], [1]],
    ["four preceding buttons", buttonBlock(4), [5]],
    ["five preceding buttons", buttonBlock(5), [5, 1]],
    [
      "preceding select",
      selectBlock({ type: "string", options: [{ label: "One", value: "one" }] }),
      [1, 1],
    ],
  ] satisfies Array<[string, DiscordComponentBlock[], number[]]>)(
    "keeps the modal trigger row placement after %s",
    (_label, blocks, expectedSizes) => {
      const result = buildDiscordComponentMessage({
        spec: {
          blocks: [...blocks],
          modal: { title: "Details", fields: [{ type: "text", label: "Name" }] },
        },
      });
      const rows = readContainer(result).components.filter(
        (component) => component.type === ComponentType.ActionRow,
      );
      expect(rows.map((row) => row.components.length)).toEqual(expectedSizes);
      expect(rows.at(-1)?.components.at(-1)?.type).toBe(ComponentType.Button);
    },
  );
});
