import { createHash } from "node:crypto";
import {
  loadSessionStore,
  normalizeProviderId,
  resolveStorePath,
  resolveStoredModelOverride
} from "openclaw/plugin-sdk/mattermost";
const MATTERMOST_MODEL_PICKER_CONTEXT_KEY = "oc_model_picker";
const MODELS_PAGE_SIZE = 8;
const ACTION_IDS = {
  providers: "mdlprov",
  list: "mdllist",
  select: "mdlsel",
  back: "mdlback"
};
function splitModelRef(modelRef) {
  const trimmed = modelRef?.trim();
  const match = trimmed?.match(/^([^/]+)\/(.+)$/u);
  if (!match) {
    return null;
  }
  const provider = normalizeProviderId(match[1]);
  const model = match[2].trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}
function normalizePage(value) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}
function paginateItems(items, page, pageSize = MODELS_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(1, Math.min(normalizePage(page), totalPages));
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    totalItems: items.length
  };
}
function buildContext(state) {
  return {
    [MATTERMOST_MODEL_PICKER_CONTEXT_KEY]: true,
    ...state
  };
}
function buildButtonId(state) {
  const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 12);
  return `${ACTION_IDS[state.action]}${digest}`;
}
function buildButton(params) {
  const baseState = params.action === "providers" || params.action === "back" ? {
    action: params.action,
    ownerUserId: params.ownerUserId
  } : params.action === "list" ? {
    action: "list",
    ownerUserId: params.ownerUserId,
    provider: normalizeProviderId(params.provider ?? ""),
    page: normalizePage(params.page)
  } : {
    action: "select",
    ownerUserId: params.ownerUserId,
    provider: normalizeProviderId(params.provider ?? ""),
    page: normalizePage(params.page),
    model: String(params.model ?? "").trim()
  };
  return {
    // Mattermost requires action IDs to be unique within a post.
    id: buildButtonId(baseState),
    text: params.text,
    ...params.style ? { style: params.style } : {},
    context: buildContext(baseState)
  };
}
function getProviderModels(data, provider) {
  return [...data.byProvider.get(normalizeProviderId(provider)) ?? /* @__PURE__ */ new Set()].toSorted();
}
function formatCurrentModelLine(currentModel) {
  const parsed = splitModelRef(currentModel);
  if (!parsed) {
    return "Current: default";
  }
  return `Current: ${parsed.provider}/${parsed.model}`;
}
function resolveMattermostModelPickerEntry(commandText) {
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
    provider: normalizeProviderId(providerMatch[1])
  };
}
function parseMattermostModelPickerContext(context) {
  if (!context || context[MATTERMOST_MODEL_PICKER_CONTEXT_KEY] !== true) {
    return null;
  }
  const ownerUserId = String(context.ownerUserId ?? "").trim();
  const action = String(context.action ?? "").trim();
  if (!ownerUserId) {
    return null;
  }
  if (action === "providers" || action === "back") {
    return { action, ownerUserId };
  }
  const provider = normalizeProviderId(String(context.provider ?? ""));
  const page = Number.parseInt(String(context.page ?? "1"), 10);
  if (!provider) {
    return null;
  }
  if (action === "list") {
    return {
      action,
      ownerUserId,
      provider,
      page: normalizePage(page)
    };
  }
  if (action === "select") {
    const model = String(context.model ?? "").trim();
    if (!model) {
      return null;
    }
    return {
      action,
      ownerUserId,
      provider,
      page: normalizePage(page),
      model
    };
  }
  return null;
}
function buildMattermostAllowedModelRefs(data) {
  const refs = /* @__PURE__ */ new Set();
  for (const provider of data.providers) {
    for (const model of data.byProvider.get(provider) ?? []) {
      refs.add(`${provider}/${model}`);
    }
  }
  return refs;
}
function resolveMattermostModelPickerCurrentModel(params) {
  const fallback = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId
    });
    const sessionStore = params.skipCache ? loadSessionStore(storePath, { skipCache: true }) : loadSessionStore(storePath);
    const sessionEntry = sessionStore[params.route.sessionKey];
    const override = resolveStoredModelOverride({
      sessionEntry,
      sessionStore,
      sessionKey: params.route.sessionKey
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
function renderMattermostModelSummaryView(params) {
  return {
    text: [
      formatCurrentModelLine(params.currentModel),
      "",
      "Tap below to browse models, or use:",
      "/oc_model <provider/model> to switch",
      "/oc_model status for details"
    ].join("\n"),
    buttons: [
      [
        buildButton({
          action: "providers",
          ownerUserId: params.ownerUserId,
          text: "Browse providers",
          style: "primary"
        })
      ]
    ]
  };
}
function renderMattermostProviderPickerView(params) {
  const currentProvider = splitModelRef(params.currentModel)?.provider;
  const rows = params.data.providers.map((provider) => [
    buildButton({
      action: "list",
      ownerUserId: params.ownerUserId,
      text: `${provider} (${params.data.byProvider.get(provider)?.size ?? 0})`,
      provider,
      page: 1,
      style: provider === currentProvider ? "primary" : "default"
    })
  ]);
  return {
    text: [formatCurrentModelLine(params.currentModel), "", "Select a provider:"].join("\n"),
    buttons: rows
  };
}
function renderMattermostModelsPickerView(params) {
  const provider = normalizeProviderId(params.provider);
  const models = getProviderModels(params.data, provider);
  const current = splitModelRef(params.currentModel);
  if (models.length === 0) {
    return {
      text: [formatCurrentModelLine(params.currentModel), "", `Unknown provider: ${provider}`].join(
        "\n"
      ),
      buttons: [
        [
          buildButton({
            action: "back",
            ownerUserId: params.ownerUserId,
            text: "Back to providers"
          })
        ]
      ]
    };
  }
  const page = paginateItems(models, params.page);
  const rows = page.items.map((model) => {
    const isCurrent = current?.provider === provider && current.model === model;
    return [
      buildButton({
        action: "select",
        ownerUserId: params.ownerUserId,
        text: isCurrent ? `${model} [current]` : model,
        provider,
        model,
        page: page.page,
        style: isCurrent ? "primary" : "default"
      })
    ];
  });
  const navRow = [];
  if (page.hasPrev) {
    navRow.push(
      buildButton({
        action: "list",
        ownerUserId: params.ownerUserId,
        text: "Prev",
        provider,
        page: page.page - 1
      })
    );
  }
  if (page.hasNext) {
    navRow.push(
      buildButton({
        action: "list",
        ownerUserId: params.ownerUserId,
        text: "Next",
        provider,
        page: page.page + 1
      })
    );
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }
  rows.push([
    buildButton({
      action: "back",
      ownerUserId: params.ownerUserId,
      text: "Back to providers"
    })
  ]);
  return {
    text: [
      `Models (${provider}) - ${page.totalItems} available`,
      formatCurrentModelLine(params.currentModel),
      `Page ${page.page}/${page.totalPages}`,
      "Select a model to switch immediately."
    ].join("\n"),
    buttons: rows
  };
}
export {
  buildMattermostAllowedModelRefs,
  parseMattermostModelPickerContext,
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerEntry
};
