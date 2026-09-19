import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
import type { CodexAppServerClient } from "./client.js";
import { readCodexEffectiveConfig } from "./config-layer-policy.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

function assertNoHookDeclarations(config: JsonObject): void {
  if (config.hooks === undefined) {
    return;
  }
  if (
    !isJsonObject(config.hooks) ||
    Object.entries(config.hooks).some(([event, value]) =>
      event === "state" ? !isJsonObject(value) : !Array.isArray(value) || value.length > 0,
    )
  ) {
    throw new Error("Codex private completion received unmanaged hook declarations");
  }
}

async function assertPrivateLayerPath(value: unknown, root: string): Promise<void> {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    !isPathInside(root, await canonicalPathFromExistingAncestor(value))
  ) {
    throw new Error("Codex private completion inherited an external user or project config layer");
  }
}

/** Proves hook discovery is confined to managed policy and this completion's private roots. */
export async function assertCodexPrivateHookIsolation(
  client: Pick<CodexAppServerClient, "request">,
  workspace: { codexHome: string; cwd: string },
  signal?: AbortSignal,
): Promise<{ activeManagedHooks: boolean }> {
  signal?.throwIfAborted();
  const [codexHome, cwd] = await Promise.all([
    fs.realpath(workspace.codexHome),
    fs.realpath(workspace.cwd),
  ]);
  const response = await readCodexEffectiveConfig(client, cwd, { signal });
  const features = response.config.features;
  if (
    !isJsonObject(features) ||
    typeof features.hooks !== "boolean" ||
    features.plugins !== false ||
    !Array.isArray(response.config.project_root_markers) ||
    response.config.project_root_markers.length !== 0
  ) {
    throw new Error("Codex private completion could not verify isolated hook discovery settings");
  }
  if (!Array.isArray(response.layers)) {
    throw new Error("Codex private completion config/read omitted config layers");
  }
  let privateUserLayer = false;
  for (const layer of response.layers) {
    if (!isJsonObject(layer) || !isJsonObject(layer.name) || !isJsonObject(layer.config)) {
      throw new Error("Codex private completion config/read returned invalid config layers");
    }
    switch (layer.name.type) {
      case "user":
        await assertPrivateLayerPath(layer.name.file, codexHome);
        privateUserLayer = true;
        break;
      case "project":
        await assertPrivateLayerPath(layer.name.dotCodexFolder, cwd);
        break;
      case "packagedDefaults":
      case "sessionFlags":
        assertNoHookDeclarations(layer.config);
        break;
      case "system":
      case "mdm":
      case "enterpriseManaged":
        break;
      default:
        throw new Error("Codex private completion received an unsupported config layer");
    }
  }
  if (!privateUserLayer) {
    throw new Error("Codex private completion could not verify its private Codex home");
  }
  signal?.throwIfAborted();
  if (!features.hooks) {
    const requirementsResponse = await client.request("configRequirements/read", {}, { signal });
    if (
      !isJsonObject(requirementsResponse) ||
      !isJsonObject(requirementsResponse.requirements) ||
      !isJsonObject(requirementsResponse.requirements.featureRequirements) ||
      requirementsResponse.requirements.featureRequirements.hooks !== false
    ) {
      throw new Error(
        "Codex private completion cannot disable hooks without a managed requirement",
      );
    }
    return { activeManagedHooks: false };
  }

  // hooks/list resolves process config, not a thread's overrides. The private
  // process must already use these roots and hook settings before this read.
  const inventory = await client.request("hooks/list", { cwds: [cwd] }, { signal });
  if (
    !isJsonObject(inventory) ||
    !Array.isArray(inventory.data) ||
    inventory.data.length !== 1 ||
    (inventory.nextCursor !== undefined && inventory.nextCursor !== null)
  ) {
    throw new Error("Codex private completion received an incomplete hook inventory");
  }
  const entry = inventory.data[0];
  if (
    !isJsonObject(entry) ||
    entry.cwd !== cwd ||
    !Array.isArray(entry.hooks) ||
    !Array.isArray(entry.errors) ||
    entry.errors.length !== 0 ||
    !Array.isArray(entry.warnings) ||
    entry.warnings.length !== 0
  ) {
    throw new Error("Codex private completion could not verify its hook inventory");
  }
  let activeManagedHooks = false;
  for (const hook of entry.hooks) {
    if (
      !isJsonObject(hook) ||
      typeof hook.key !== "string" ||
      !hook.key.trim() ||
      typeof hook.enabled !== "boolean" ||
      typeof hook.isManaged !== "boolean"
    ) {
      throw new Error("Codex private completion received invalid hook metadata");
    }
    if (hook.enabled && !hook.isManaged) {
      throw new Error("Codex private completion cannot run unmanaged hooks");
    }
    activeManagedHooks ||= hook.enabled && hook.isManaged;
  }
  signal?.throwIfAborted();
  return { activeManagedHooks };
}
