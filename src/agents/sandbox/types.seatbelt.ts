import type { SandboxSeatbeltSettings } from "../../config/types.sandbox.js";

type RequiredSeatbeltConfigKeys = "profileDir";

export type SandboxSeatbeltConfig = Omit<SandboxSeatbeltSettings, RequiredSeatbeltConfigKeys> &
  Required<Pick<SandboxSeatbeltSettings, RequiredSeatbeltConfigKeys>>;

export type SandboxSeatbeltContext = {
  profileDir: string;
  profile: string;
  profilePath: string;
  params: Record<string, string>;
};
