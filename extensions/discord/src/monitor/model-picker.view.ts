import { ButtonStyle, type APISelectMenuOption } from "discord-api-types/v10";
import type {
  ModelsProviderData,
  ModelsRuntimeChoice,
} from "openclaw/plugin-sdk/models-provider-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { sliceUtf16Safe, truncateCodePoints } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  Button,
  Container,
  Row,
  Separator,
  StringSelectMenu,
  TextDisplay,
  type TopLevelComponents,
} from "../internal/discord.js";
import {
  getDiscordModelPickerRuntimeChoices,
  supportsDiscordModelPickerRuntimeChoices,
} from "./model-picker.runtime.js";
import {
  buildDiscordModelPickerCustomId,
  createDiscordModelPickerModelToken,
  createDiscordModelPickerRuntimeToken,
  getDiscordModelPickerModelPage,
  getDiscordModelPickerProviderPage,
  getDiscordModelPickerRecentModelRefs,
  normalizeModelPickerPage,
  type DiscordModelPickerBucket,
  type DiscordModelPickerCommandContext,
  type DiscordModelPickerPage,
  type DiscordModelPickerProviderItem,
} from "./model-picker.state.js";

const DISCORD_MODEL_PICKER_PAGE_INDICATOR_CUSTOM_ID = "mdlpk:nav-indicator";

type DiscordModelPickerCustomIdState = Parameters<typeof buildDiscordModelPickerCustomId>[0];

type DiscordModelPickerCurrentModelRef = {
  provider: string;
  model: string;
};

type DiscordModelPickerRow = Row<Button> | Row<StringSelectMenu>;
type DiscordModelPickerRenderShellParams = {
  title: string;
  refreshWarning?: string;
  detailLines: string[];
  rows: DiscordModelPickerRow[];
  footer?: string;
  /** Text shown after the divider but before the interactive rows. */
  preRowText?: string;
  /** Extra rows appended after the main rows, preceded by a divider. */
  trailingRows?: DiscordModelPickerRow[];
};

type DiscordModelPickerRenderedView = {
  components: TopLevelComponents[];
};

type DiscordModelPickerProviderViewParams = {
  command: DiscordModelPickerCommandContext;
  userId: string;
  data: ModelsProviderData;
  page?: number;
  providerBucket?: string;
  currentModel?: string;
};

type DiscordModelPickerModelViewParams = DiscordModelPickerProviderViewParams & {
  provider: string;
  providerPage?: number;
  modelBucket?: string;
  currentRuntime?: string;
  pendingModel?: string;
  pendingModelIndex?: number;
  pendingRuntime?: string;
  quickModels?: string[];
};

function parseCurrentModelRef(raw?: string): DiscordModelPickerCurrentModelRef | null {
  const match = raw?.trim().match(/^([^/]+)\/(.+)$/u);
  if (!match) {
    return null;
  }
  const providerText = match[1];
  const model = match[2];
  const provider = providerText ? normalizeProviderId(providerText) : "";
  // Preserve the model suffix exactly as entered after "/" so select defaults
  // continue to mirror the stored ref for Discord interactions.
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function formatCurrentModelLine(currentModel?: string): string {
  const parsed = parseCurrentModelRef(currentModel);
  if (!parsed) {
    return "Current model: default";
  }
  return `Current model: ${parsed.provider}/${parsed.model}`;
}

function createModelPickerButton(
  label: string,
  state: DiscordModelPickerCustomIdState | string,
  options: { style?: ButtonStyle; disabled?: boolean } = {},
): Button {
  const customId = typeof state === "string" ? state : buildDiscordModelPickerCustomId(state);
  class DiscordModelPickerButton extends Button {
    label = label;
    customId = customId;
    override style = options.style ?? ButtonStyle.Secondary;
    override disabled = options.disabled ?? false;
  }
  return new DiscordModelPickerButton();
}

function createModelSelectRow(
  state: DiscordModelPickerCustomIdState,
  options: APISelectMenuOption[],
  placeholder: string,
): Row<StringSelectMenu> {
  const customId = buildDiscordModelPickerCustomId(state);
  class DiscordModelPickerSelect extends StringSelectMenu {
    customId = customId;
    override options = options;
    override minValues = 1;
    override maxValues = 1;
    override placeholder = placeholder;
  }
  return new Row([new DiscordModelPickerSelect()]);
}

function buildBucketSelectRow(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  view: "providers" | "models";
  buckets: DiscordModelPickerBucket[];
  currentBucketId: string | undefined;
  provider?: string;
  runtime?: string;
  runtimeToken?: string;
  providerPage?: number;
  modelIndex?: number;
}): Row<StringSelectMenu> | null {
  const { buckets, currentBucketId, ...state } = params;
  if (buckets.length <= 1) {
    return null;
  }
  const options: APISelectMenuOption[] = buckets.map((bucket) => ({
    label: bucket.label,
    value: bucket.id,
    default: bucket.id === currentBucketId,
  }));
  // The select value carries the bucket; derive the provider bucket on interaction
  // to keep long provider and user IDs within Discord's 100-character custom-id cap.
  return createModelSelectRow(
    {
      ...state,
      action: "bucket",
      page: 1,
    },
    options,
    params.view === "providers"
      ? "Filter providers by letter range"
      : "Filter models by letter range",
  );
}

