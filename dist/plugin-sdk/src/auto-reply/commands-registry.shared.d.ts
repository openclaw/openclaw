import type { ChatCommandDefinition, CommandArgChoiceContext, CommandCategory, CommandScope, CommandTier } from "./commands-registry.types.js";
type ListThinkingLevels = (provider?: string | null, model?: string | null, catalog?: CommandArgChoiceContext["catalog"]) => string[];
type DefineChatCommandInput = {
    key: string;
    nativeName?: string;
    nativeAliases?: string[];
    description: string;
    args?: ChatCommandDefinition["args"];
    argsParsing?: ChatCommandDefinition["argsParsing"];
    formatArgs?: ChatCommandDefinition["formatArgs"];
    argsMenu?: ChatCommandDefinition["argsMenu"];
    acceptsArgs?: boolean;
    textAlias?: string;
    textAliases?: string[];
    scope?: CommandScope;
    category?: CommandCategory;
    /** Progressive disclosure tier. Defaults to "standard". */
    tier?: CommandTier;
};
export declare function defineChatCommand(command: DefineChatCommandInput): ChatCommandDefinition;
export declare function assertCommandRegistry(commands: ChatCommandDefinition[]): void;
export declare function buildBuiltinChatCommands(params?: {
    listThinkingLevels?: ListThinkingLevels;
}): ChatCommandDefinition[];
export {};
