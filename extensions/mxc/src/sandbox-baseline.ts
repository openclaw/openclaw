// Windows host paths used by the MXC filesystem policy.
import { win32 } from "node:path";

type BaselineTempEnv = {
  TEMP?: string;
  TMP?: string;
};

type BaselineReadonlyEnv = {
  SystemRoot?: string;
  WINDIR?: string;
  ProgramFiles?: string;
  ProgramW6432?: string;
  "ProgramFiles(x86)"?: string;
};

export type BaselineHostEnv = BaselineTempEnv & BaselineReadonlyEnv;

function firstNonBlankEnv(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim());
}

export function resolveSandboxTempDir(env: BaselineTempEnv = {}): string {
  return firstNonBlankEnv(env.TEMP, env.TMP) ?? "C:\\Windows\\Temp";
}

export function resolveBaselineReadonlyPaths(env: BaselineReadonlyEnv): string[] {
  const systemRoot = firstNonBlankEnv(env.SystemRoot, env.WINDIR) ?? "C:\\Windows";
  const programFiles = firstNonBlankEnv(env.ProgramFiles, env.ProgramW6432) ?? "C:\\Program Files";
  const programFilesX86 = firstNonBlankEnv(env["ProgramFiles(x86)"]) ?? "C:\\Program Files (x86)";
  return [
    ...new Set([
      programFiles,
      programFilesX86,
      win32.join(systemRoot, "System32"),
      win32.join(systemRoot, "SysWOW64"),
    ]),
  ];
}
