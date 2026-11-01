import chalk, { Chalk } from "chalk";
import { LOBSTER_PALETTE } from "./palette.js";

// Session tint hues, kept in sync with the Control UI sidebar (ui/src/styles/base.css
// `--session-color-*`) so a named session color renders as the same hue in the CLI
// table as it does on the sidebar. Clients map SESSION_COLOR_IDS names to these
// theme-tuned hues rather than emitting raw values.
const SESSION_TINT_HEX = {
  red: "#f07878",
  blue: "#72a7ed",
  green: "#69bf8a",
  yellow: "#dcc365",
  purple: "#b595e8",
  orange: "#eaa36a",
  pink: "#df8cb9",
  cyan: "#66bccb",
} as const;

export type SessionTintId = keyof typeof SESSION_TINT_HEX;

// Typed lookup: accepts any incoming color string and returns the matching hue
// (or undefined). Used instead of an index assertion so unknown colors degrade
// to a neutral fallback rather than indexing with an unsafe cast.
const SESSION_TINT_BY_ID = new Map<string, string>(Object.entries(SESSION_TINT_HEX));

// Shared terminal color theme that respects NO_COLOR and FORCE_COLOR.
const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

/** Shared terminal theme color functions. */
export const theme = {
  accent: hex(LOBSTER_PALETTE.accent),
  accentBright: hex(LOBSTER_PALETTE.accentBright),
  accentDim: hex(LOBSTER_PALETTE.accentDim),
  info: hex(LOBSTER_PALETTE.info),
  success: hex(LOBSTER_PALETTE.success),
  warn: hex(LOBSTER_PALETTE.warn),
  error: hex(LOBSTER_PALETTE.error),
  muted: hex(LOBSTER_PALETTE.muted),
  heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
  command: hex(LOBSTER_PALETTE.accentBright),
  option: hex(LOBSTER_PALETTE.warn),
} as const;

/** Return true when color styling is active. */
export const isRich = () => baseChalk.level > 0;

/**
 * Return a chalk color function for a named session tint, or undefined when the
 * name is unknown. Callers should fall back to a neutral color when undefined.
 */
export const sessionTint = (color: string | undefined | null) => {
  const hue = color === undefined || color === null ? undefined : SESSION_TINT_BY_ID.get(color);
  return hue === undefined ? undefined : hex(hue);
};

/** Conditionally apply a color function based on caller rich-output state. */
export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
