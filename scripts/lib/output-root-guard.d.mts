import type fs from "node:fs";

export const CONTROL_UI_BUILD_PREFIX: "control-ui.build-";
export function controlUiBuildSiblingPid(name: string): number | null;
export function assertRealOutputRoot(
  rootPath: string,
  params?: { fs?: Pick<typeof fs, "lstatSync"> },
): void;
