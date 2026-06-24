// Mattermost plugin module implements model picker behavior.
import { createHash } from "node:crypto";
import {
  resolveStoredModelOverride,
  type ModelsProviderData,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { loadSessionStore, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MattermostChannel } from "./client.js";
import {
  generateInteractionToken,
  verifyInteractionToken,
  type MattermostInteractiveButtonInput,
} from "./interactions.js";

const MATTERMOST_MODEL_PICKER_CONTEXT_KEY = "oc_model_picker";
export const MATTERMOST_MODEL_PICKER_DIALOG_CALLBACK_ID = "oc_model_picker";
export const MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT = "__keep_current_runtime__";
const MODELS_PAGE_SIZE = 8;
const ACTION_IDS = {
  providers: "mdlprov",
  list: "mdllist",
  select: "mdlsel",
  back: "mdlback",
} as const;

type MattermostModelPickerEntry =
  | { kind: "summary" }
  | { kind: "providers" }
  | { kind: "models"; provider: string };

type MattermostModelPickerState =
  | { action: "providers"; ownerUserId: string }
  | { action: "back"; ownerUserId: string }
  | { action: "list"; ownerUserId: string; provider: string; page: number }
  | { action: "select"; ownerUserId: string; provider: string; page: number; model: string };

type MattermostModelPickerRenderedView = {
  text: string;
  buttons: MattermostInteractiveButtonInput[][];
};

type MattermostModelPickerDialogStatePayload = {
  v: 1;
  ownerUserId: string;
  channelId: string;
  teamId?: string;
  channelSnapshot?: MattermostModelPickerDialogChannelSnapshot;
};

type MattermostModelPickerDialogStateSigned = MattermostModelPickerDialogStatePayload & {
  _token: string;
};

type MattermostModelPickerDialogChannelSnapshot = {
  type: string;
  name?: string;
  displayName?: string;
};

type MattermostDialogSelectOption = {
  text: string;
  value: string;
};

function normalizeMattermostModelPickerDialogChannelSnapshot(
  value: unknown,
): MattermostModelPickerDialogChannelSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const typed = value as Partial<MattermostModelPickerDialogChannelSnapshot>;
  const type = normalizeOptionalString(typed.type)?.toUpperCase();
  if (!type) {
    return undefined;
  }
  const name = normalizeOptionalString(typed.name);
  const displayName = normalizeOptionalString(typed.displayName);
  return {
    type,
    ...(name ? { name } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function buildMattermostModelPickerDialogChannelSnapshot(
  channelInfo?: MattermostChannel | null,
): MattermostModelPickerDialogChannelSnapshot | undefined {
  return normalizeMattermostModelPickerDialogChannelSnapshot({
    type: channelInfo?.type,
    name: channelInfo?.name,
    displayName: channelInfo?.display_name,
  });
}

export type MattermostInteractiveDialogElement = {
  display_name: string;
  name: string;
  type: "select";
  default?: string;
  placeholder?: string;
  help_text?: string;
  optional?: boolean;
  options?: MattermostDialogSelectOption[];
  refresh?: boolean;
};

export type MattermostInteractiveDialog = {
  callback_id: string;
  title: string;
  introduction_text?: string;
  elements: MattermostInteractiveDialogElement[];
  submit_label?: string;
  notify_on_cancel?: boolean;
  state: string;
  source_url?: string;
};

function splitModelRef(modelRef?: string | null): { provider: string; model: string } | null {
  const trimmed = normalizeOptionalString(modelRef);
  const match = trimmed?.match(/^([^/]+)\/(.+)$/u);
  if (!match) {
    return null;
  }
  const provider = normalizeProviderId(match[1]);
  // Mattermost copy should normalize accidental whitespace around the model.
  const model = normalizeOptionalString(match[2]);
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function readContextString(context: Record<string, unknown>, key: string, fallback = ""): string {
  const value = context[key];
  return typeof value === "string" ? value : fallback;
}

function readContextNumber(context: Record<string, unknown>, key: string): number | undefined {
  const value = context[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return parseStrictInteger(value);
  }
  return undefined;
}

function normalizePage(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value as number));
}

function paginateItems<T>(items: T[], page?: number, pageSize = MODELS_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(1, Math.min(normalizePage(page), totalPages));
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    totalItems: items.length,
  };
}

function buildContext(state: MattermostModelPickerState): Record<string, unknown> {
  return {
    [MATTERMOST_MODEL_PICKER_CONTEXT_KEY]: true,
    ...state,
  };
}

function buildButtonId(state: MattermostModelPickerState): string {
  const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 12);
  return `${ACTION_IDS[state.action]}${digest}`;
}

