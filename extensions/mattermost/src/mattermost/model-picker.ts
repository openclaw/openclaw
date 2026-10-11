import { createHash } from "node:crypto";
import {
  resolveStoredModelOverride,
  type ModelsProviderData,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  asFiniteNumber,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MattermostInteractiveButtonInput } from "./interactions.js";

const MATTERMOST_MODEL_PICKER_CONTEXT_KEY = "oc_model_picker";
const MODELS_PAGE_SIZE = 8;
const ACTION_IDS = {
  providers: "mdlprov",
  list: "mdllist",
  select: "mdlsel",
  back: "mdlback",
} as const;

export type MattermostModelPickerEntry =
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

function splitModelRef(modelRef?: string | null): { provider: string; model: string } | null {
  const trimmed = normalizeOptionalString(modelRef);
  const match = trimmed?.match(/^([^/]+)\/(.+)$/u);
  if (!match) {
    return null;
  }
  const rawProvider = match[1];
  if (!rawProvider) {
    return null;
  }
  const provider = normalizeProviderId(rawProvider);
  // Mattermost copy should normalize accidental whitespace around the model.
  const model = normalizeOptionalString(match[2]);
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function normalizePage(value: number | undefined): number {
  return Math.max(1, Math.floor(asFiniteNumber(value) ?? 1));
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
  const baseState = {
    action: params.action,
    ownerUserId: params.ownerUserId,
    ...(params.action === "list" || params.action === "select"
      ? {
          provider: normalizeProviderId(params.provider ?? ""),
          page: normalizePage(params.page),
        }
      : {}),
    ...(params.action === "select"
      ? { model: normalizeStringifiedOptionalString(params.model) ?? "" }
      : {}),
  };

  const digest = createHash("sha256").update(JSON.stringify(baseState)).digest("hex").slice(0, 12);
  return {
    // Mattermost requires action IDs to be unique within a post.
    id: `${ACTION_IDS[baseState.action]}${digest}`,
    text: params.text,
    ...(params.style ? { style: params.style } : {}),
    context: { [MATTERMOST_MODEL_PICKER_CONTEXT_KEY]: true, ...baseState },
  };
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

  const ownerUserId = normalizeOptionalString(context.ownerUserId) ?? "";
  const action = normalizeOptionalString(context.action) ?? "";
  if (!ownerUserId) {
    return null;
  }

  if (action === "providers" || action === "back") {
    return { action, ownerUserId };
  }

  const provider = normalizeProviderId(readStringField(context, "provider") ?? "");
  const page = asFiniteNumber(context.page) ?? parseStrictInteger(context.page);
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
    const model = normalizeOptionalString(context.model) ?? "";
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

export async function resolveMattermostModelPickerCurrentModel(params: {
  cfg: OpenClawConfig;
  route: { agentId: string; sessionKey: string };
  data: ModelsProviderData;
  readConsistency?: "latest";
}): Promise<string> {
  const fallback = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId,
    });
    const sessionEntry = await getSessionEntryAsync({
      agentId: params.route.agentId,
      storePath,
      sessionKey: params.route.sessionKey,
      readConsistency: params.readConsistency,
    });
    const parentSessionKey = sessionEntry?.parentSessionKey;
    const parentSessionEntry = parentSessionKey
      ? await getSessionEntryAsync({
          agentId: params.route.agentId,
          storePath,
          sessionKey: parentSessionKey,
          readConsistency: params.readConsistency,
        })
      : undefined;
    const override = resolveStoredModelOverride({
      sessionEntry,
      loadSessionEntry: (sessionKey) =>
        sessionKey === parentSessionKey ? parentSessionEntry : undefined,
      sessionKey: params.route.sessionKey,
      parentSessionKey,
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
  const models = [...(params.data.byProvider.get(provider) ?? [])].toSorted();
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

  const totalPages = Math.ceil(models.length / MODELS_PAGE_SIZE);
  const page = Math.min(normalizePage(params.page), totalPages);
  const start = (page - 1) * MODELS_PAGE_SIZE;
  const rows: MattermostInteractiveButtonInput[][] = models
    .slice(start, start + MODELS_PAGE_SIZE)
    .map((model) => {
      const isCurrent = current?.provider === provider && current?.model === model;
      return [
        buildButton({
          action: "select",
          ownerUserId: params.ownerUserId,
          text: isCurrent ? `${model} [current]` : model,
          provider,
          model,
          page,
          style: isCurrent ? "primary" : "default",
        }),
      ];
    });

  const navRow: MattermostInteractiveButtonInput[] = [];
  if (page > 1) {
    navRow.push(
      buildButton({
        action: "list",
        ownerUserId: params.ownerUserId,
        text: "Prev",
        provider,
        page: page - 1,
      }),
    );
  }
  if (page < totalPages) {
    navRow.push(
      buildButton({
        action: "list",
        ownerUserId: params.ownerUserId,
        text: "Next",
        provider,
        page: page + 1,
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
      `Models (${provider}) - ${models.length} available`,
      formatCurrentModelLine(params.currentModel),
      `Page ${page}/${totalPages}`,
      "Select a model to switch immediately.",
    ].join("\n"),
    buttons: rows,
  };
}
