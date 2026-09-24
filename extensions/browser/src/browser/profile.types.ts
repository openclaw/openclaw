import type { BrowserProfileConfig } from "openclaw/plugin-sdk/config-contracts";

/** Runtime browser profile settings resolved from global and profile config. */
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