function buildButton(params: {
  action: MattermostModelPickerState["action"];
  ownerUserId: string;
  text: string;
  provider?: string;
  page?: number;
  model?: string;
  style?: "default" | "primary" | "danger";
}): MattermostInteractiveButtonInput {
  const baseState =
    params.action === "providers" || params.action === "back"
      ? {
          action: params.action,
          ownerUserId: params.ownerUserId,
        }
      : params.action === "list"
        ? {
            action: "list" as const,
            ownerUserId: params.ownerUserId,
            provider: normalizeProviderId(params.provider ?? ""),
            page: normalizePage(params.page),
          }
        : {
            action: "select" as const,
            ownerUserId: params.ownerUserId,
            provider: normalizeProviderId(params.provider ?? ""),
            page: normalizePage(params.page),
            model: normalizeStringifiedOptionalString(params.model) ?? "",
          };

  return {
    // Mattermost requires action IDs to be unique within a post.
    id: buildButtonId(baseState),
    text: params.text,
    ...(params.style ? { style: params.style } : {}),
    context: buildContext(baseState),
  };
}

function getProviderModels(data: ModelsProviderData, provider: string): string[] {
  return [...(data.byProvider.get(normalizeProviderId(provider)) ?? new Set<string>())].toSorted();
}

function formatCurrentModelLine(currentModel?: string): string {
  const parsed = splitModelRef(currentModel);
  if (!parsed) {
    return "Current: default";
  }
  return `Current: ${parsed.provider}/${parsed.model}`;
}

export function resolveMattermostModelPickerEntry(
  commandText: string,
): MattermostModelPickerEntry | null {
  const normalized = commandText.trim().replace(/\s+/g, " ");
  if (/^\/model$/i.test(normalized)) {
    return { kind: "summary" };
  }
  if (/^\/models$/i.test(normalized)) {
    return { kind: "providers" };
  }
  const providerMatch = normalized.match(/^\/models\s+(\S+)$/i);
  if (!providerMatch?.[1]) {
    return null;
  }
  return {
    kind: "models",
    provider: normalizeProviderId(providerMatch[1]),
  };
}

export function parseMattermostModelPickerContext(
  context: Record<string, unknown>,
): MattermostModelPickerState | null {
  if (!context || context[MATTERMOST_MODEL_PICKER_CONTEXT_KEY] !== true) {
    return null;
  }

  const ownerUserId = normalizeOptionalString(readContextString(context, "ownerUserId")) ?? "";
  const action = normalizeOptionalString(readContextString(context, "action")) ?? "";
  if (!ownerUserId) {
    return null;
  }

  if (action === "providers" || action === "back") {
    return { action, ownerUserId };
  }

  const provider = normalizeProviderId(readContextString(context, "provider"));
  const page = readContextNumber(context, "page");
  if (!provider) {
    return null;
  }

  if (action === "list") {
    return {
      action,
      ownerUserId,
      provider,
      page: normalizePage(page),
    };
  }

  if (action === "select") {
    const model = normalizeOptionalString(readContextString(context, "model")) ?? "";
    if (!model) {
      return null;
    }
    return {
      action,
      ownerUserId,
      provider,
      page: normalizePage(page),
      model,
    };
  }

  return null;
}