function getActiveBucketId(
  bucket: DiscordModelPickerBucket | null | undefined,
): string | undefined {
  return bucket && bucket.id !== "all" ? bucket.id : undefined;
}

function buildRenderedShell(
  params: DiscordModelPickerRenderShellParams,
): DiscordModelPickerRenderedView {
  const containerComponents: Array<TextDisplay | Separator | DiscordModelPickerRow> = [
    new TextDisplay(`## ${params.title}`),
  ];
  if (params.refreshWarning) {
    containerComponents.push(new TextDisplay(params.refreshWarning));
  }
  containerComponents.push(new TextDisplay(params.detailLines.join("\n")));
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

  return {
    components: [new Container(containerComponents)],
  };
}

function buildProviderSelectRow(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  page: DiscordModelPickerPage<DiscordModelPickerProviderItem>;
  currentProvider?: string;
  provider?: string;
  providerBucket?: string;
  showModelCounts?: boolean;
}): Row<StringSelectMenu> {
  const { page, currentProvider, showModelCounts, ...state } = params;
  const options: APISelectMenuOption[] = page.items.map((provider) => ({
    label: provider.id,
    value: provider.id,
    default: provider.id === currentProvider,
    ...(showModelCounts
      ? { description: `${provider.count} ${provider.count === 1 ? "model" : "models"}` }
      : {}),
  }));
  return createModelSelectRow(
    {
      ...state,
      action: "provider",
      view: "models",
      page: page.page,
      providerPage: page.page,
    },
    options,
    "Select provider",
  );
}

function buildPaginationRow(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  view: "providers" | "models";
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  provider?: string;
  runtime?: string;
  runtimeToken?: string;
  providerPage?: number;
  modelIndex?: number;
  modelToken?: string;
  providerBucket?: string;
  modelBucket?: string;
}): Row<Button> | null {
  if (params.totalPages <= 1) {
    return null;
  }
  const { page, totalPages, hasPrev, hasNext, ...navigationState } = params;
  const createNavigationButton = (label: string, targetPage: number, enabled: boolean) =>
    createModelPickerButton(
      label,
      {
        ...navigationState,
        action: "nav",
        page: targetPage,
      },
      { disabled: !enabled },
    );
  const indicatorButton = createModelPickerButton(
    `Page ${page}/${totalPages}`,
    DISCORD_MODEL_PICKER_PAGE_INDICATOR_CUSTOM_ID,
    { disabled: true },
  );
  return new Row([
    createNavigationButton("◀ Prev", Math.max(1, page - 1), hasPrev),
    indicatorButton,
    createNavigationButton("Next ▶", Math.min(totalPages, page + 1), hasNext),
  ]);
}

