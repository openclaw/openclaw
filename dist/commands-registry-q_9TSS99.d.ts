import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { i as ThinkingCatalogEntry } from "./thinking.shared-DZFlsfdo.js";
import { t as SkillCommandSpec } from "./skills-BRkHvK1T.js";
import { n as CommandArgs } from "./commands-args.types-BetHnA9i.js";
import { l as NativeCommandSpec, r as CommandArgDefinition, t as ChatCommandDefinition } from "./commands-registry.types-B-WfTzT-.js";
//#region src/auto-reply/commands-registry-list.d.ts
declare function listChatCommands(params?: {
  skillCommands?: SkillCommandSpec[];
}): ChatCommandDefinition[];
declare function isCommandEnabled(cfg: OpenClawConfig, commandKey: string): boolean;
declare function listChatCommandsForConfig(cfg: OpenClawConfig, params?: {
  skillCommands?: SkillCommandSpec[];
}): ChatCommandDefinition[];
//#endregion
//#region src/auto-reply/commands-registry.d.ts
type NativeCommandProviderLookupOptions = {
  includeBundledChannelFallback?: boolean;
};
declare function listNativeCommandSpecs(params?: {
  skillCommands?: SkillCommandSpec[];
  provider?: string;
}): NativeCommandSpec[];
declare function listNativeCommandSpecsForConfig(cfg: OpenClawConfig, params?: {
  skillCommands?: SkillCommandSpec[];
  provider?: string;
}): NativeCommandSpec[];
declare function findCommandByNativeName(name: string, provider?: string, options?: NativeCommandProviderLookupOptions): ChatCommandDefinition | undefined;
declare function buildCommandText(commandName: string, args?: string): string;
declare function parseCommandArgs(command: ChatCommandDefinition, raw?: string): CommandArgs | undefined;
declare function serializeCommandArgs(command: ChatCommandDefinition, args?: CommandArgs): string | undefined;
declare function buildCommandTextFromArgs(command: ChatCommandDefinition, args?: CommandArgs): string;
type ResolvedCommandArgChoice = {
  value: string;
  label: string;
};
declare function resolveCommandArgChoices(params: {
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  catalog?: ThinkingCatalogEntry[];
}): ResolvedCommandArgChoice[];
declare function resolveCommandArgMenu(params: {
  command: ChatCommandDefinition;
  args?: CommandArgs;
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  catalog?: ThinkingCatalogEntry[];
}): {
  arg: CommandArgDefinition;
  choices: ResolvedCommandArgChoice[];
  title?: string;
} | null;
declare function formatCommandArgMenuTitle(params: {
  command: ChatCommandDefinition;
  menu: NonNullable<ReturnType<typeof resolveCommandArgMenu>>;
}): string;
declare function isCommandMessage(raw: string): boolean;
//#endregion
export { formatCommandArgMenuTitle as a, listNativeCommandSpecsForConfig as c, resolveCommandArgMenu as d, serializeCommandArgs as f, listChatCommandsForConfig as h, findCommandByNativeName as i, parseCommandArgs as l, listChatCommands as m, buildCommandText as n, isCommandMessage as o, isCommandEnabled as p, buildCommandTextFromArgs as r, listNativeCommandSpecs as s, ResolvedCommandArgChoice as t, resolveCommandArgChoices as u };