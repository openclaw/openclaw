import {
  Button,
  Container,
  Row,
  Separator,
  StringSelectMenu,
  TextDisplay
} from "@buape/carbon";
import { ButtonStyle } from "discord-api-types/v10";
import { normalizeProviderId } from "../../../../src/agents/model-selection.js";
import {
  buildModelsProviderData
} from "../../../../src/auto-reply/reply/commands-models.js";
const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
const DISCORD_CUSTOM_ID_MAX_CHARS = 100;
const DISCORD_COMPONENT_MAX_ROWS = 5;
const DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW = 5;
const DISCORD_COMPONENT_MAX_SELECT_OPTIONS = 25;
const DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE = DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW * (DISCORD_COMPONENT_MAX_ROWS - 1);
const DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX = DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW * DISCORD_COMPONENT_MAX_ROWS;
const DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;
const DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS = 18;
const COMMAND_CONTEXTS = ["model", "models"];
const PICKER_ACTIONS = [
  "open",
  "provider",
  "model",
  "submit",
  "quick",
  "back",
  "reset",
  "cancel",
  "recents"
];
const PICKER_VIEWS = ["providers", "models", "recents"];
function encodeCustomIdValue(value) {
  return encodeURIComponent(value);
}
function decodeCustomIdValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function isValidCommandContext(value) {
  return COMMAND_CONTEXTS.includes(value);
}
function isValidPickerAction(value) {
  return PICKER_ACTIONS.includes(value);
}
function isValidPickerView(value) {
  return PICKER_VIEWS.includes(value);
}
function normalizePage(value) {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(1, Math.floor(numeric));
}
function parseRawPage(value) {
  if (typeof value === "number") {
    return normalizePage(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return normalizePage(parsed);
    }
  }
  return 1;
}
function parseRawPositiveInt(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return void 0;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return void 0;
  }
  return Math.floor(parsed);
}
function coerceString(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function clampPageSize(rawPageSize, max, fallback) {
  if (!Number.isFinite(rawPageSize)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(rawPageSize ?? fallback)));
}
function paginateItems(params) {
  const totalItems = params.items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / params.pageSize));
  const page = Math.max(1, Math.min(params.page, totalPages));
  const startIndex = (page - 1) * params.pageSize;
  const endIndexExclusive = Math.min(totalItems, startIndex + params.pageSize);
  return {
    items: params.items.slice(startIndex, endIndexExclusive),
    page,
    pageSize: params.pageSize,
    totalPages,
    totalItems,
    hasPrev: page > 1,
    hasNext: page < totalPages
  };
}
function parseCurrentModelRef(raw) {
  const trimmed = raw?.trim();
  const match = trimmed?.match(/^([^/]+)\/(.+)$/u);
  if (!match) {
    return null;
  }
  const provider = normalizeProviderId(match[1]);
  const model = match[2];
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}
function formatCurrentModelLine(currentModel) {
  const parsed = parseCurrentModelRef(currentModel);
  if (!parsed) {
    return "Current model: default";
  }
  return `Current model: ${parsed.provider}/${parsed.model}`;
}
function formatProviderButtonLabel(provider) {
  if (provider.length <= DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS) {
    return provider;
  }
  return `${provider.slice(0, DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS - 1)}\u2026`;
}
function chunkProvidersForRows(items) {
  if (items.length === 0) {
    return [];
  }
  const rowCount = Math.max(1, Math.ceil(items.length / DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW));
  const minPerRow = Math.floor(items.length / rowCount);
  const rowsWithExtraItem = items.length % rowCount;
  const counts = Array.from(
    { length: rowCount },
    (_, index) => index < rowCount - rowsWithExtraItem ? minPerRow : minPerRow + 1
  );
  const rows = [];
  let cursor = 0;
  for (const count of counts) {
    rows.push(items.slice(cursor, cursor + count));
    cursor += count;
  }
  return rows;
}
function createModelPickerButton(params) {
  class DiscordModelPickerButton extends Button {
    constructor() {
      super(...arguments);
      this.label = params.label;
      this.customId = params.customId;
      this.style = params.style ?? ButtonStyle.Secondary;
      this.disabled = params.disabled ?? false;
    }
  }
  return new DiscordModelPickerButton();
}
function createModelSelect(params) {
  class DiscordModelPickerSelect extends StringSelectMenu {
    constructor() {
      super(...arguments);
      this.customId = params.customId;
      this.options = params.options;
      this.minValues = 1;
      this.maxValues = 1;
      this.placeholder = params.placeholder;
      this.disabled = params.disabled ?? false;
    }
  }
  return new DiscordModelPickerSelect();
}
function buildRenderedShell(params) {
  if (params.layout === "classic") {
    const lines = [params.title, ...params.detailLines, "", params.footer].filter(Boolean);
    return {
      layout: "classic",
      content: lines.join("\n"),
      components: params.rows
    };
  }
  const containerComponents = [
    new TextDisplay(`## ${params.title}`)
  ];
  if (params.detailLines.length > 0) {
    containerComponents.push(new TextDisplay(params.detailLines.join("\n")));
  }
  containerComponents.push(new Separator({ divider: true, spacing: "small" }));
  if (params.preRowText) {
    containerComponents.push(new TextDisplay(params.preRowText));
  }
  containerComponents.push(...params.rows);
  if (params.trailingRows && params.trailingRows.length > 0) {
    containerComponents.push(new Separator({ divider: true, spacing: "small" }));
    containerComponents.push(...params.trailingRows);
  }
  if (params.footer) {
    containerComponents.push(new Separator({ divider: false, spacing: "small" }));
    containerComponents.push(new TextDisplay(`-# ${params.footer}`));
  }
  const container = new Container(containerComponents);
  return {
    layout: "v2",
    components: [container]
  };
}
function buildProviderRows(params) {
  const rows = chunkProvidersForRows(params.page.items).map(
    (providers) => new Row(
      providers.map((provider) => {
        const style = provider.id === params.currentProvider ? ButtonStyle.Primary : ButtonStyle.Secondary;
        return createModelPickerButton({
          label: formatProviderButtonLabel(provider.id),
          style,
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "provider",
            view: "models",
            provider: provider.id,
            page: params.page.page,
            userId: params.userId
          })
        });
      })
    )
  );
  return rows;
}
function buildModelRows(params) {
  const parsedCurrentModel = parseCurrentModelRef(params.currentModel);
  const parsedPendingModel = parseCurrentModelRef(params.pendingModel);
  const rows = [];
  const hasQuickModels = (params.quickModels ?? []).length > 0;
  const providerPage = getDiscordModelPickerProviderPage({
    data: params.data,
    page: params.providerPage
  });
  const providerOptions = providerPage.items.map((provider) => ({
    label: provider.id,
    value: provider.id,
    default: provider.id === params.modelPage.provider
  }));
  rows.push(
    new Row([
      createModelSelect({
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "provider",
          view: "models",
          provider: params.modelPage.provider,
          page: providerPage.page,
          providerPage: providerPage.page,
          userId: params.userId
        }),
        options: providerOptions,
        placeholder: "Select provider"
      })
    ])
  );
  const selectedModelRef = parsedPendingModel ?? parsedCurrentModel;
  const modelOptions = params.modelPage.items.map((model) => ({
    label: model,
    value: model,
    default: selectedModelRef ? selectedModelRef.provider === params.modelPage.provider && selectedModelRef.model === model : false
  }));
  rows.push(
    new Row([
      createModelSelect({
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "model",
          view: "models",
          provider: params.modelPage.provider,
          page: params.modelPage.page,
          providerPage: providerPage.page,
          userId: params.userId
        }),
        options: modelOptions,
        placeholder: `Select ${params.modelPage.provider} model`
      })
    ])
  );
  const resolvedDefault = params.data.resolvedDefault;
  const shouldDisableReset = Boolean(parsedCurrentModel) && parsedCurrentModel?.provider === resolvedDefault.provider && parsedCurrentModel?.model === resolvedDefault.model;
  const hasPendingSelection = Boolean(parsedPendingModel) && parsedPendingModel?.provider === params.modelPage.provider && typeof params.pendingModelIndex === "number" && params.pendingModelIndex > 0;
  const buttonRowItems = [
    createModelPickerButton({
      label: "Cancel",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "cancel",
        view: "models",
        provider: params.modelPage.provider,
        page: params.modelPage.page,
        providerPage: providerPage.page,
        userId: params.userId
      })
    }),
    createModelPickerButton({
      label: "Reset to default",
      style: ButtonStyle.Secondary,
      disabled: shouldDisableReset,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "reset",
        view: "models",
        provider: params.modelPage.provider,
        page: params.modelPage.page,
        providerPage: providerPage.page,
        userId: params.userId
      })
    })
  ];
  if (hasQuickModels) {
    buttonRowItems.push(
      createModelPickerButton({
        label: "Recents",
        style: ButtonStyle.Secondary,
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "recents",
          view: "recents",
          provider: params.modelPage.provider,
          page: params.modelPage.page,
          providerPage: providerPage.page,
          userId: params.userId
        })
      })
    );
  }
  buttonRowItems.push(
    createModelPickerButton({
      label: "Submit",
      style: ButtonStyle.Primary,
      disabled: !hasPendingSelection,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "submit",
        view: "models",
        provider: params.modelPage.provider,
        page: params.modelPage.page,
        providerPage: providerPage.page,
        modelIndex: params.pendingModelIndex,
        userId: params.userId
      })
    })
  );
  return { rows, buttonRow: new Row(buttonRowItems) };
}
async function loadDiscordModelPickerData(cfg, agentId) {
  return buildModelsProviderData(cfg, agentId);
}
function buildDiscordModelPickerCustomId(params) {
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error("Discord model picker custom_id requires userId");
  }
  const page = normalizePage(params.page);
  const providerPage = typeof params.providerPage === "number" && Number.isFinite(params.providerPage) ? Math.max(1, Math.floor(params.providerPage)) : void 0;
  const normalizedProvider = params.provider ? normalizeProviderId(params.provider) : void 0;
  const modelIndex = typeof params.modelIndex === "number" && Number.isFinite(params.modelIndex) ? Math.max(1, Math.floor(params.modelIndex)) : void 0;
  const recentSlot = typeof params.recentSlot === "number" && Number.isFinite(params.recentSlot) ? Math.max(1, Math.floor(params.recentSlot)) : void 0;
  const parts = [
    `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:c=${encodeCustomIdValue(params.command)}`,
    `a=${encodeCustomIdValue(params.action)}`,
    `v=${encodeCustomIdValue(params.view)}`,
    `u=${encodeCustomIdValue(userId)}`,
    `g=${String(page)}`
  ];
  if (normalizedProvider) {
    parts.push(`p=${encodeCustomIdValue(normalizedProvider)}`);
  }
  if (providerPage) {
    parts.push(`pp=${String(providerPage)}`);
  }
  if (modelIndex) {
    parts.push(`mi=${String(modelIndex)}`);
  }
  if (recentSlot) {
    parts.push(`rs=${String(recentSlot)}`);
  }
  const customId = parts.join(";");
  if (customId.length > DISCORD_CUSTOM_ID_MAX_CHARS) {
    throw new Error(
      `Discord model picker custom_id exceeds ${DISCORD_CUSTOM_ID_MAX_CHARS} chars (${customId.length})`
    );
  }
  return customId;
}
function parseDiscordModelPickerCustomId(customId) {
  const trimmed = customId.trim();
  if (!trimmed.startsWith(`${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:`)) {
    return null;
  }
  const rawParts = trimmed.split(";");
  const data = {};
  for (const part of rawParts) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const rawKey = part.slice(0, equalsIndex);
    const rawValue = part.slice(equalsIndex + 1);
    const key = rawKey.includes(":") ? rawKey.split(":").slice(1).join(":") : rawKey;
    if (!key) {
      continue;
    }
    data[key] = rawValue;
  }
  return parseDiscordModelPickerData(data);
}
function parseDiscordModelPickerData(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const command = decodeCustomIdValue(coerceString(data.c ?? data.cmd));
  const action = decodeCustomIdValue(coerceString(data.a ?? data.act));
  const view = decodeCustomIdValue(coerceString(data.v ?? data.view));
  const userId = decodeCustomIdValue(coerceString(data.u));
  const providerRaw = decodeCustomIdValue(coerceString(data.p));
  const page = parseRawPage(data.g ?? data.pg);
  const providerPage = parseRawPositiveInt(data.pp);
  const modelIndex = parseRawPositiveInt(data.mi);
  const recentSlot = parseRawPositiveInt(data.rs);
  if (!isValidCommandContext(command) || !isValidPickerAction(action) || !isValidPickerView(view)) {
    return null;
  }
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return null;
  }
  const provider = providerRaw ? normalizeProviderId(providerRaw) : void 0;
  return {
    command,
    action,
    view,
    userId: trimmedUserId,
    provider,
    page,
    ...typeof providerPage === "number" ? { providerPage } : {},
    ...typeof modelIndex === "number" ? { modelIndex } : {},
    ...typeof recentSlot === "number" ? { recentSlot } : {}
  };
}
function buildDiscordModelPickerProviderItems(data) {
  return data.providers.map((provider) => ({
    id: provider,
    count: data.byProvider.get(provider)?.size ?? 0
  }));
}
function getDiscordModelPickerProviderPage(params) {
  const items = buildDiscordModelPickerProviderItems(params.data);
  const canFitSinglePage = items.length <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX;
  const maxPageSize = canFitSinglePage ? DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX : DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE;
  const pageSize = clampPageSize(params.pageSize, maxPageSize, maxPageSize);
  return paginateItems({
    items,
    page: normalizePage(params.page),
    pageSize
  });
}
function getDiscordModelPickerModelPage(params) {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return null;
  }
  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE
  );
  const models = [...modelSet].toSorted();
  const page = paginateItems({
    items: models,
    page: normalizePage(params.page),
    pageSize
  });
  return {
    ...page,
    provider
  };
}
function renderDiscordModelPickerProvidersView(params) {
  const page = getDiscordModelPickerProviderPage({ data: params.data, page: params.page });
  const parsedCurrent = parseCurrentModelRef(params.currentModel);
  const rows = buildProviderRows({
    command: params.command,
    userId: params.userId,
    page,
    currentProvider: parsedCurrent?.provider
  });
  const detailLines = [
    formatCurrentModelLine(params.currentModel),
    `Select a provider (${page.totalItems} available).`
  ];
  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Model Picker",
    detailLines,
    rows,
    footer: `All ${page.totalItems} providers shown`
  });
}
function renderDiscordModelPickerModelsView(params) {
  const providerPage = normalizePage(params.providerPage);
  const modelPage = getDiscordModelPickerModelPage({
    data: params.data,
    provider: params.provider,
    page: params.page
  });
  if (!modelPage) {
    const rows2 = [
      new Row([
        createModelPickerButton({
          label: "Back",
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "back",
            view: "providers",
            page: providerPage,
            userId: params.userId
          })
        })
      ])
    ];
    return buildRenderedShell({
      layout: params.layout ?? "v2",
      title: "Model Picker",
      detailLines: [
        formatCurrentModelLine(params.currentModel),
        `Provider not found: ${normalizeProviderId(params.provider)}`
      ],
      rows: rows2,
      footer: "Choose a different provider."
    });
  }
  const { rows, buttonRow } = buildModelRows({
    command: params.command,
    userId: params.userId,
    data: params.data,
    providerPage,
    modelPage,
    currentModel: params.currentModel,
    pendingModel: params.pendingModel,
    pendingModelIndex: params.pendingModelIndex,
    quickModels: params.quickModels
  });
  const defaultModel = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  const pendingLine = params.pendingModel ? `Selected: ${params.pendingModel} (press Submit)` : "Select a model, then press Submit.";
  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Model Picker",
    detailLines: [formatCurrentModelLine(params.currentModel), `Default: ${defaultModel}`],
    preRowText: pendingLine,
    rows,
    trailingRows: [buttonRow]
  });
}
function formatRecentsButtonLabel(modelRef, suffix) {
  const maxLen = 80;
  const label = suffix ? `${modelRef} ${suffix}` : modelRef;
  if (label.length <= maxLen) {
    return label;
  }
  const trimmed = suffix ? `${modelRef.slice(0, maxLen - suffix.length - 2)}\u2026 ${suffix}` : `${modelRef.slice(0, maxLen - 1)}\u2026`;
  return trimmed;
}
function renderDiscordModelPickerRecentsView(params) {
  const defaultModelRef = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  const rows = [];
  const dedupedQuickModels = params.quickModels.filter((modelRef) => modelRef !== defaultModelRef);
  rows.push(
    new Row([
      createModelPickerButton({
        label: formatRecentsButtonLabel(defaultModelRef, "(default)"),
        style: ButtonStyle.Secondary,
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "submit",
          view: "recents",
          recentSlot: 1,
          provider: params.provider,
          page: params.page,
          providerPage: params.providerPage,
          userId: params.userId
        })
      })
    ])
  );
  for (let i = 0; i < dedupedQuickModels.length; i++) {
    const modelRef = dedupedQuickModels[i];
    rows.push(
      new Row([
        createModelPickerButton({
          label: formatRecentsButtonLabel(modelRef),
          style: ButtonStyle.Secondary,
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "submit",
            view: "recents",
            recentSlot: i + 2,
            provider: params.provider,
            page: params.page,
            providerPage: params.providerPage,
            userId: params.userId
          })
        })
      ])
    );
  }
  const backRow = new Row([
    createModelPickerButton({
      label: "Back",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "back",
        view: "models",
        provider: params.provider,
        page: params.page,
        providerPage: params.providerPage,
        userId: params.userId
      })
    })
  ]);
  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Recents",
    detailLines: [
      "Models you've previously selected appear here.",
      formatCurrentModelLine(params.currentModel)
    ],
    preRowText: "Tap a model to switch.",
    rows,
    trailingRows: [backRow]
  });
}
function toDiscordModelPickerMessagePayload(view) {
  if (view.layout === "classic") {
    return {
      content: view.content,
      components: view.components
    };
  }
  return {
    components: view.components
  };
}
export {
  DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW,
  DISCORD_COMPONENT_MAX_ROWS,
  DISCORD_COMPONENT_MAX_SELECT_OPTIONS,
  DISCORD_CUSTOM_ID_MAX_CHARS,
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE,
  DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX,
  buildDiscordModelPickerCustomId,
  buildDiscordModelPickerProviderItems,
  getDiscordModelPickerModelPage,
  getDiscordModelPickerProviderPage,
  loadDiscordModelPickerData,
  parseDiscordModelPickerCustomId,
  parseDiscordModelPickerData,
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload
};