export function buildMattermostAllowedModelRefs(data: ModelsProviderData): Set<string> {
  const refs = new Set<string>();
  for (const provider of data.providers) {
    for (const model of data.byProvider.get(provider) ?? []) {
      refs.add(`${provider}/${model}`);
    }
  }
  return refs;
}

function resolveConfiguredAgentRuntimeId(value: {
  agentRuntime?: { id?: unknown };
}): string | undefined {
  return normalizeOptionalString(value.agentRuntime?.id);
}

function formatRuntimeLabel(runtime?: string): string {
  const normalized = normalizeOptionalString(runtime) ?? "auto";
  return normalized === "auto" || normalized === "default" || normalized === "pi"
    ? "OpenClaw Pi Default"
    : normalized;
}

function encodeDialogState(value: MattermostModelPickerDialogStateSigned): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeDialogState(value: string): MattermostModelPickerDialogStateSigned | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const typed = parsed as Partial<MattermostModelPickerDialogStateSigned>;
    const ownerUserId = normalizeOptionalString(typed.ownerUserId);
    const channelId = normalizeOptionalString(typed.channelId);
    const teamId = normalizeOptionalString(typed.teamId);
    const token = normalizeOptionalString(typed._token);
    const channelSnapshot = normalizeMattermostModelPickerDialogChannelSnapshot(
      typed.channelSnapshot,
    );
    if (typed.v !== 1 || !ownerUserId || !channelId || !token) {
      return null;
    }
    return {
      v: 1,
      ownerUserId,
      channelId,
      ...(teamId ? { teamId } : {}),
      ...(channelSnapshot ? { channelSnapshot } : {}),
      _token: token,
    };
  } catch {
    return null;
  }
}

export function buildMattermostModelPickerDialogState(params: {
  ownerUserId: string;
  channelId: string;
  teamId?: string;
  channelInfo?: MattermostChannel | null;
  accountId?: string;
}): string {
  const channelSnapshot = buildMattermostModelPickerDialogChannelSnapshot(params.channelInfo);
  const payload: MattermostModelPickerDialogStatePayload = {
    v: 1,
    ownerUserId: normalizeOptionalString(params.ownerUserId) ?? "",
    channelId: normalizeOptionalString(params.channelId) ?? "",
    ...(normalizeOptionalString(params.teamId)
      ? { teamId: normalizeOptionalString(params.teamId) }
      : {}),
    ...(channelSnapshot ? { channelSnapshot } : {}),
  };
  if (!payload.ownerUserId || !payload.channelId) {
    throw new Error("Mattermost model picker dialog state requires ownerUserId and channelId");
  }
  const token = generateInteractionToken(payload, params.accountId);
  return encodeDialogState({
    ...payload,
    _token: token,
  });
}

export function parseMattermostModelPickerDialogState(params: {
  state: string;
  accountId?: string;
}): MattermostModelPickerDialogStatePayload | null {
  const decoded = decodeDialogState(params.state);
  if (!decoded) {
    return null;
  }
  const { _token, ...unsigned } = decoded;
  if (!verifyInteractionToken(unsigned, _token, params.accountId)) {
    return null;
  }
  return unsigned;
}

export function resolveMattermostModelPickerDialogChannelInfo(
  state: MattermostModelPickerDialogStatePayload,
): MattermostChannel | null {
  const snapshot = state.channelSnapshot;
  if (!snapshot?.type) {
    return null;
  }
  return {
    id: state.channelId,
    type: snapshot.type,
    ...(snapshot.name ? { name: snapshot.name } : {}),
    ...(snapshot.displayName ? { display_name: snapshot.displayName } : {}),
    ...(state.teamId ? { team_id: state.teamId } : {}),
  };
}

