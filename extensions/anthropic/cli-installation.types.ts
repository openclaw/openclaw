export type ClaudeCommandContext = Readonly<{
  command: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
}>;

export type ClaudeInstallation = Readonly<{
  kind: "native" | "homebrew" | "npm";
  key: string;
  stableCommand: string;
  executable: string;
  ownerRoot: string;
  managerCommand: string;
  updateArgv: readonly string[];
}>;

export type ClaudeInstallationResult =
  | { status: "supported"; installation: ClaudeInstallation }
  | {
      status: "unsupported";
      reason:
        | "missing"
        | "desktop-managed"
        | "custom-wrapper"
        | "pinned-command"
        | "unsupported-manager"
        | "unproven-owner";
      message: string;
    };

export type ClaudeInstallationUpdateResult =
  | { status: "updated"; installation: ClaudeInstallation; version: string }
  | {
      status: "failed";
      reason: "owner-changed" | "update-failed" | "verification-failed";
      message: string;
    };
