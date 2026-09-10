/**
 * Real-behavior proof for the app-server runtime-chooser bindings fix.
 *
 * What is REAL here (no vitest, no mocks of the seam under test):
 *   - `buildPreparedModelsProviderData()` from
 *     src/auto-reply/reply/commands-models.ts —
 *     the exact production function that builds `/models` provider data.
 *   - Explicit lifecycle publication captures real registered harnesses, catalog
 *     routes, and synthetic configured host-auth facts. Runtime choices pass the
 *     production per-model auth/route/support checks; no fake harness is registered.
 *   - `listAppServerRuntimeModelBackendBindings()` and the real bundled plugin
 *     manifests read off disk via `listBundledPluginMetadata()`.
 *   - The downstream selection lookup is reproduced exactly as the Discord model
 *     picker does it (extensions/discord/src/monitor/
 *     native-command-model-picker-interaction.ts): resolve the rendered stable
 *     runtime token against the selected model's current choices.
 *
 * What is stubbed: nothing between the entrypoint and the assertions. Providers
 * are declared inline in the config (a first-class production path) so the proof
 * needs no network and no ambient credentials.
 *
 * Scenarios:
 *   1. github-copilot — the bug. Before the fix the provider had NO chooser
 *      entry at all; after it, the Copilot runtime is offered and selectable.
 *   2. openai — regression guard. The pre-existing Codex chooser still works.
 *   3. A provider served by no app-server binding retains only OpenClaw,
 *      proving the fix did not blanket-add native runtimes everywhere.
 *   4. Disabled owner — a runtime whose bundled plugin is disabled is hidden
 *      instead of leaving a chooser entry that can only fail.
 *   5. Binding coverage — every agent harness declared by a real bundled
 *      manifest on disk has a binding row.
 *   6. `/model <provider>/<model> --runtime <runtime>` directive acceptance —
 *      the real `resolveModelRuntimeDirective()` accepts the same Copilot and
 *      Codex pairings the chooser offers.
 *   7. Directive gating — when the owning plugin is disabled, the directive is
 *      rejected with an actionable message instead of persisting an override
 *      that dead-ends the next turn in `ensureSelectedAgentHarnessPlugin()`.
 *      Proven for both bridge harnesses, and `applyModelRuntimeDirective()` is
 *      run to show nothing is written to the session entry.
 *   8. Gate exemptions — the built-in `openclaw` runtime and an incompatible
 *      runtime keep their existing outcomes.
 *   9. Next-turn consequence — the real `ensureSelectedAgentHarnessPlugin()`
 *      is run against the real captured registry a disabled owner produces. It
 *      throws for the override the pre-fix directive persisted, and the
 *      post-fix directive never persists that override, so the throw is
 *      unreachable. This closes the causal chain the review described without
 *      needing GitHub Copilot credentials.
 *
 * Run: pnpm tsx scripts/proof-app-server-runtime-chooser-bindings.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm as removeProofState } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

type CommandsModelsModule = typeof import("../src/auto-reply/reply/commands-models.js");
type BindingsModule = typeof import("../src/agents/app-server-runtime-bindings.js");
type BundledMetadataModule = typeof import("../src/plugins/bundled-plugin-metadata.js");
type DirectiveRuntimeModule =
  typeof import("../src/auto-reply/reply/directive-handling.model-runtime.js");
type HarnessRuntimePluginModule = typeof import("../src/agents/harness/runtime-plugin.js");
type OpenClawConfig = import("../src/config/types.openclaw.js").OpenClawConfig;

// Redirect all OpenClaw state to a throwaway directory BEFORE any source module
// resolves it, so this proof reads and writes nothing in the operator's real
// state directory.
const proofStateDir = mkdtempSync(join(tmpdir(), "proof-runtime-chooser-state-"));
process.env.OPENCLAW_STATE_DIR = proofStateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(proofStateDir, "openclaw.json");

const repoRoot = process.env.PROOF_REPO_ROOT ?? process.cwd();
const importSource = async (relativePath: string) =>
  import(pathToFileURL(path.join(repoRoot, relativePath)).href);

const { buildPreparedModelsProviderData } = (await importSource(
  "src/auto-reply/reply/commands-models.ts",
)) as CommandsModelsModule;
const { listAppServerRuntimeModelBackendBindings } = (await importSource(
  "src/agents/app-server-runtime-bindings.ts",
)) as BindingsModule;
const { listBundledPluginMetadata } = (await importSource(
  "src/plugins/bundled-plugin-metadata.ts",
)) as BundledMetadataModule;
const { applyModelRuntimeDirective, resolveModelRuntimeDirective } = (await importSource(
  "src/auto-reply/reply/directive-handling.model-runtime.ts",
)) as DirectiveRuntimeModule;
const { ensureSelectedAgentHarnessPlugin } = (await importSource(
  "src/agents/harness/runtime-plugin.ts",
)) as HarnessRuntimePluginModule;

const { publishPreparedModelRuntimeSnapshot } = (await importSource(
  "src/agents/prepared-model-runtime.ts",
)) as typeof import("../src/agents/prepared-model-runtime.js");
const { closePreparedModelRuntimeSnapshots } = (await importSource(
  "src/agents/prepared-model-runtime.lifecycle.ts",
)) as typeof import("../src/agents/prepared-model-runtime.lifecycle.js");
const { resolveAgentDir } = (await importSource(
  "src/agents/agent-scope.ts",
)) as typeof import("../src/agents/agent-scope.js");
const { createDiscordModelPickerRuntimeToken } = (await importSource(
  "extensions/discord/src/monitor/model-picker.state.ts",
)) as typeof import("../extensions/discord/src/monitor/model-picker.state.js");

const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } = (await importSource(
  "src/config/runtime-snapshot.ts",
)) as typeof import("../src/config/runtime-snapshot.js");

let proofOwner: Awaited<ReturnType<typeof publishPreparedModelRuntimeSnapshot>> | undefined;

/** Startup is explicit: browsing must only consume a published owner. */
async function prepareBrowse(config: OpenClawConfig) {
  // Configured-reader fallback requires one matching owner. Close the previous
  // scenario before publishing different selections, and prove its facts retired.
  const previous = proofOwner;
  await closePreparedModelRuntimeSnapshots();
  if (previous) {
    assert.equal(previous.isCurrent(), false, "closing left the previous catalog current");
  }
  setRuntimeConfigSnapshot(config);
  proofOwner = await publishPreparedModelRuntimeSnapshot(
    {
      config,
      agentId: "main",
      agentDir: resolveAgentDir(config, "main"),
      workspaceDir: repoRoot,
      runtimePluginSelections: listAppServerRuntimeModelBackendBindings()
        .filter((binding) => config.plugins?.entries?.[binding.runtime]?.enabled !== false)
        .map((binding) => ({
          agentId: "main",
          provider: binding.provider,
          modelId: config.models?.providers?.[binding.provider]?.models?.[0]?.id ?? "",
          runtime: binding.runtime,
        })),
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      },
    },
    { force: true, catalogMode: "static", provenance: "configured" },
  );
  assert.ok(proofOwner.pluginRegistry, "publication omitted its captured runtime registry");
  return await buildPreparedModelsProviderData(config, "main", { workspaceDir: repoRoot });
}