export function resolveMattermostModelPickerCurrentModel(params: {
  cfg: OpenClawConfig;
  route: { agentId: string; sessionKey: string };
  data: ModelsProviderData;
  skipCache?: boolean;
}): string {
  const fallback = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId,
    });
    const sessionStore = params.skipCache
      ? loadSessionStore(storePath, { skipCache: true })
      : loadSessionStore(storePath);
    const sessionEntry = sessionStore[params.route.sessionKey];
    const override = resolveStoredModelOverride({
      sessionEntry,
      sessionStore,
      sessionKey: params.route.sessionKey,
      defaultProvider: params.data.resolvedDefault.provider,
    });
    if (!override?.model) {
      return fallback;
    }
    const provider = (override.provider || params.data.resolvedDefault.provider).trim();
    return provider ? `${provider}/${override.model}` : fallback;
  } catch {
    return fallback;
  }
}

export function resolveMattermostModelPickerCurrentRuntime(params: {
  cfg: OpenClawConfig;
  route: { agentId: string; sessionKey: string };
}): string {
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId,
    });
    const sessionStore = loadSessionStore(storePath, { skipCache: true });
    const sessionRuntime = normalizeOptionalString(
      sessionStore[params.route.sessionKey]?.agentRuntimeOverride,
    );
    if (sessionRuntime) {
      return sessionRuntime;
    }
  } catch {
    // Fall through to configured defaults when the session store is unavailable.
  }

  const agentRuntime = resolveConfiguredAgentRuntimeId(
    params.cfg.agents?.list?.find(
      (entry) => normalizeOptionalString(entry.id) === params.route.agentId,
    ) ?? {},
  );
  if (agentRuntime) {
    return agentRuntime;
  }
  return resolveConfiguredAgentRuntimeId(params.cfg.agents?.defaults ?? {}) ?? "auto";
}

function resolveMattermostModelPickerDialogProvider(params: {
  data: ModelsProviderData;
  currentModel?: string;
  preferredProvider?: string;
}): string {
  const preferred = normalizeProviderId(params.preferredProvider ?? "");
  if (preferred && params.data.byProvider.has(preferred)) {
    return preferred;
  }
  const currentProvider = splitModelRef(params.currentModel)?.provider;
  if (currentProvider && params.data.byProvider.has(currentProvider)) {
    return currentProvider;
  }
  return params.data.providers[0] ?? params.data.resolvedDefault.provider;
}

function resolveMattermostModelPickerRuntimeOptions(params: {
  data: ModelsProviderData;
  provider: string;
  currentRuntime?: string;
}): MattermostDialogSelectOption[] {
  const keepLabel = `Keep current runtime (${formatRuntimeLabel(params.currentRuntime)})`;
  const choices = params.data.runtimeChoicesByProvider?.get(
    normalizeProviderId(params.provider),
  ) ?? [
    {
      id: "pi",
      label: "OpenClaw Pi Default",
      description: "Use the built-in OpenClaw Pi runtime.",
    },
  ];
  const options: MattermostDialogSelectOption[] = [
    {
      text: keepLabel,
      value: MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT,
    },
  ];
  const seen = new Set<string>([MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT]);
  for (const choice of choices) {
    if (seen.has(choice.id)) {
      continue;
    }
    seen.add(choice.id);
    options.push({
      text: choice.label,
      value: choice.id,
    });
  }
  return options;
}

function resolveMattermostModelPickerModelOptions(params: {
  data: ModelsProviderData;
  provider: string;
}): MattermostDialogSelectOption[] {
  return getProviderModels(params.data, params.provider).map((model) => ({
    text: model,
    value: model,
  }));
}

