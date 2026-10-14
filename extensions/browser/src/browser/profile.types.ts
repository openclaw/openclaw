import type { BrowserProfileConfig } from "openclaw/plugin-sdk/config-contracts";

export type ManagedBrowserHeadlessSource =
  | "request"
  | "env"
  | "profile"
  | "config"
  | "linux-display-fallback"
  | "default";

export type ResolvedBrowserProfile = {
  name: string;
  /** Omitted only by legacy callers; defaults to Chromium. */
  engine?: NonNullable<BrowserProfileConfig["engine"]>;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  userDataDir?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  color: string;
  driver: "openclaw" | "existing-session" | "extension";
  executablePath?: string;
  headless: boolean;
  headlessSource?: "profile" | "config" | "default";
  attachOnly: boolean;
};
