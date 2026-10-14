import {
  resolveSrtWin,
  VENDORED_SRT_WIN_EXE,
  type SrtWinSpawn,
} from "@anthropic-ai/sandbox-runtime";

/** Reserved Windows settings; execution remains disabled until provisioning has native ownership custody. */
export type WindowsPluginOptions = {
  srtWinPath?: string;
  proxyPortBase?: number;
};

/** Dependency discovery is read-only and never installs an account or grants ACLs. */
export function resolveWindowsSrtWin(options: WindowsPluginOptions): SrtWinSpawn {
  return resolveSrtWin({ path: options.srtWinPath ?? VENDORED_SRT_WIN_EXE });
}
