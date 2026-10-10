/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";
import { interactiveAgentTheme as theme } from "../theme/theme.js";

function formatKeyPart(part: string): string {
  return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

export function keyText(keybinding: Keybinding): string {
  return getKeybindings()
    .getKeys(keybinding)
    .join("/")
    .split("/")
    .map((k) => k.split("+").map(formatKeyPart).join("+"))
    .join("/");
}

export function keyHint(keybinding: Keybinding, description: string): string {
  return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}
