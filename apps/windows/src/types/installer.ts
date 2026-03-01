export type InstallStatus = "pending" | "installing" | "installed" | "failed";

export interface InstallStep {
  key: string;
  title: string;
  subText?: string;
  status: InstallStatus;
  mode?: "wsl" | "windows";
  error?: string;
}

export interface Installer {
  install: () => Promise<void>;
}
