import fs from "node:fs/promises";
import { getRuntimeConfig } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalPluginRegistry } from "../../plugins/hook-runner-global.js";
import type { PluginHookRegistration } from "../../plugins/hook-types.js";
import { ensurePluginRegistryLoaded } from "../../plugins/runtime/runtime-registry-loader.js";
import type { IsolatedPostTurnPluginHookRequest } from "./isolated-plugin-hook-runner.js";

const log = createSubsystemLogger("agents/post-turn-worker");

function isSupportedHookName(value: string): value is IsolatedPostTurnPluginHookRequest["hookName"] {
  return value === "agent_end" || value === "llm_output";
}

function assertWorkerRequest(value: unknown): asserts value is IsolatedPostTurnPluginHookRequest {
  if (!value || typeof value !== "object") {
    throw new Error("invalid post-turn hook worker request");
  }
  const request = value as Partial<IsolatedPostTurnPluginHookRequest>;
  if (typeof request.hookName !== "string" || !isSupportedHookName(request.hookName)) {
    throw new Error("unsupported post-turn hook worker hookName");
  }
  if (typeof request.pluginId !== "string" || !request.pluginId.trim()) {
    throw new Error("post-turn hook worker request is missing pluginId");
  }
  if (
    typeof request.registrationOrdinal !== "number" ||
    !Number.isInteger(request.registrationOrdinal) ||
    request.registrationOrdinal < 0
  ) {
    throw new Error("post-turn hook worker request is missing registrationOrdinal");
  }
}

async function readWorkerRequest(): Promise<IsolatedPostTurnPluginHookRequest> {
  if (process.env.OPENCLAW_POST_TURN_WORKER_REQUEST_STDIN === "1") {
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      raw += chunk;
    }
    const parsed = JSON.parse(raw) as unknown;
    assertWorkerRequest(parsed);
    return parsed;
  }
  const requestFile = process.env.OPENCLAW_POST_TURN_WORKER_REQUEST_FILE;
  if (!requestFile) {
    throw new Error("OPENCLAW_POST_TURN_WORKER_REQUEST_FILE is not set");
  }
  const parsed = JSON.parse(await fs.readFile(requestFile, "utf8")) as unknown;
  assertWorkerRequest(parsed);
  return parsed;
}

export async function runIsolatedPluginHookWorkerRequest(
  request: IsolatedPostTurnPluginHookRequest,
): Promise<void> {
  const config = getRuntimeConfig();
  ensurePluginRegistryLoaded({
    scope: "all",
    config,
    activationSourceConfig: config,
    env: process.env,
  });
  const registry = getGlobalPluginRegistry();
  const hooks = (registry?.typedHooks ?? [])
    .filter(
      (hook): hook is PluginHookRegistration =>
        hook.hookName === request.hookName && hook.pluginId === request.pluginId,
    )
    .toSorted((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  const hook = hooks[request.registrationOrdinal];
  if (!hook) {
    log.warn(
      `post-turn hook worker found no hook handler for ${request.hookName}/${request.pluginId}#${request.registrationOrdinal}`,
    );
    return;
  }
  await Promise.resolve(
    (hook.handler as (event: unknown, ctx: unknown) => Promise<void> | void)(
      request.event,
      request.ctx,
    ),
  );
}

export async function runPostTurnWorkerFromCli(): Promise<void> {
  await runIsolatedPluginHookWorkerRequest(await readWorkerRequest());
}
