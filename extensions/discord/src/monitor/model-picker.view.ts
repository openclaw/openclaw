import type { APISelectMenuOption } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import type {
  ModelsProviderData,
  ModelsRuntimeChoice,
} from "openclaw/plugin-sdk/models-provider-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
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
  normalizeModelPickerPage,
  type DiscordModelPickerBucket,
  type DiscordModelPickerCommandContext,
  type DiscordModelPickerModelPage,
  type DiscordModelPickerPage,
  type DiscordModelPickerProviderItem,
} from "./model-picker.state.js";

const DISCORD_MODEL_PICKER_PAGE_INDICATOR_CUSTOM_ID = "mdlpk:nav-indicator";

type DiscordModelPickerButtonOptions = {
  label: string;
  customId: string;
  style?: ButtonStyle;
  disabled?: boolean;
};

type DiscordModelPickerCurrentModelRef = {
  provider: string;
  model: string;
};

type DiscordModelPickerRow = Row<Button> | Row<StringSelectMenu>;
type CompactRuntimeState = {
  runtime?: string;
  runtimeToken?: string;
};

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

type DiscordModelPickerModelViewParams = {
  command: DiscordModelPickerCommandContext;
  userId: string;
  data: ModelsProviderData;
  provider: string;
  page?: number;
  providerPage?: number;
  providerBucket?: string;
  modelBucket?: string;
  currentModel?: string;
  currentRuntime?: string;
  pendingModel?: string;
  pendingModelIndex?: number;
  pendingRuntime?: string;
  quickModels?: string[];
};

function parseCurrentModelRef(raw?: string): DiscordModelPickerCurrentModelRef | null {
  const trimmed = raw?.trim();
  const match = trimmed?.match(/^([^/]+)\/(.+)$/u);
  if (!match) {
    return null;
  }
  const providerText = match[1];
  const model = match[2];
  if (providerText === undefined || model === undefined) {
    return null;
  }
  const provider = normalizeProviderId(providerText);
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

function createModelPickerButton(params: DiscordModelPickerButtonOptions): Button {
  class DiscordModelPickerButton extends Button {
    label = params.label;
    customId = params.customId;
    override style = params.style ?? ButtonStyle.Secondary;
    override disabled = params.disabled ?? false;
  }
  return new DiscordModelPickerButton();
}

function createModelSelect(params: {
  customId: string;
  options: APISelectMenuOption[];
  placeholder?: string;
  disabled?: boolean;
}): StringSelectMenu {
  class DiscordModelPickerSelect extends StringSelectMenu {
    customId = params.customId;
    override options = params.options;
    override minValues = 1;
    override maxValues = 1;
    override placeholder = params.placeholder;
    override disabled = params.disabled ?? false;
  }
  return new DiscordModelPickerSelect();
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
  if (params.buckets.length <= 1) {
    return null;
  }
  const options: APISelectMenuOption[] = params.buckets.map((bucket) => ({
    label: bucket.label,
    value: bucket.id,
    default: bucket.id === params.currentBucketId,
  }));
  // The select value carries the bucket; derive the provider bucket on interaction
  // to keep long provider and user IDs within Discord's 100-character custom-id cap.
  const select = createModelSelect({
    customId: buildDiscordModelPickerCustomId({
      command: params.command,
      action: "bucket",
      view: params.view,
      userId: params.userId,
      page: 1,
      provider: params.provider,
      runtime: params.runtime,
      runtimeToken: params.runtimeToken,
      providerPage: params.providerPage,
      modelIndex: params.modelIndex,
    }),
    options,
    placeholder:
      params.view === "providers"
        ? "Filter providers by letter range"
        : "Filter models by letter range",
  });
  return new Row([select]);
}

function getRuntimeChoices(params: {
  data: ModelsProviderData;
  provider: string;
  modelRef?: string;
}): ModelsRuntimeChoice[] | undefined {
  const model = parseCurrentModelRef(params.modelRef);
  return getDiscordModelPickerRuntimeChoices(
    params.data,
    params.provider,
    model?.provider === normalizeProviderId(params.provider) ? model.model : undefined,
  );
}

function resolveExplicitRuntimeState(params: {
  currentRuntime?: string;
  pendingRuntime?: string;
}): string | undefined {
  // Keep an unavailable explicit choice visible until the user confirms an eligible runtime.
  const runtime = params.pendingRuntime?.trim() || params.currentRuntime?.trim();
  return runtime && runtime !== "auto" && runtime !== "default" ? runtime : undefined;
}

function getActiveBucketId(
  bucket: DiscordModelPickerBucket | null | undefined,
): string | undefined {
  return bucket && bucket.id !== "all" ? bucket.id : undefined;
}

function resolveCompactRuntimeState(params: {
  currentRuntime?: string;
  pendingRuntime?: string;
}): CompactRuntimeState {
  if (!supportsDiscordModelPickerRuntimeChoices()) {
    return {};
  }
  const runtime = resolveExplicitRuntimeState(params);
  return runtime ? { runtimeToken: createDiscordModelPickerRuntimeToken(runtime) } : {};
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
    components: [container],
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
  const options: APISelectMenuOption[] = params.page.items.map((provider) => ({
    label: provider.id,
    value: provider.id,
    default: provider.id === params.currentProvider,
    ...(params.showModelCounts
      ? { description: `${provider.count} ${provider.count === 1 ? "model" : "models"}` }
      : {}),
  }));
  return new Row([
    createModelSelect({
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "provider",
        view: "models",
        provider: params.provider,
        page: params.page.page,
        providerPage: params.page.page,
        providerBucket: params.providerBucket,
        userId: params.userId,
      }),
      options,
      placeholder: "Select provider",
    }),
  ]);
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
    createModelPickerButton({
      label,
      disabled: !enabled,
      customId: buildDiscordModelPickerCustomId({
        ...navigationState,
        action: "nav",
        page: targetPage,
      }),
    });
  const indicatorButton = createModelPickerButton({
    label: `Page ${page}/${totalPages}`,
    disabled: true,
    customId: DISCORD_MODEL_PICKER_PAGE_INDICATOR_CUSTOM_ID,
  });
  return new Row([
    createNavigationButton("◀ Prev", Math.max(1, page - 1), hasPrev),
    indicatorButton,
    createNavigationButton("Next ▶", Math.min(totalPages, page + 1), hasNext),
  ]);
}

