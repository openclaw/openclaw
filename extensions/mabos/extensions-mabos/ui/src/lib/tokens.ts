/**
 * MABOS Design System — Runtime Token Helpers
 *
 * CSS custom property names and utility functions for use in
 * inline styles and color-mix expressions within components.
 */

export const tokens = {
  bg: {
    primary: "--bg-primary",
    secondary: "--bg-secondary",
    tertiary: "--bg-tertiary",
    card: "--bg-card",
    hover: "--bg-hover",
  },
  text: {
    primary: "--text-primary",
    secondary: "--text-secondary",
    muted: "--text-muted",
  },
  accent: {
    green: "--accent-green",
    purple: "--accent-purple",
    blue: "--accent-blue",
    orange: "--accent-orange",
    red: "--accent-red",
    slate: "--accent-slate",
    cyan: "--accent-cyan",
    pink: "--accent-pink",
    indigo: "--accent-indigo",
  },
  border: {
    default: "--border-mabos",
    hover: "--border-hover",
  },
} as const;

/** Wrap a CSS custom property name in var() */
export function cssVar(token: string): string {
  return `var(${token})`;
}

/**
 * Generate a color-mix tint expression.
 * @param accent - CSS custom property name (e.g. "--accent-green")
 * @param opacity - Mix percentage (default "15%")
 */
export function tint(accent: string, opacity = "15%"): string {
  return `color-mix(in srgb, var(${accent}) ${opacity}, transparent)`;
}