export function resolveMattermostModelPickerDialogValues(params: {
  submission: Record<string, unknown>;
  data: ModelsProviderData;
  currentModel?: string;
  currentRuntime?: string;
}): {
  provider: string;
  model?: string;
  runtimeChoice: string;
  selectedField?: string;
} {
  const provider = resolveMattermostModelPickerDialogProvider({
    data: params.data,
    currentModel: params.currentModel,
    preferredProvider:
      typeof params.submission.provider === "string" ? params.submission.provider : undefined,
  });
  const rawModel = normalizeOptionalString(
    typeof params.submission.model === "string" ? params.submission.model : undefined,
  );
  const model =
    rawModel && params.data.byProvider.get(provider)?.has(rawModel) ? rawModel : undefined;
  const runtimeChoiceRaw = normalizeOptionalString(
    typeof params.submission.runtime === "string" ? params.submission.runtime : undefined,
  );
  const validRuntimeChoices = new Set(
    resolveMattermostModelPickerRuntimeOptions({
      data: params.data,
      provider,
      currentRuntime: params.currentRuntime,
    }).map((option) => option.value),
  );
  const runtimeChoice =
    runtimeChoiceRaw && validRuntimeChoices.has(runtimeChoiceRaw)
      ? runtimeChoiceRaw
      : MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT;
  const selectedField = normalizeOptionalString(
    typeof params.submission.selected_field === "string"
      ? params.submission.selected_field
      : undefined,
  );
  return {
    provider,
    ...(model ? { model } : {}),
    runtimeChoice,
    ...(selectedField ? { selectedField } : {}),
  };
}

export function buildMattermostModelPickerSelectionCommand(params: {
  modelRef: string;
  runtimeChoice?: string;
}): string {
  const runtime = normalizeOptionalString(params.runtimeChoice);
  return runtime && runtime !== MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT
    ? `/model ${params.modelRef} --runtime ${runtime}`
    : `/model ${params.modelRef}`;
}

export function buildMattermostModelPickerDialog(params: {
  accountId?: string;
  ownerUserId: string;
  channelId: string;
  teamId?: string;
  channelInfo?: MattermostChannel | null;
  callbackUrl: string;
  data: ModelsProviderData;
  currentModel?: string;
  currentRuntime?: string;
  preferredProvider?: string;
  selectedModel?: string;
  runtimeChoice?: string;
  state?: string;
}): MattermostInteractiveDialog {
  const provider = resolveMattermostModelPickerDialogProvider({
    data: params.data,
    currentModel: params.currentModel,
    preferredProvider: params.preferredProvider,
  });
  const modelOptions = resolveMattermostModelPickerModelOptions({
    data: params.data,
    provider,
  });
  const selectedModel =
    params.selectedModel && params.data.byProvider.get(provider)?.has(params.selectedModel)
      ? params.selectedModel
      : splitModelRef(params.currentModel)?.provider === provider
        ? splitModelRef(params.currentModel)?.model
        : undefined;
  const currentRuntime = params.currentRuntime ?? "auto";
  const runtimeOptions = resolveMattermostModelPickerRuntimeOptions({
    data: params.data,
    provider,
    currentRuntime,
  });
  const runtimeChoice =
    normalizeOptionalString(params.runtimeChoice) ?? MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT;

  return {
    callback_id: MATTERMOST_MODEL_PICKER_DIALOG_CALLBACK_ID,
    title: "Model Picker",
    introduction_text: `${formatCurrentModelLine(params.currentModel)}\nRuntime: ${formatRuntimeLabel(currentRuntime)}`,
    submit_label: "Apply",
    notify_on_cancel: false,
    state:
      params.state ??
      buildMattermostModelPickerDialogState({
        ownerUserId: params.ownerUserId,
        channelId: params.channelId,
        teamId: params.teamId,
        channelInfo: params.channelInfo,
        accountId: params.accountId,
      }),
    source_url: params.callbackUrl,
    elements: [
      {
        display_name: "Provider",
        name: "provider",
        type: "select",
        default: provider,
        refresh: true,
        help_text: "Choose a provider to refresh the model and runtime fields.",
        options: params.data.providers.map((entry) => ({
          text: `${entry} (${params.data.byProvider.get(entry)?.size ?? 0})`,
          value: entry,
        })),
      },
      {
        display_name: "Model",
        name: "model",
        type: "select",
        ...(selectedModel ? { default: selectedModel } : {}),
        placeholder: `Select ${provider} model`,
        help_text: "Choose the model to apply for this session.",
        options: modelOptions,
      },
      {
        display_name: "Runtime",
        name: "runtime",
        type: "select",
        default: runtimeChoice,
        help_text: "Leave this on keep current runtime unless you want to switch harnesses too.",
        options: runtimeOptions,
      },
    ],
  };
}

