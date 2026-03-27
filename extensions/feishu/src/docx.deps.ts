import { getFeishuRuntime } from "./runtime.js";
import {
  createFeishuToolClient,
  resolveAnyEnabledFeishuToolsConfig,
  resolveFeishuToolAccount,
} from "./tool-account.js";

export type FeishuDocDeps = {
  getFeishuRuntime: typeof getFeishuRuntime;
  createFeishuToolClient: typeof createFeishuToolClient;
  resolveAnyEnabledFeishuToolsConfig: typeof resolveAnyEnabledFeishuToolsConfig;
  resolveFeishuToolAccount: typeof resolveFeishuToolAccount;
};

export const feishuDocDeps: FeishuDocDeps = {
  getFeishuRuntime,
  createFeishuToolClient,
  resolveAnyEnabledFeishuToolsConfig,
  resolveFeishuToolAccount,
};

export function setFeishuDocDepsForTest(overrides: Partial<FeishuDocDeps> | null): void {
  feishuDocDeps.getFeishuRuntime = overrides?.getFeishuRuntime ?? getFeishuRuntime;
  feishuDocDeps.createFeishuToolClient =
    overrides?.createFeishuToolClient ?? createFeishuToolClient;
  feishuDocDeps.resolveAnyEnabledFeishuToolsConfig =
    overrides?.resolveAnyEnabledFeishuToolsConfig ?? resolveAnyEnabledFeishuToolsConfig;
  feishuDocDeps.resolveFeishuToolAccount =
    overrides?.resolveFeishuToolAccount ?? resolveFeishuToolAccount;
}