function buildModelRows(
  params: Omit<DiscordModelPickerModelViewParams, "provider" | "page" | "modelBucket"> & {
    providerPage: number;
    modelPage: DiscordModelPickerModelPage & {
      bucket?: DiscordModelPickerBucket | null;
      buckets?: DiscordModelPickerBucket[];
    };
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

  const hasQuickModels = (params.quickModels ?? []).length > 0;

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
  const modelBucketingActive = (params.modelPage.buckets?.length ?? 0) > 1;
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

  const runtimeChoices = getRuntimeChoices({
    data: params.data,
    provider: params.modelPage.provider,
    modelRef: params.pendingModel ?? params.currentModel,
  });
  const currentRuntime =
    parsedCurrentModel?.provider === params.modelPage.provider ? params.currentRuntime : undefined;
  const explicitRuntime = resolveExplicitRuntimeState({
    currentRuntime,
    pendingRuntime: params.pendingRuntime,
  });
  const selectedRuntime = explicitRuntime
    ? runtimeChoices?.find((choice) => choice.id === explicitRuntime)?.id
    : runtimeChoices?.[0]?.id;
  const compactRuntime = resolveCompactRuntimeState({
    currentRuntime,
    pendingRuntime: params.pendingRuntime,
  });

  if (
    runtimeChoices &&
    (runtimeChoices.length > 1 || (runtimeChoices.length === 1 && selectedRuntime === undefined))
  ) {
    // The selected runtime travels in the select interaction value; omitting
    // it here leaves enough customId budget to preserve the browse bucket.
    rows.push(
      new Row([
        createModelSelect({
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "runtime",
            view: "models",
            provider: params.modelPage.provider,
            page: params.modelPage.page,
            providerPage: providerPage.page,
            modelIndex: params.pendingModelIndex,
            modelToken: pendingModelToken,
            ...(params.pendingModelIndex === undefined && activeModelBucket
              ? { modelBucket: activeModelBucket }
              : {}),
            userId: params.userId,
          }),
          options: runtimeChoices.map((choice) => {
            const option: APISelectMenuOption = {
              label: choice.label,
              value: choice.id,
              default: choice.id === selectedRuntime,
            };
            if (choice.description) {
              option.description = choice.description;
            }
            return option;
          }),
          placeholder: "Choose how to run this model",
        }),
      ]),
    );
  }

  const selectedModelRef = parsedPendingModel ?? parsedCurrentModel;
  const modelOptions: APISelectMenuOption[] = params.modelPage.items.map((model) => ({
    label: model,
    value: model,
    default: selectedModelRef
      ? selectedModelRef.provider === params.modelPage.provider && selectedModelRef.model === model
      : false,
  }));

  // Derive both buckets from the selected provider/model to preserve custom-id budget.
  rows.push(
    new Row([
      createModelSelect({
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "model",
          view: "models",
          provider: params.modelPage.provider,
          ...compactRuntime,
          page: params.modelPage.page,
          providerPage: providerPage.page,
          userId: params.userId,
        }),
        options: modelOptions,
        placeholder: `Select ${params.modelPage.provider} model`,
      }),
    ]),
  );

  const modelNavRow = buildPaginationRow({
    command: params.command,
    userId: params.userId,
    view: "models",
    page: params.modelPage.page,
    totalPages: params.modelPage.totalPages,
    hasPrev: params.modelPage.hasPrev,
    hasNext: params.modelPage.hasNext,
    provider: params.modelPage.provider,
    ...compactRuntime,
    providerPage: providerPage.page,
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
    Boolean(parsedCurrentModel) &&
    parsedCurrentModel?.provider === resolvedDefault.provider &&
    parsedCurrentModel?.model === resolvedDefault.model;

  const hasPendingSelection =
    Boolean(parsedPendingModel) &&
    parsedPendingModel?.provider === params.modelPage.provider &&
    typeof params.pendingModelIndex === "number" &&
    params.pendingModelIndex > 0;

  const modelActionState = {
    command: params.command,
    provider: params.modelPage.provider,
    ...compactRuntime,
    page: params.modelPage.page,
    providerPage: providerPage.page,
    userId: params.userId,
  };
  const buttonRowItems: Button[] = [
    createModelPickerButton({
      label: "Providers",
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "back",
        view: "providers",
        page: providerPage.page,
        providerBucket: activeProviderBucket,
        userId: params.userId,
      }),
    }),
    createModelPickerButton({
      label: "Cancel",
      customId: buildDiscordModelPickerCustomId({
        ...modelActionState,
        action: "cancel",
        view: "models",
      }),
    }),
    createModelPickerButton({
      label: "Reset to default",
      disabled: shouldDisableReset,
      customId: buildDiscordModelPickerCustomId({
        ...modelActionState,
        action: "reset",
        view: "models",
      }),
    }),
  ];

  if (hasQuickModels) {
    buttonRowItems.push(
      createModelPickerButton({
        label: "Recents",
        customId: buildDiscordModelPickerCustomId({
          ...modelActionState,
          action: "recents",
          view: "recents",
          modelBucket: activeModelBucket,
        }),
      }),
    );
  }

  buttonRowItems.push(
    createModelPickerButton({
      label: "Submit",
      style: ButtonStyle.Primary,
      disabled:
        !hasPendingSelection ||
        (supportsDiscordModelPickerRuntimeChoices() && selectedRuntime === undefined),
      customId: buildDiscordModelPickerCustomId({
        ...modelActionState,
        action: "submit",
        view: "models",
        modelIndex: params.pendingModelIndex,
        modelToken: pendingModelToken,
      }),
    }),
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
        createModelPickerButton({
          label: "Back",
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "back",
            view: "providers",
            page: providerPage,
            userId: params.userId,
          }),
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

  const rows: DiscordModelPickerRow[] = [];
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
  if (bucketRow) {
    rows.push(bucketRow);
  }
  rows.push(...modelRows);

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
    rows,
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
  const defaultModelRef = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  const rows: DiscordModelPickerRow[] = [];

  const recentModels = [
    defaultModelRef,
    ...params.quickModels.filter((modelRef) => modelRef !== defaultModelRef),
  ];
  for (const [index, modelRef] of recentModels.entries()) {
    rows.push(
      new Row([
        createModelPickerButton({
          label: formatRecentsButtonLabel(modelRef, index === 0 ? "(default)" : undefined),
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "submit",
            view: "recents",
            recentSlot: index + 1,
            modelToken: createModelRefToken(modelRef),
            provider: params.provider,
            runtime: params.runtime,
            runtimeToken: params.runtimeToken,
            page: params.page,
            providerPage: params.providerPage,
            userId: params.userId,
          }),
        }),
      ]),
    );
  }

  const backRow: Row<Button> = new Row([
    createModelPickerButton({
      label: "Back",
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "back",
        view: "models",
        provider: params.provider,
        runtime: params.runtime,
        runtimeToken: params.runtimeToken,
        page: params.page,
        providerPage: params.providerPage,
        modelBucket: params.modelBucket,
        userId: params.userId,
      }),
    }),
  ]);

  return buildRenderedShell({
    title: "Recents",
    refreshWarning: params.data.refreshWarning,
    detailLines: [
      "Models you've previously selected appear here.",
      formatCurrentModelLine(params.currentModel),
    ],
    preRowText: "Tap a model to switch.",
    rows,
    trailingRows: [backRow],
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