function buildModelRows(
  params: Omit<DiscordModelPickerModelViewParams, "provider" | "page" | "modelBucket"> & {
    providerPage: number;
    modelPage: NonNullable<ReturnType<typeof getDiscordModelPickerModelPage>>;
  },
): {
  rows: DiscordModelPickerRow[];
  buttonRow: Row<Button>;
  runtimeChoices: ModelsRuntimeChoice[] | undefined;
  selectedRuntime: string | undefined;
} {
  const parsedCurrentModel = parseCurrentModelRef(params.currentModel);
  const parsedPendingModel = parseCurrentModelRef(params.pendingModel);
  const pendingModelToken = parsedPendingModel
    ? createDiscordModelPickerModelToken(parsedPendingModel.provider, parsedPendingModel.model)
    : undefined;
  const rows: DiscordModelPickerRow[] = [];

  // Keep the provider switcher in the letter range used to enter this model view.
  const providerPage = getDiscordModelPickerProviderPage({
    data: params.data,
    page: params.providerPage,
    bucket: params.providerBucket,
  });
  const activeProviderBucket = getActiveBucketId(providerPage.bucket);
  const activeModelBucket = getActiveBucketId(params.modelPage.bucket);
  // Discord caps messages at 5 action rows. Model bucketing adds its own row,
  // so the in-view provider switcher has to yield to the Providers button.
  const modelBucketingActive = params.modelPage.buckets.length > 1;
  if (!modelBucketingActive) {
    rows.push(
      buildProviderSelectRow({
        command: params.command,
        userId: params.userId,
        page: providerPage,
        provider: params.modelPage.provider,
        currentProvider: params.modelPage.provider,
        providerBucket: activeProviderBucket,
      }),
    );
  }

  const runtimeModel = parseCurrentModelRef(params.pendingModel ?? params.currentModel);
  const runtimeChoices = getDiscordModelPickerRuntimeChoices(
    params.data,
    params.modelPage.provider,
    runtimeModel?.provider === normalizeProviderId(params.modelPage.provider)
      ? runtimeModel.model
      : undefined,
  );
  const currentRuntime =
    parsedCurrentModel?.provider === params.modelPage.provider ? params.currentRuntime : undefined;
  // Keep an unavailable explicit choice visible until the user confirms an eligible runtime.
  const runtime = params.pendingRuntime?.trim() || currentRuntime?.trim();
  const explicitRuntime =
    runtime && runtime !== "auto" && runtime !== "default" ? runtime : undefined;
  const selectedRuntime = explicitRuntime
    ? runtimeChoices?.find((choice) => choice.id === explicitRuntime)?.id
    : runtimeChoices?.[0]?.id;
  const compactRuntime =
    supportsDiscordModelPickerRuntimeChoices() && explicitRuntime
      ? { runtimeToken: createDiscordModelPickerRuntimeToken(explicitRuntime) }
      : {};
  const modelViewState = {
    command: params.command,
    userId: params.userId,
    view: "models" as const,
    provider: params.modelPage.provider,
    page: params.modelPage.page,
    providerPage: providerPage.page,
  };
  const modelActionState = { ...modelViewState, ...compactRuntime };

  if (
    runtimeChoices &&
    (runtimeChoices.length > 1 || (runtimeChoices.length === 1 && selectedRuntime === undefined))
  ) {
    // The selected runtime travels in the select interaction value; omitting
    // it here leaves enough customId budget to preserve the browse bucket.
    rows.push(
      createModelSelectRow(
        {
          ...modelViewState,
          action: "runtime",
          modelIndex: params.pendingModelIndex,
          modelToken: pendingModelToken,
          ...(params.pendingModelIndex === undefined && activeModelBucket
            ? { modelBucket: activeModelBucket }
            : {}),
        },
        runtimeChoices.map((choice) => ({
          label: choice.label,
          value: choice.id,
          default: choice.id === selectedRuntime,
          ...(choice.description ? { description: choice.description } : {}),
        })),
        "Choose how to run this model",
      ),
    );
  }

  const selectedModelRef = parsedPendingModel ?? parsedCurrentModel;
  const modelOptions: APISelectMenuOption[] = params.modelPage.items.map((model) => ({
    label: truncateCodePoints(model, 100),
    value: createDiscordModelPickerModelToken(params.modelPage.provider, model),
    default: selectedModelRef
      ? selectedModelRef.provider === params.modelPage.provider && selectedModelRef.model === model
      : false,
  }));

  // Derive both buckets from the selected provider/model to preserve custom-id budget.
  rows.push(
    createModelSelectRow(
      {
        ...modelActionState,
        action: "pick",
      },
      modelOptions,
      `Select ${params.modelPage.provider} model`,
    ),
  );

  const modelNavRow = buildPaginationRow({
    ...modelActionState,
    totalPages: params.modelPage.totalPages,
    hasPrev: params.modelPage.hasPrev,
    hasNext: params.modelPage.hasNext,
    modelIndex: params.pendingModelIndex,
    modelToken: pendingModelToken,
    // Model navigation derives providerBucket from provider on interaction;
    // carrying it here can exceed Discord's 100-char customId limit.
    modelBucket: activeModelBucket,
  });
  if (modelNavRow) {
    rows.push(modelNavRow);
  }

  const resolvedDefault = params.data.resolvedDefault;
  const shouldDisableReset =
    parsedCurrentModel?.provider === resolvedDefault.provider &&
    parsedCurrentModel?.model === resolvedDefault.model;

  const hasPendingSelection =
    parsedPendingModel?.provider === params.modelPage.provider &&
    typeof params.pendingModelIndex === "number" &&
    params.pendingModelIndex > 0;

  const buttonRowItems: Button[] = [
    createModelPickerButton("Providers", {
      command: params.command,
      action: "back",
      view: "providers",
      page: providerPage.page,
      providerBucket: activeProviderBucket,
      userId: params.userId,
    }),
    createModelPickerButton("Cancel", { ...modelActionState, action: "cancel" }),
    createModelPickerButton(
      "Reset to default",
      {
        ...modelActionState,
        action: "reset",
      },
      { disabled: shouldDisableReset },
    ),
  ];

  if (params.quickModels?.length) {
    buttonRowItems.push(
      createModelPickerButton("Recents", {
        ...modelActionState,
        action: "recents",
        view: "recents",
        modelBucket: activeModelBucket,
      }),
    );
  }

  buttonRowItems.push(
    createModelPickerButton(
      "Submit",
      {
        ...modelActionState,
        action: "submit",
        modelIndex: params.pendingModelIndex,
        modelToken: pendingModelToken,
      },
      {
        style: ButtonStyle.Primary,
        disabled:
          !hasPendingSelection ||
          (supportsDiscordModelPickerRuntimeChoices() && selectedRuntime === undefined),
      },
    ),
  );

  return { rows, buttonRow: new Row(buttonRowItems), runtimeChoices, selectedRuntime };
}

