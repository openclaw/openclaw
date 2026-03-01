import { useEffect, useMemo } from "react";
import ReactDOM from "react-dom/client";
import {
  BrandVariants,
  FluentProvider,
  createDarkTheme,
  createLightTheme,
  webLightTheme,
  webDarkTheme,
} from "@fluentui/react-components";
import { RouterProvider } from "react-router";
import router from "./router";
import { useSystemTheme } from "./hooks/use-systemtheme";
import { useAccentColor } from "./hooks/use-accent-color";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./global.css";

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

function mix(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number
) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function colorToHex(c: { r: number; g: number; b: number }): string {
  return rgbToHex(c.r, c.g, c.b);
}

function createBrandVariants(hex: string): BrandVariants | null {
  const base = hexToRgb(hex);
  if (!base) return null;

  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };

  return {
    10: colorToHex(mix(base, white, 0.95)),
    20: colorToHex(mix(base, white, 0.9)),
    30: colorToHex(mix(base, white, 0.8)),
    40: colorToHex(mix(base, white, 0.7)),
    50: colorToHex(mix(base, white, 0.6)),
    60: colorToHex(mix(base, white, 0.5)),
    70: colorToHex(mix(base, white, 0.4)),
    80: colorToHex(mix(base, white, 0.3)),
    90: colorToHex(mix(base, white, 0.2)),
    100: rgbToHex(base.r, base.g, base.b),
    110: colorToHex(mix(base, black, 0.1)),
    120: colorToHex(mix(base, black, 0.2)),
    130: colorToHex(mix(base, black, 0.3)),
    140: colorToHex(mix(base, black, 0.4)),
    150: colorToHex(mix(base, black, 0.5)),
    160: colorToHex(mix(base, black, 0.6)),
  };
}

function App() {
  const systemTheme = useSystemTheme();
  const accentColor = useAccentColor();

  const theme = useMemo(() => {
    const baseTheme = systemTheme === "dark" ? webDarkTheme : webLightTheme;
    const variants = accentColor ? createBrandVariants(accentColor.hex) : null;
    const themed =
      variants != null
        ? systemTheme === "dark"
          ? createDarkTheme(variants)
          : createLightTheme(variants)
        : baseTheme;

    return {
      ...themed,
      colorNeutralBackground1: themed.colorTransparentBackground,
    };
  }, [systemTheme, accentColor]);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  return (
    <ErrorBoundary>
      <FluentProvider theme={theme}>
        <RouterProvider router={router} />
      </FluentProvider>
    </ErrorBoundary>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />
);