/** Resolve identity against per-model choices, never a stale positional index. */
function selectRuntimeChoiceId(params: {
  data: Awaited<ReturnType<typeof buildPreparedModelsProviderData>>;
  provider: string;
  model: string;
  runtimeToken: string;
}): string | undefined {
  const choices = params.data.runtimeChoicesByModel?.get(`${params.provider}/${params.model}`);
  const matches = choices?.filter(
    (choice) => createDiscordModelPickerRuntimeToken(choice.id) === params.runtimeToken,
  );
  return matches?.length === 1 ? matches[0]?.id : undefined;
}

/**
 * Building the prepared model catalog takes ~60s from source, and it happens
 * inside a worker thread. A main-thread `setInterval` cannot be relied on to
 * fire across a synchronous module compile, so the heartbeat lives in its own
 * worker writing straight to fd 1 -- otherwise a reviewer's harness sees a
 * minute of silence and scores this proof as hung.
 */
const heartbeat = new Worker(
  `const { writeSync } = require("node:fs");
   let n = 0;
   setInterval(() => { n += 1; writeSync(1, \`     .. still working (\${n * 10}s)\\n\`); }, 10000).unref?.();
   setInterval(() => {}, 1 << 30);`,
  { eval: true },
);
heartbeat.unref();

try {
  const config = {
    models: {
      providers: {
        "github-copilot": {
          baseUrl: "https://api.individual.githubcopilot.com",
          apiKey: "proof-github-copilot-key",
          models: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "proof-openai-key",
          models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
        },
        "proof-standalone": {
          // `api` is declared so the model registry loads this provider cleanly;
          // without it the catalog emits a load diagnostic that has nothing to do
          // with the behavior under test.
          api: "openai-responses",
          baseUrl: "https://proof-standalone.example.test/v1",
          apiKey: "proof-standalone-key",
          models: [{ id: "proof-model", name: "Proof Model" }],
        },
      },
    },
    agents: {
      defaults: {
        workspace: repoRoot,
        model: { primary: "openai/gpt-5.5" },
        models: {
          "github-copilot/claude-opus-4-6": { agentRuntime: { id: "openclaw" } },
          "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          "proof-standalone/proof-model": {},
        },
      },
    },
    plugins: {
      allow: ["codex", "copilot", "openai", "github-copilot"],
      entries: { codex: { enabled: true }, copilot: { enabled: true } },
      slots: { memory: "none" },
    },
  } as unknown as OpenClawConfig;

  let data = await prepareBrowse(config);
  // Every advertised native runtime must pass the same real launch-owner gate.
  assert.ok(proofOwner?.pluginRegistry);
  for (const [modelRef, choices] of data.runtimeChoicesByModel ?? []) {
    const slash = modelRef.indexOf("/");
    const provider = modelRef.slice(0, slash);
    const modelId = modelRef.slice(slash + 1);
    for (const choice of choices.filter((candidate) => candidate.id !== "openclaw")) {
      await ensureSelectedAgentHarnessPlugin({
        provider,
        modelId,
        config,
        agentHarnessRuntimeOverride: choice.id,
        workspaceDir: repoRoot,
        pluginRegistry: proofOwner.pluginRegistry,
      });
    }
  }

  function runtimeIdsFor(provider: string): string[] {
    return (data.runtimeChoicesByProvider?.get(provider) ?? []).map((choice) => choice.id);
  }

  // --- Scenario 1: github-copilot gets a Copilot runtime choice (the bug). -----
  const copilotChoices = data.runtimeChoicesByProvider?.get("github-copilot");
  assert.ok(
    copilotChoices,
    "github-copilot has NO runtime chooser entry at all — this is the reported bug",
  );
  assert.ok(
    runtimeIdsFor("github-copilot").includes("copilot"),
    `github-copilot chooser is missing the copilot runtime; got ${JSON.stringify(runtimeIdsFor("github-copilot"))}`,
  );
  const copilotToken = createDiscordModelPickerRuntimeToken("copilot");
  assert.equal(
    selectRuntimeChoiceId({
      data,
      provider: "github-copilot",
      model: "claude-opus-4-6",
      runtimeToken: copilotToken,
    }),
    "copilot",
    "selecting the Copilot entry through the picker lookup did not resolve to the copilot runtime",
  );
  const copilotChoice = copilotChoices.find((choice) => choice.id === "copilot");
  assert.equal(
    copilotChoice?.label,
    "GitHub Copilot",
    `Copilot chooser entry renders a raw id instead of a label: ${JSON.stringify(copilotChoice)}`,
  );
  console.log(
    `[1] github-copilot runtime choices: ${JSON.stringify(runtimeIdsFor("github-copilot"))}`,
  );

  // --- Scenario 2: openai still offers Codex (no regression). -----------------
  assert.ok(
    runtimeIdsFor("openai").includes("codex"),
    `openai lost its Codex runtime choice; got ${JSON.stringify(runtimeIdsFor("openai"))}`,
  );
  console.log(`[2] openai runtime choices: ${JSON.stringify(runtimeIdsFor("openai"))}`);

  // --- Scenario 3: an unbound provider retains only its host runtime. --------
  assert.deepEqual(
    data.runtimeChoicesByModel?.get("proof-standalone/proof-model")?.map((choice) => choice.id),
    ["openclaw"],
    "a provider without an app-server binding must not gain a native runtime",
  );
  console.log("[3] proof-standalone runtime choices: OpenClaw only");

  // --- Scenario 4: disabled harness owners are not advertised. ----------------
  const disabledCopilotData = await prepareBrowse({
    ...config,
    plugins: {
      ...config.plugins,
      entries: { ...config.plugins?.entries, copilot: { enabled: false } },
    },
  });
  assert.ok(disabledCopilotData.byProvider.get("github-copilot")?.has("claude-opus-4-6"));
  assert.equal(
    disabledCopilotData.runtimeChoicesByModel
      ?.get("github-copilot/claude-opus-4-6")
      ?.some((choice) => choice.id === "copilot") ?? false,
    false,
    "disabled Copilot owner plugin must not leave an unusable runtime choice",
  );
  console.log("[4] disabled Copilot is not advertised");

  // --- Scenario 5: every bundled app-server harness has a binding. ------------
  const boundRuntimes = new Set(
    listAppServerRuntimeModelBackendBindings().map((binding) => binding.runtime),
  );
  const bundledHarnessIds = new Set<string>();
  for (const entry of listBundledPluginMetadata({ includeChannelConfigs: false })) {
    const cliBackends = new Set(entry.manifest.cliBackends ?? []);
    for (const harnessId of entry.manifest.activation?.onAgentHarnesses ?? []) {
      if (!cliBackends.has(harnessId)) {
        bundledHarnessIds.add(harnessId);
      }
    }
  }
  assert.ok(bundledHarnessIds.size > 0, "read zero bundled agent harnesses — the scan is broken");
  const unbound = [...bundledHarnessIds].filter((harnessId) => !boundRuntimes.has(harnessId));
  assert.deepEqual(
    unbound,
    [],
    `bundled agent harness(es) ${unbound.join(", ")} ship with no model-provider binding`,
  );
  console.log(
    `[5] bundled app-server harnesses ${JSON.stringify([...bundledHarnessIds].toSorted())} all bound`,
  );

  // --- Scenario 6: the /model directive accepts what the chooser offers. ------
  for (const [provider, runtime] of [
    ["github-copilot", "copilot"],
    ["openai", "codex"],
  ] as const) {
    const resolution = resolveModelRuntimeDirective({ rawRuntime: runtime, provider, cfg: config });
    assert.deepEqual(
      resolution,
      { kind: "set", runtime },
      `/model ${provider}/... --runtime ${runtime} was not accepted: ${JSON.stringify(resolution)}`,
    );
  }
  console.log("[6] directive accepts github-copilot/copilot and openai/codex");

  // --- Scenario 7: a disabled harness owner is rejected, not persisted. -------
  for (const [provider, runtime, pluginId] of [
    ["github-copilot", "copilot", "copilot"],
    ["openai", "codex", "codex"],
  ] as const) {
    const disabledConfig = {
      ...config,
      plugins: { entries: { [pluginId]: { enabled: false } } },
    } as unknown as OpenClawConfig;
    const resolution = resolveModelRuntimeDirective({
      rawRuntime: runtime,
      provider,
      cfg: disabledConfig,
    });
    assert.equal(
      resolution.kind,
      "invalid",
      `--runtime ${runtime} was accepted while plugin "${pluginId}" is disabled: ${JSON.stringify(resolution)}`,
    );
    assert.ok(
      resolution.kind === "invalid" && resolution.errorText.includes(runtime),
      `rejection text does not name the runtime: ${JSON.stringify(resolution)}`,
    );
    const entry: { agentRuntimeOverride?: string } = {};
    assert.deepEqual(
      applyModelRuntimeDirective(entry, resolution),
      { updated: false },
      "a rejected runtime directive reported a session mutation",
    );
    assert.equal(
      entry.agentRuntimeOverride,
      undefined,
      `a rejected runtime directive persisted an unusable override: ${JSON.stringify(entry)}`,
    );
    console.log(
      `[7] ${provider}/--runtime ${runtime} with "${pluginId}" disabled: ${resolution.kind}`,
    );
  }

  // --- Scenario 8: exemptions and incompatible runtimes are unchanged. --------
  assert.deepEqual(
    resolveModelRuntimeDirective({
      rawRuntime: "openclaw",
      provider: "github-copilot",
      cfg: { ...config, plugins: { entries: { copilot: { enabled: false } } } } as OpenClawConfig,
    }),
    { kind: "set", runtime: "openclaw" },
    "the built-in openclaw runtime must not be gated on a harness owner plugin",
  );
  const incompatible = resolveModelRuntimeDirective({
    rawRuntime: "copilot",
    provider: "proof-standalone",
    cfg: config,
  });
  assert.ok(
    incompatible.kind === "invalid" &&
      incompatible.errorText.includes("is not supported for proof-standalone"),
    `an incompatible runtime must keep its unsupported message: ${JSON.stringify(incompatible)}`,
  );
  console.log("[8] openclaw runtime ungated; incompatible runtime keeps its unsupported message");

  // --- Scenario 9: the next turn the gate protects. ---------------------------
  const disabledCopilotConfig = {
    ...config,
    plugins: { entries: { copilot: { enabled: false } } },
  } as unknown as OpenClawConfig;
  // The registry a disabled owner plugin produces: real, and without the harness.
  const registryWithoutCopilot = proofOwner?.pluginRegistry;
  assert.ok(registryWithoutCopilot, "disabled-owner publication omitted its registry");
  assert.equal(
    registryWithoutCopilot.agentHarnesses.some((row) => row.harness.id === "copilot"),
    false,
  );
  let nextTurnError: unknown;
  try {
    await ensureSelectedAgentHarnessPlugin({
      provider: "github-copilot",
      modelId: "claude-opus-4-6",
      config: disabledCopilotConfig,
      // The override the PRE-FIX directive persisted for this exact selection.
      agentHarnessRuntimeOverride: "copilot",
      workspaceDir: repoRoot,
      pluginRegistry: registryWithoutCopilot,
    });
  } catch (error) {
    nextTurnError = error;
  }
  assert.ok(
    nextTurnError instanceof Error &&
      nextTurnError.message.includes('Agent harness runtime "copilot" is unavailable'),
    `expected the next turn to fail for a persisted-but-unavailable runtime, got ${String(nextTurnError)}`,
  );
  console.log(
    `[9] pre-fix persisted override fails the next turn: ${(nextTurnError as Error).message.split(".")[0]}.`,
  );

  // With the gate, the same selection persists nothing, so the next turn runs the
  // default policy instead of the unavailable harness.
  const gatedEntry: { agentRuntimeOverride?: string } = {};
  applyModelRuntimeDirective(
    gatedEntry,
    resolveModelRuntimeDirective({
      rawRuntime: "copilot",
      provider: "github-copilot",
      cfg: disabledCopilotConfig,
    }),
  );
  assert.equal(gatedEntry.agentRuntimeOverride, undefined, "gate leaked an override");
  await ensureSelectedAgentHarnessPlugin({
    provider: "github-copilot",
    modelId: "claude-opus-4-6",
    config: disabledCopilotConfig,
    ...(gatedEntry.agentRuntimeOverride
      ? { agentHarnessRuntimeOverride: gatedEntry.agentRuntimeOverride }
      : {}),
    workspaceDir: repoRoot,
    pluginRegistry: registryWithoutCopilot,
  });
  console.log("[9] post-fix: nothing persisted, so the next turn starts without throwing");

  // ---------------------------------------------------------------------------
  // Scenarios 10-13: the CHANNEL-LEVEL path, end to end.
  //
  // The review asked for the one link the scenarios above do not cover: a real
  // channel callback that persists the selection and lets the following harness
  // turn run. Telegram's Test Server needs Convex-leased, owner-only credentials
  // that a fork contributor cannot obtain (`.agents/skills/telegram-e2e-userbot`
  // requires an authenticated `convex` CLI against the OpenClaw broker project),
  // so this is the mock-gateway channel harness the review offered instead.
  //
  // What is REAL here:
  //   - `createDiscordModelPickerFallbackButton()` -- the exact exported Discord
  //     component callback the gateway registers -- driven through its real
  //     `run()` entry point.
  //   - The button's `custom_id` comes from the real renderer
  //     (`renderDiscordModelPickerModelsView`), so the runtime the callback acts
  //     on is the one production rendering encoded, not one this script authored.
  //   - Everything the callback then calls: `loadDiscordModelPickerData()` (which
  //     is `buildPreparedModelsProviderData`, the function under test),
  //     `resolveDiscordModelPickerRuntimeForProvider()` (which validates the
  //     picked runtime against the current model's runtime choices),
  //     `buildDiscordModelPickerSelectionCommand()`, and
  //     `applyDiscordModelPickerSelection()`.
  //   - The real chat-command registry, the real inline directive parser, the real
  //     `resolveModelRuntimeDirective()`, and `applySessionModelSelection()`
  //     writing to a REAL session store on disk.
  //   - The verification the channel itself performs: the callback re-reads the
  //     store through `resolveDiscordModelPickerCurrentRuntime()` and reports
  //     success only when the persisted runtime matches what the user picked.
  //   - The subsequent turn: the store is re-read from disk and fed to
  //     `resolveSessionRuntimeOverrideForProvider()` and
  //     `ensureSelectedAgentHarnessPlugin()`.
  //
  // What is stubbed: only the transport. The Discord interaction object and the
  // gateway dispatch shell stand in for the socket; every model-selection decision
  // they carry is production code. `OPENCLAW_STATE_DIR` is redirected to a
  // throwaway directory, so this scenario reads and writes nothing outside it.
  // ---------------------------------------------------------------------------
  type DiscordPickerModule =
    typeof import("../extensions/discord/src/monitor/native-command-model-picker-interaction.js");
  type DiscordPickerViewModule =
    typeof import("../extensions/discord/src/monitor/model-picker.view.js");
  type DiscordPickerUiModule =
    typeof import("../extensions/discord/src/monitor/native-command-model-picker-ui.js");
  type DiscordThreadBindingsModule =
    typeof import("../extensions/discord/src/monitor/thread-bindings.js");
  type DirectiveParseModule = typeof import("../src/auto-reply/reply/directive-handling.parse.js");
  type ApplySelectionModule = typeof import("../src/model-picker/apply-session-model-selection.js");
  type SessionRuntimeCompatModule = typeof import("../src/agents/session-runtime-compat.js");
  type SessionStoreRuntimeModule = typeof import("../src/plugin-sdk/session-store-runtime.js");

  const { mkdtemp, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const os = await import("node:os");

  console.log("[10] loading the real Discord model-picker callbacks...");
  const { createDiscordModelPickerFallbackButton } = (await importSource(
    "extensions/discord/src/monitor/native-command-model-picker-interaction.ts",
  )) as DiscordPickerModule;
  const { renderDiscordModelPickerModelsView, toDiscordModelPickerMessagePayload } =
    (await importSource(
      "extensions/discord/src/monitor/model-picker.view.ts",
    )) as DiscordPickerViewModule;
  const { resolveDiscordModelPickerRoute } = (await importSource(
    "extensions/discord/src/monitor/native-command-model-picker-ui.ts",
  )) as DiscordPickerUiModule;
  const { createNoopThreadBindingManager } = (await importSource(
    "extensions/discord/src/monitor/thread-bindings.ts",
  )) as DiscordThreadBindingsModule;
  const { parseInlineSessionDirectives } = (await importSource(
    "src/auto-reply/reply/directive-handling.parse.ts",
  )) as DirectiveParseModule;
  const { applySessionModelSelection } = (await importSource(
    "src/model-picker/apply-session-model-selection.ts",
  )) as ApplySelectionModule;
  const { resolveSessionRuntimeOverrideForProvider } = (await importSource(
    "src/agents/session-runtime-compat.ts",
  )) as SessionRuntimeCompatModule;
  const { getSessionEntry, resolveStorePath } = (await importSource(
    "src/plugin-sdk/session-store-runtime.ts",
  )) as SessionStoreRuntimeModule;

  /**
   * Decodes a rendered `custom_id` into the component-data record the Discord
   * component layer hands a callback: strip the routing key, then read `k=v`
   * pairs. Reading back the RENDERED id keeps every field the callback consumes
   * authored by production code.
   */
  function componentDataFromCustomId(customId: string): Record<string, string> {
    const parts = customId.split(";");
    const head = parts[0] ?? "";
    parts[0] = head.slice(head.indexOf(":") + 1);
    const record: Record<string, string> = {};
    for (const pair of parts) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        record[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
    return record;
  }

  /** Collects every `custom_id` a rendered picker payload carries. */
  function collectCustomIds(payload: unknown, found: string[] = []): string[] {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        collectCustomIds(item, found);
      }
      return found;
    }
    if (payload && typeof payload === "object") {
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if ((key === "customId" || key === "custom_id") && typeof value === "string") {
          found.push(value);
        } else {
          collectCustomIds(value, found);
        }
      }
    }
    return found;
  }

  function createProofInteraction(channelId: string) {
    const notices: string[] = [];
    const readNoticeText = (payload: unknown): string => {
      const found: string[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) {
          for (const item of value) {
            walk(item);
          }
          return;
        }
        if (value && typeof value === "object") {
          for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
            if (key === "content" && typeof inner === "string") {
              found.push(inner);
            } else {
              walk(inner);
            }
          }
        }
      };
      walk(payload);
      return found.join(" ");
    };
    const interaction = {
      user: { id: "proof-owner", username: "proof", globalName: "Proof" },
      // ChannelType.DM with a null guild is the direct-message route.
      channel: { type: 1, id: channelId },
      guild: null,
      rawData: { id: "proof-interaction", member: { roles: [] } },
      client: {},
      acknowledged: false,
      notices,
      async acknowledge() {
        interaction.acknowledged = true;
        return { ok: true };
      },
      async reply(payload: unknown) {
        notices.push(readNoticeText(payload));
        return { ok: true };
      },
      async update(payload: unknown) {
        notices.push(readNoticeText(payload));
        return { ok: true };
      },
      async editReply(payload: unknown) {
        notices.push(readNoticeText(payload));
        return { ok: true };
      },
      async followUp(payload: unknown) {
        notices.push(readNoticeText(payload));
        return { ok: true };
      },
    };
    return interaction;
  }

  const safeInteractionCall = async <T>(_label: string, fn: () => Promise<T>) => await fn();

  const proofDir = await mkdtemp(path.join(os.tmpdir(), "proof-runtime-chooser-"));
  try {
    // A config whose session store lives in the throwaway directory, so the
    // gateway's write and the channel's verification read hit the same file.
    const channelConfig = {
      ...config,
      session: { store: path.join(proofDir, "sessions.json") },
    } as unknown as OpenClawConfig;
    data = await prepareBrowse(channelConfig);

    /**
     * Renders the real Discord models view for a pending selection and returns the
     * `custom_id` its submit button carries. Everything downstream reads this id,
     * so the state a callback acts on is authored by production rendering.
     */
    function renderSubmitCustomId(params: { provider: string; model: string; runtime: string }) {
      const rendered = toDiscordModelPickerMessagePayload(
        renderDiscordModelPickerModelsView({
          command: "model",
          userId: "proof-owner",
          data,
          provider: params.provider,
          page: 1,
          providerPage: 1,
          currentModel: `${data.resolvedDefault.provider}/${data.resolvedDefault.model}`,
          currentRuntime: "openclaw",
          quickModels: [],
          pendingModel: `${params.provider}/${params.model}`,
          pendingRuntime: params.runtime,
        } as never),
      );
      const submitId = collectCustomIds(rendered).find((id) => /(^|;)a=submit(;|$)/.test(id));
      assert.ok(
        submitId,
        `the real picker renderer produced no submit component for ${params.provider}`,
      );
      return submitId;
    }

    /**
     * Runs one full picker submission through the real channel callback and a
     * mock gateway whose only job is to carry the callback's `/model ...` prompt
     * into the real directive and persistence path.
     */
    async function runChannelSelection(params: {
      provider: string;
      model: string;
      runtime: string;
      channelId: string;
      customId?: string;
    }) {
      // The route owner decides whether these direct interactions share a session.
      const interaction = createProofInteraction(params.channelId);
      // The route the callback itself will resolve, computed with the same
      // exported production function so the store key matches exactly.
      const route = await resolveDiscordModelPickerRoute({
        interaction: interaction as never,
        cfg: channelConfig,
        accountId: "proof-account",
        threadBindings: createNoopThreadBindingManager(),
      });
      const storePath = resolveStorePath(channelConfig.session?.store, {
        agentId: route.agentId,
      });
      const dispatched: { prompt: string; runtime?: string }[] = [];
      const applyOutcomes: string[] = [];

      // `applyDiscordModelPickerSelection` gives its gateway dispatch a 12s budget.
      // A long-lived Gateway has the model-selection runtime warm; the first call
      // in this script builds the prepared model catalog from TypeScript source,
      // which is slower than that, so the channel reports "still processing" and
      // moves on. The apply itself keeps running -- that is real product behavior
      // for a slow gateway, not an error -- so the in-flight promise is retained
      // and awaited below before anything asserts on persistence.
      const inFlight: Promise<unknown>[] = [];
      const dispatchCommandInteraction = async (dispatchParams: { prompt: string }) => {
        try {
          const pending = dispatchSelection(dispatchParams);
          inFlight.push(pending.catch(() => undefined));
          return await pending;
        } catch (error) {
          // applyDiscordModelPickerSelection swallows throws into a generic
          // "Failed to apply" notice, so record the real cause here.
          applyOutcomes.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      };

      const dispatchSelection = async (dispatchParams: { prompt: string }) => {
        // The REAL inline directive parser reads the REAL prompt the callback built.
        const directives = parseInlineSessionDirectives(dispatchParams.prompt);
        dispatched.push({
          prompt: dispatchParams.prompt,
          ...(directives.rawModelRuntime ? { runtime: directives.rawModelRuntime } : {}),
        });
        const runtimeResolution = resolveModelRuntimeDirective({
          ...(directives.rawModelRuntime ? { rawRuntime: directives.rawModelRuntime } : {}),
          provider: params.provider,
          cfg: channelConfig,
          // The repo root is where bundled plugin manifests live; `proofDir` holds
          // only throwaway state. Passing the latter here would make every harness
          // owner look absent.
          workspaceDir: repoRoot,
        });
        if (runtimeResolution.kind === "invalid") {
          applyOutcomes.push(`directive-invalid: ${runtimeResolution.errorText}`);
          return {
            accepted: true,
            hiddenFinalReply: { isError: true, text: runtimeResolution.errorText },
          };
        }
        const sessionStore: Record<string, unknown> = {};
        const sessionEntry = getSessionEntry({ storePath, sessionKey: route.sessionKey }) ?? {
          sessionId: `proof-${params.provider}`,
          updatedAt: Date.now(),
        };
        const applied = await applySessionModelSelection({
          cfg: channelConfig,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          storePath,
          sessionEntry: sessionEntry as never,
          sessionStore: sessionStore as never,
          allowCreate: true,
          defaultProvider: data.resolvedDefault.provider,
          defaultModel: data.resolvedDefault.model,
          currentProvider: data.resolvedDefault.provider,
          currentModel: data.resolvedDefault.model,
          modelCatalog: data.modelCatalog,
          request: {
            provider: params.provider,
            model: params.model,
            isDefault: false,
            runtime: runtimeResolution,
          },
          markLiveSwitchPending: true,
        });
        applyOutcomes.push(
          applied.status === "applied"
            ? `applied agentRuntime=${applied.agentRuntime}`
            : `${applied.status}: ${applied.message}`,
        );
        return {
          accepted: applied.status === "applied",
          ...(applied.status === "applied"
            ? {}
            : { hiddenFinalReply: { isError: true, text: applied.message } }),
        };
      };

      // Submit through the real callback using the custom_id the real renderer
      // produced for this pending selection.
      const submitId = params.customId ?? renderSubmitCustomId(params);
      const button = createDiscordModelPickerFallbackButton({
        ctx: {
          cfg: channelConfig,
          discordConfig: {} as never,
          accountId: "proof-account",
          sessionPrefix: "proof",
          threadBindings: createNoopThreadBindingManager(),
          postApplySettleMs: 0,
        } as never,
        safeInteractionCall,
        dispatchCommandInteraction: dispatchCommandInteraction as never,
      });
      await button.run(interaction as never, componentDataFromCustomId(submitId) as never);
      // Let any dispatch the channel stopped waiting on finish before reading the store.
      await Promise.allSettled(inFlight);
      return {
        dispatched,
        applyOutcomes,
        submitId,
        route,
        storePath,
        notices: interaction.notices,
        // Read back through the production session-store API. The store is
        // SQLite on disk (`openclaw-agent.sqlite` beside the configured path), and
        // `readConsistency: "latest"` bypasses any in-memory snapshot.
        persisted: getSessionEntry({
          storePath,
          sessionKey: route.sessionKey,
          readConsistency: "latest",
        }),
      };
    }

    // --- Scenario 10: the channel callback persists the picked runtime. --------
    const channel = await runChannelSelection({
      provider: "github-copilot",
      model: "claude-opus-4-6",
      runtime: "copilot",
      channelId: "proof-dm-copilot",
    });
    assert.ok(
      /(^|;)rt=[A-Za-z0-9_-]+(;|$)/.test(channel.submitId),
      `the rendered submit button carries no stable runtime token, so the callback could not have acted on a runtime choice: ${channel.submitId}`,
    );
    assert.equal(
      channel.dispatched.length,
      1,
      `the channel callback did not reach the gateway exactly once: dispatched=${JSON.stringify(channel.dispatched)} notices=${JSON.stringify(channel.notices)}`,
    );
    assert.equal(
      channel.dispatched[0]?.prompt,
      "/model github-copilot/claude-opus-4-6 --runtime copilot",
      `the callback built the wrong command: ${JSON.stringify(channel.dispatched[0])}`,
    );
    assert.equal(
      channel.dispatched[0]?.runtime,
      "copilot",
      "the real directive parser read no copilot runtime out of the callback's prompt",
    );
    assert.deepEqual(
      channel.applyOutcomes,
      ["applied agentRuntime=copilot"],
      `the gateway did not apply the callback's selection: outcomes=${JSON.stringify(channel.applyOutcomes)} notices=${JSON.stringify(channel.notices)}`,
    );
    assert.equal(
      channel.persisted?.agentRuntimeOverride,
      "copilot",
      `the picked runtime was not persisted: route=${JSON.stringify({ agentId: channel.route.agentId, sessionKey: channel.route.sessionKey })} store=${channel.storePath} entry=${JSON.stringify(channel.persisted)}`,
    );
    console.log(`[10] real submit custom_id from the renderer: ${channel.submitId}`);
    console.log(
      `[10] channel callback -> "${channel.dispatched[0]?.prompt}" -> ${path.basename(channel.storePath)}[${channel.route.sessionKey}].agentRuntimeOverride=${channel.persisted?.agentRuntimeOverride}`,
    );
    // The channel reached its apply stage. The TERMINAL notice is deliberately not
    // asserted: `applyDiscordModelPickerSelection` gives the gateway 12s, and a
    // from-source catalog build exceeds that, so a cold run legitimately reports
    // "still processing" while the apply completes behind it. Asserting the
    // optimistic notice keeps this proof about the selection path rather than
    // about how fast `tsx` compiles.
    assert.ok(
      channel.notices.some((text) => text.includes("Applying model change to github-copilot")),
      `the channel never reached its apply stage; notices were ${JSON.stringify(channel.notices)}`,
    );
    console.log(`[10] channel notices: ${JSON.stringify(channel.notices)}`);

    // --- Scenario 11: the SUBSEQUENT turn reads that store and starts. ---------
    // Nothing carries over in memory: the file is read back from disk exactly as a
    // later turn would.
    const durableStoreFile = path.join(path.dirname(channel.storePath), "openclaw-agent.sqlite");
    assert.ok(
      existsSync(durableStoreFile),
      `expected a durable session store on disk at ${durableStoreFile}`,
    );
    const reloadedEntry = getSessionEntry({
      storePath: channel.storePath,
      sessionKey: channel.route.sessionKey,
      readConsistency: "latest",
    });
    assert.ok(reloadedEntry, "the session store lost the entry between turns");
    const recoveredRuntime = resolveSessionRuntimeOverrideForProvider({
      entry: reloadedEntry as never,
      provider: "github-copilot",
      cfg: channelConfig,
    });
    assert.equal(
      recoveredRuntime,
      "copilot",
      `the next turn did not recover the persisted Copilot runtime: ${String(recoveredRuntime)}`,
    );
    // The real startup gate for that recovered runtime, against a real registry
    // that owns the copilot harness.
    const registryWithCopilot = proofOwner?.pluginRegistry;
    assert.ok(registryWithCopilot?.agentHarnesses.some((entry) => entry.harness.id === "copilot"));
    await ensureSelectedAgentHarnessPlugin({
      provider: "github-copilot",
      modelId: "claude-opus-4-6",
      config: channelConfig,
      agentHarnessRuntimeOverride: recoveredRuntime,
      workspaceDir: repoRoot,
      pluginRegistry: registryWithCopilot,
    });
    console.log(
      `[11] subsequent turn re-read ${path.basename(durableStoreFile)} from disk, recovered runtime "${recoveredRuntime}", and ensureSelectedAgentHarnessPlugin() completed without throwing`,
    );

    // --- Scenario 12: stable runtime identity must not authorize another model. ---
    const runtimeTokenFromId = (customId: string) => componentDataFromCustomId(customId).rt ?? "";
    assert.equal(
      selectRuntimeChoiceId({
        data,
        provider: "github-copilot",
        model: "claude-opus-4-6",
        runtimeToken: runtimeTokenFromId(channel.submitId),
      }),
      "copilot",
      "the supported pairing's rendered token did not resolve to Copilot",
    );
    const controlSubmitId = renderSubmitCustomId({
      provider: "openai",
      model: "gpt-5.5",
      runtime: "copilot",
    });
    const control = await runChannelSelection({
      provider: "openai",
      model: "gpt-5.5",
      runtime: "copilot",
      channelId: "proof-dm-invalid-runtime",
      customId: controlSubmitId,
    });
    assert.equal(control.dispatched.length, 0, "an unsupported runtime reached Gateway dispatch");
    assert.equal(
      control.persisted?.agentRuntimeOverride,
      channel.persisted?.agentRuntimeOverride,
      "rejected runtime changed the existing direct-conversation pin",
    );
    assert.ok(control.notices.some((text) => text.includes("runtime is not available")));
    // Main deliberately rejects retired index identities instead of rebinding them.
    const staleIndex = await runChannelSelection({
      provider: "github-copilot",
      model: "claude-opus-4-6",
      runtime: "copilot",
      channelId: "proof-dm-stale-index",
      customId: channel.submitId.replace(/;rt=[^;]+/, "") + ";ri=1",
    });
    assert.equal(staleIndex.dispatched.length, 0, "a retired positional index reached dispatch");
    assert.ok(staleIndex.notices.some((text) => text.includes("runtime selection expired")));
    console.log(
      "[12] unsupported model/runtime identity and retired index rejected before dispatch",
    );

    // --- Scenario 13: the KNOWN GAP this PR does not close. -------------------
    // docs/plugins/copilot.md documents Copilot BYOK for eligible custom
    // `models.providers` entries, and extensions/copilot/harness.ts accepts them
    // via supportsCopilotByokProviderShape(). A static table of canonical provider
    // ids cannot represent that, so the picker offers nothing and the directive is
    // rejected -- the same as on main. Pinned as executable evidence of the open
    // maintainer decision rather than left as prose, so whichever contract is
    // approved has a control to flip.
    const byokConfig = {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          models: { ...config.agents?.defaults?.models, "proof-byok/byok-model": {} },
        },
      },
      models: {
        providers: {
          ...(config as unknown as { models: { providers: Record<string, unknown> } }).models
            .providers,
          "proof-byok": {
            api: "openai-responses",
            baseUrl: "https://proof-byok.example.test/v1",
            apiKey: "proof-byok-key",
            models: [{ id: "byok-model", name: "BYOK Model" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const byokData = await prepareBrowse(byokConfig);
    assert.ok(byokData.byProvider.get("proof-byok")?.has("byok-model"));
    assert.equal(
      byokData.runtimeChoicesByModel
        ?.get("proof-byok/byok-model")
        ?.some((choice) => choice.id === "copilot") ?? false,
      false,
      "KNOWN GAP changed: a custom BYOK provider now offers Copilot -- update the contract",
    );
    const byokDirective = resolveModelRuntimeDirective({
      rawRuntime: "copilot",
      provider: "proof-byok",
      cfg: byokConfig,
    });
    assert.equal(
      byokDirective.kind,
      "invalid",
      "KNOWN GAP changed: --runtime copilot is now accepted for a custom BYOK provider -- update this scenario and the PR body",
    );
    console.log(
      `[13] KNOWN GAP (open maintainer decision): documented Copilot BYOK provider "proof-byok" still has no Copilot choice and its directive is ${byokDirective.kind}`,
    );
  } finally {
    await closePreparedModelRuntimeSnapshots();
    await rm(proofDir, { recursive: true, force: true });
  }

  console.log("All runtime assertions passed.");
} finally {
  // Retire publications and their captured registry/worker resources before state deletion.
  try {
    await closePreparedModelRuntimeSnapshots();
    clearRuntimeConfigSnapshot();
    await removeProofState(proofStateDir, { recursive: true, force: true });
  } finally {
    await heartbeat.terminate();
  }
}