export function renderDiscordModelPickerProvidersView(
  params: DiscordModelPickerProviderViewParams,
): DiscordModelPickerRenderedView {
  const page = getDiscordModelPickerProviderPage({
    data: params.data,
    page: params.page,
    bucket: params.providerBucket,
  });
  const parsedCurrent = parseCurrentModelRef(params.currentModel);
  const rows: DiscordModelPickerRow[] = [];

  const bucketRow = buildBucketSelectRow({
    command: params.command,
    userId: params.userId,
    view: "providers",
    buckets: page.buckets,
    currentBucketId: page.bucket?.id,
  });
  if (bucketRow) {
    rows.push(bucketRow);
  }

  const activeProviderBucket = getActiveBucketId(page.bucket);
  if (page.items.length > 0) {
    rows.push(
      buildProviderSelectRow({
        command: params.command,
        userId: params.userId,
        page,
        currentProvider: parsedCurrent?.provider,
        providerBucket: activeProviderBucket,
        showModelCounts: true,
      }),
    );
  }

  const navRow = buildPaginationRow({
    command: params.command,
    userId: params.userId,
    view: "providers",
    page: page.page,
    totalPages: page.totalPages,
    hasPrev: page.hasPrev,
    hasNext: page.hasNext,
    providerBucket: activeProviderBucket,
  });
  if (navRow) {
    rows.push(navRow);
  }

  const totalProviders = params.data.providers.length;
  const detailLines = [
    formatCurrentModelLine(params.currentModel),
    page.bucket && page.bucket.id !== "all"
      ? `Select a provider (${page.totalItems} in ${page.bucket.label}, ${totalProviders} total).`
      : `Select a provider (${page.totalItems} available).`,
  ];
  const footer =
    page.totalPages > 1
      ? `Showing page ${page.page}/${page.totalPages} · ${page.totalItems} providers total`
      : `All ${page.totalItems} providers shown`;
  return buildRenderedShell({
    title: "Model Picker",
    refreshWarning: params.data.refreshWarning,
    detailLines,
    rows,
    footer,
  });
}

