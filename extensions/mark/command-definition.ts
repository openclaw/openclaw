/**
 * Core command definition for /mark.
 *
 * Imported by `src/auto-reply/commands-registry.session-labels.ts`
 * so the sub-menu (`argsMenu`, `choices`) renders in the WebChat UI.
 *
 * The handler lives in `index.ts` (plugin entry, via `api.registerCommand`).
 */
import { MARK_PRESETS } from "./commands-mark.shared.js";
import type { ChatCommandDefinition } from "../../src/auto-reply/commands-registry.types.js";

type DefineChatCommand = (input: {
  key: string;
  nativeName?: string;
  description: string;
  textAlias?: string;
  acceptsArgs?: boolean;
  category?: string;
  tier?: string;
  args?: ChatCommandDefinition["args"];
  argsMenu?: ChatCommandDefinition["argsMenu"];
}) => ChatCommandDefinition;

export function buildMarkCommand(
  defineChatCommand: DefineChatCommand,
): ChatCommandDefinition {
  return defineChatCommand({
    key: "mark",
    nativeName: "mark",
    description: "Mark the current session with a preset symbol.",
    textAlias: "/mark",
    acceptsArgs: true,
    category: "session",
    tier: "standard",
    args: [
      {
        name: "mark",
        description: "Choose a mark or clear it",
        type: "string",
        choices: [
          ...MARK_PRESETS.map((p) => ({
            value: p.aliases[0],
            label: `${p.symbol} ${p.id}`,
          })),
          { value: "clear", label: "Clear mark" },
        ],
      },
    ],
    argsMenu: "auto",
  });
}
