import type { WorkspaceBootstrapFile } from "./workspace-bootstrap-policy.js";

export type BootstrapTruncationCause = "per-file-limit" | "total-limit";
export type BootstrapPromptWarningMode = "off" | "once" | "always";

export type BootstrapInjectionStat = {
  name: string;
  path: string;
  origin?: WorkspaceBootstrapFile["origin"];
  missing: boolean;
  rawChars: number;
  injectedChars: number;
  truncated: boolean;
};

export type BootstrapPromptWarning = {
  signature?: string;
  warningShown: boolean;
  lines: string[];
  warningSignaturesSeen: string[];
};