export function renderMattermostModelSummaryView(params: {
  ownerUserId: string;
  currentModel?: string;
}): MattermostModelPickerRenderedView {
  return {
    text: [
      formatCurrentModelLine(params.currentModel),
      "",
      "Tap below to browse models, or use:",
      "/oc_model <provider/model> to switch",
      "Browse keeps the current runtime; use /oc_model <provider/model> --runtime <runtime> to switch runtime too",
      "/oc_model status for details",
    ].join("\n"),
    buttons: [
      [
        buildButton({
          action: "providers",
          ownerUserId: params.ownerUserId,
          text: "Browse providers",
          style: "primary",
        }),
      ],
    ],
  };
}

export function renderMattermostProviderPickerView(params: {
  ownerUserId: string;
  data: ModelsProviderData;
  currentModel?: string;
}): MattermostModelPickerRenderedView {
  const currentProvider = splitModelRef(params.currentModel)?.provider;
  const rows = params.data.providers.map((provider) => [
    buildButton({
      action: "list",
      ownerUserId: params.ownerUserId,
      text: `${provider} (${params.data.byProvider.get(provider)?.size ?? 0})`,
      provider,
      page: 1,
      style: provider === currentProvider ? "primary" : "default",
    }),
  ]);

  return {
    text: [formatCurrentModelLine(params.currentModel), "", "Select a provider:"].join("\n"),
    buttons: rows,
  };
}

export function renderMattermostModelsPickerView(params: {
  ownerUserId: string;
  data: ModelsProviderData;
  provider: string;
  page?: number;
  currentModel?: string;
}): MattermostModelPickerRenderedView {
  const provider = normalizeProviderId(params.provider);
  const models = getProviderModels(params.data, provider);
  const current = splitModelRef(params.currentModel);

  if (models.length === 0) {
    return {
      text: [formatCurrentModelLine(params.currentModel), "", `Unknown provider: ${provider}`].join(
        "\n",
      ),
      buttons: [
        [
          buildButton({
            action: "back",
            ownerUserId: params.ownerUserId,
            text: "Back to providers",
          }),
        ],
      ],
    };
  }

  const page = paginateItems(models, params.page);
  const rows: MattermostInteractiveButtonInput[][] = page.items.map((model) => {
    const isCurrent = current?.provider === provider && current?.model === model;
    return [
      buildButton({
        action: "select",
        ownerUserId: params.ownerUserId,
        text: isCurrent ? `${model} [current]` : model,
        provider,
        model,
        page: page.page,
        style: isCurrent ? "primary" : "default",
      }),
    ];
  });

  const navRow: MattermostInteractiveButtonInput[] = [];
  if (page.hasPrev) {
    navRow.push(
      buildButton({
        action: "list",
        ownerUserId: params.ownerUserId,
        text: "Prev",
        provider,
        page: page.page - 1,
      }),
    );
  }
  if (page.hasNext) {
    navRow.push(
      buildButton({
        action: "list",
        ownerUserId: params.ownerUserId,
        text: "Next",
        provider,
        page: page.page + 1,
      }),
    );
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([
    buildButton({
      action: "back",
      ownerUserId: params.ownerUserId,
      text: "Back to providers",
    }),
  ]);

  return {
    text: [
      `Models (${provider}) - ${page.totalItems} available`,
      formatCurrentModelLine(params.currentModel),
      `Page ${page.page}/${page.totalPages}`,
      "Select a model to switch immediately.",
    ].join("\n"),
    buttons: rows,
  };
}
