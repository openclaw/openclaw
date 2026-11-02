import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
} from "openclaw/plugin-sdk/command-status";
import { createPluginCommandRuntime } from "openclaw/plugin-sdk/plugin-command-runtime";
import { matchPluginCommand, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { expect, it } from "vitest";
import { buildPluginTelegramMenuCommands } from "./bot-native-command-menu.js";
import { inputRichBlocksToPlainText } from "./rich-block-model.js";
import { planTelegramTextDeliveryPages } from "./telegram-text-delivery.js";

function registerCommand(name: string, nativeName?: string) {
  expect(
    registerPluginCommand(name, {
      name,
      description: `Run ${name}`,
      acceptsArgs: true,
      nativeNames: nativeName ? { telegram: nativeName } : undefined,
      handler: async () => ({ text: name }),
    }),
  ).toEqual({ ok: true });
}

const commandPage = (page = 1) =>
  buildCommandsMessagePaginated(undefined, undefined, { forcePaginatedList: true, page });
const commandPages = () =>
  Array.from({ length: commandPage().totalPages }, (_, index) => commandPage(index + 1).text);

function menuCommands() {
  return buildPluginTelegramMenuCommands({
    specs: createPluginCommandRuntime().listNativeCandidates("telegram"),
    existingCommands: new Set(),
  }).commands;
}

it.each(["forward", "reverse", "alias"])("preserves command owners (%s)", (mode) => {
  withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
    const alias = mode === "alias";
    const names = mode === "reverse" ? ["foo_bar", "foo-bar"] : ["foo-bar", "foo_bar"];
    for (const name of names) {
      registerCommand(name, alias && name === "foo-bar" ? "other_name" : undefined);
    }
    for (const text of [buildCommandsMessage(), commandPages().join("\n")]) {
      expect(text).toContain("`/foo-bar` (foo-bar) - Run foo-bar");
      expect(text).toContain("/foo_bar (foo_bar) - Run foo_bar");
    }
    expect(matchPluginCommand("/foo-bar status")?.command.name).toBe("foo-bar");
    expect(matchPluginCommand("/foo_bar status")?.command.name).toBe("foo_bar");
    if (alias) {
      expect(matchPluginCommand("/other_name status", { channel: "telegram" })?.command.name).toBe(
        "foo-bar",
      );
    }
    expect(menuCommands()).toEqual([
      { command: "foo_bar", description: "Run foo_bar" },
      ...(alias ? [{ command: "other_name", description: "Run foo-bar" }] : []),
    ]);
  });
});

it.each([false, true])("encodes delivered command names as code (rich=%s)", (richMessages) => {
  withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
    registerCommand("active-memory");
    const text = commandPages().find((entry) => entry.includes("active-memory"));
    expect(text, "registered command was not listed").toBeDefined();
    const deliveries = planTelegramTextDeliveryPages({
      text: text!,
      maxChars: 4096,
      richMessages,
    });
    if (richMessages) {
      const blocks = deliveries.flatMap((delivery) => delivery.richMessage?.blocks ?? []);
      expect(inputRichBlocksToPlainText(blocks)).toContain("/active-memory");
      expect(
        blocks.flatMap((block) =>
          block.type === "paragraph" && Array.isArray(block.text) ? block.text : [],
        ),
      ).toContainEqual(expect.objectContaining({ type: "code", text: "/active-memory" }));
    } else {
      expect(deliveries.map((delivery) => delivery.htmlText).join("\n")).toContain(
        "<code>/active-memory</code>",
      );
    }
  });
});
