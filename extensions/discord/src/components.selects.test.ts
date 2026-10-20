import { ComponentType, InteractionResponseType } from "discord-api-types/v10";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { describe, expect, it } from "vitest";
import { buildDiscordComponentMessage, createDiscordFormModal } from "./components.js";
import type { DiscordComponentBlock, DiscordComponentSelectSpec } from "./components.types.js";
import {
  ChannelSelectMenu,
  Container,
  MentionableSelectMenu,
  RoleSelectMenu,
  Row,
  StringSelectMenu,
  UserSelectMenu,
} from "./internal/components.message.js";
import { BaseComponentInteraction, createInteraction } from "./internal/interactions.js";
import {
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "./internal/test-builders.test-support.js";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

const generatedId = (prefix: string) =>
  expect.stringMatching(new RegExp(`^${prefix}_[A-Za-z0-9_-]{8}$`));

function readContainer(result: ReturnType<typeof buildDiscordComponentMessage>) {
  const container = result.components[0];
  if (!(container instanceof Container)) {
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
    ["string", ComponentType.StringSelect, StringSelectMenu, "select"],
    ["user", ComponentType.UserSelect, UserSelectMenu, "user select"],
    ["role", ComponentType.RoleSelect, RoleSelectMenu, "role select"],
    ["mentionable", ComponentType.MentionableSelect, MentionableSelectMenu, "mentionable select"],
    ["channel", ComponentType.ChannelSelect, ChannelSelectMenu, "channel select"],
  ] as const)(
    "preserves %s identity, payload, and metadata",
    (type, componentType, constructor, defaultLabel) => {
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
      if (!(row instanceof Row)) {
        throw new Error("Expected a Discord action row");
      }
      const select = expectDefined(row.components[0], "select component");
      const entry = expectDefined(result.entries[0], "select entry");
      expect(entry.id).toEqual(generatedId("sel"));

      expect(select).toBeInstanceOf(constructor);
      expect(select.serialize()).toEqual({
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
    },
  );

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
      const rows = readContainer(result).components.filter((component) => component instanceof Row);
      expect(rows.map((row) => row.components.length)).toEqual(expectedSizes);
      expect(rows.at(-1)?.components.at(-1)?.type).toBe(ComponentType.Button);
    },
  );
});
