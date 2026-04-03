import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 从当前文件位置向上逐级查找 package.json
 * - ts 源码直接运行时（tsx/ts-node）：src/version.ts → 向上 1 级
 * - tsc 编译后运行时：dist/src/version.js → 向上 2 级
 */
const findPackageJson = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // 已到文件系统根目录
    dir = parent;
  }
  throw new Error("找不到 package.json");
};

const pkg = JSON.parse(readFileSync(findPackageJson(), "utf-8")) as { version: string };

/** 插件版本号，运行时从 package.json 读取 */
export const PLUGIN_VERSION: string = pkg.version ?? "";
