import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { i as ThinkingCatalogEntry } from "./thinking.shared-DZFlsfdo.js";
import { t as CommandArgValues } from "./commands-args.types-BetHnA9i.js";

//#region src/auto-reply/commands-registry.types.d.ts
type CommandScope = "text" | "native" | "both";
/**
 * Controls progressive disclosure of commands in the UI.
 * - "essential": Always visible (~10 core commands)
 * - "standard": Shown on expand / "Show more" (~15 commands)
 * - "power": Only surfaced via search or explicit filter (~15 commands)
 */
type CommandTier = "essential" | "standard" | "power";
type CommandCategory = "session" | "options" | "status" | "management" | "media" | "tools" | "docks";
type CommandArgType = "string" | "number" | "boolean";
type CommandArgChoiceContext = {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  catalog?: ThinkingCatalogEntry[];
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
};
type CommandArgChoice = string | {
  value: string;
  label: string;
};
type CommandArgChoicesProvider = (context: CommandArgChoiceContext) => CommandArgChoice[];
type CommandArgDefinition = {
  name: string;
  description: string;
  type: CommandArgType;
  required?: boolean;
  choices?: CommandArgChoice[] | CommandArgChoicesProvider;
  preferAutocomplete?: boolean;
  captureRemaining?: boolean;
};
type CommandArgMenuSpec = {
  arg: string;
  title?: string;
};
type CommandArgsParsing = "none" | "positional";
type ChatCommandDefinition = {
  key: string;
  nativeName?: string;
  nativeAliases?: string[];
  description: string; /** Localized descriptions for native command surfaces that support them. */
  descriptionLocalizations?: Record<string, string>;
  textAliases: string[];
  acceptsArgs?: boolean;
  args?: CommandArgDefinition[];
  argsParsing?: CommandArgsParsing;
  formatArgs?: (values: CommandArgValues) => string | undefined;
  argsMenu?: CommandArgMenuSpec | "auto";
  scope: CommandScope;
  category?: CommandCategory; /** Progressive disclosure tier. Defaults to "standard" when omitted. */
  tier?: CommandTier;
};
type NativeCommandSpec = {
  name: string;
  description: string;
  descriptionLocalizations?: Record<string, string>;
  acceptsArgs: boolean;
  args?: CommandArgDefinition[];
};
type CommandNormalizeOptions = {
  botUsername?: string;
};
type CommandDetection = {
  exact: Set<string>;
  regex: RegExp;
};
type ShouldHandleTextCommandsParams = {
  cfg: OpenClawConfig;
  surface: string;
  commandSource?: "text" | "native";
};
//#endregion
export { CommandArgsParsing as a, CommandScope as c, CommandArgMenuSpec as i, NativeCommandSpec as l, CommandArgChoiceContext as n, CommandDetection as o, CommandArgDefinition as r, CommandNormalizeOptions as s, ChatCommandDefinition as t, ShouldHandleTextCommandsParams as u };