export function renderDiscordModelPickerModelsView(
  params: DiscordModelPickerModelViewParams,
): DiscordModelPickerRenderedView {
  const providerPage = normalizeModelPickerPage(params.providerPage);
  const modelPage = getDiscordModelPickerModelPage({
    data: params.data,
    provider: params.provider,
    page: params.page,
    bucket: params.modelBucket,
  });

  if (!modelPage) {
    const rows: Row<Button>[] = [
      new Row([
        createModelPickerButton("Back", {
          command: params.command,
          action: "back",
          view: "providers",
          page: providerPage,
          userId: params.userId,
        }),
      ]),
    ];

    return buildRenderedShell({
      title: "Model Picker",
      refreshWarning: params.data.refreshWarning,
      detailLines: [
        formatCurrentModelLine(params.currentModel),
        `Provider not found: ${normalizeProviderId(params.provider)}`,
      ],
      rows,
      footer: "Choose a different provider.",
    });
  }

  const {
    rows: modelRows,
    buttonRow,
    runtimeChoices: choices,
    selectedRuntime,
  } = buildModelRows({ ...params, providerPage, modelPage });
  const pendingRuntime = params.pendingRuntime?.trim();

  const bucketRow = buildBucketSelectRow({
    command: params.command,
    userId: params.userId,
    view: "models",
    buckets: modelPage.buckets,
    currentBucketId: modelPage.bucket?.id,
    provider: modelPage.provider,
    // Keep the runtime identity stable when the current choice list changes.
    runtimeToken: pendingRuntime ? createDiscordModelPickerRuntimeToken(pendingRuntime) : undefined,
    providerPage,
  });

  const defaultModel = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  const selectedRuntimeLabel = choices?.find((choice) => choice.id === selectedRuntime)?.label;
  const pendingLine = !params.pendingModel
    ? "Select a model, then press Submit."
    : !supportsDiscordModelPickerRuntimeChoices()
      ? `Selected: ${params.pendingModel} (press Submit)`
      : choices === undefined
        ? "Could not confirm how to run this model. Open /models to try again."
        : choices.length === 0
          ? "This model cannot run with your current connections. Choose another model."
          : selectedRuntimeLabel
            ? `Selected: ${params.pendingModel} · ${selectedRuntimeLabel} (press Submit)`
            : "Choose how to run this model, then press Submit.";

  const detailLines = [formatCurrentModelLine(params.currentModel), `Default: ${defaultModel}`];
  if (modelPage.totalPages > 1) {
    detailLines.push(
      `${modelPage.provider}: page ${modelPage.page}/${modelPage.totalPages} · ${modelPage.totalItems} models`,
    );
  }

  return buildRenderedShell({
    title: "Model Picker",
    refreshWarning: params.data.refreshWarning,
    detailLines,
    preRowText: pendingLine,
    rows: bucketRow ? [bucketRow, ...modelRows] : modelRows,
    trailingRows: [buttonRow],
  });
}

type DiscordModelPickerRecentsViewParams = {
  command: DiscordModelPickerCommandContext;
  userId: string;
  data: ModelsProviderData;
  quickModels: string[];
  currentModel?: string;
  runtime?: string;
  runtimeToken?: string;
  provider?: string;
  page?: number;
  providerPage?: number;
  modelBucket?: string;
};

function formatRecentsButtonLabel(modelRef: string, suffix?: string): string {
  const maxLen = 80;
  const label = suffix ? `${modelRef} ${suffix}` : modelRef;
  if (label.length <= maxLen) {
    return label;
  }
  return suffix
    ? `${sliceUtf16Safe(modelRef, 0, maxLen - suffix.length - 2)}… ${suffix}`
    : `${sliceUtf16Safe(modelRef, 0, maxLen - 1)}…`;
}

function createModelRefToken(modelRef: string): string | undefined {
  const parsed = parseCurrentModelRef(modelRef);
  return parsed ? createDiscordModelPickerModelToken(parsed.provider, parsed.model) : undefined;
}

export function renderDiscordModelPickerRecentsView(
  params: DiscordModelPickerRecentsViewParams,
): DiscordModelPickerRenderedView {
  const { data, quickModels, currentModel, modelBucket, ...navigationState } = params;
  const recentModels = getDiscordModelPickerRecentModelRefs(data, quickModels);
  const rows = recentModels.map(
    (modelRef, index) =>
      new Row([
        createModelPickerButton(
          formatRecentsButtonLabel(modelRef, index === 0 ? "(default)" : undefined),
          {
            ...navigationState,
            action: "submit",
            view: "recents",
            recentSlot: index + 1,
            modelToken: createModelRefToken(modelRef),
          },
        ),
      ]),
  );

  const backRow: Row<Button> = new Row([
    createModelPickerButton("Back", {
      ...navigationState,
      action: "back",
      view: "models",
      modelBucket,
    }),
  ]);

  return buildRenderedShell({
    title: "Recents",
    refreshWarning: data.refreshWarning,
    detailLines: [
      "Models you've previously selected appear here.",
      formatCurrentModelLine(currentModel),
    ],
    preRowText: "Tap a model to switch.",
    rows,
    trailingRows: [backRow],
  });
}
