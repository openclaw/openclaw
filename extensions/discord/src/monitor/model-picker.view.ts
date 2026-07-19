// Discord plugin module implements model picker.view behavior.
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
  type MessagePayloadObject,
  type TopLevelComponents,
} from "../internal/discord.js";
import {
  DISCORD_MODEL_PICKER_RUNTIME_PAGE_NEXT_VALUE,
  DISCORD_MODEL_PICKER_RUNTIME_PAGE_PREV_VALUE,
  buildDiscordModelPickerCustomId,
  createDiscordModelPickerModelFingerprint,
  createDiscordModelPickerProviderFingerprint,
  createDiscordModelPickerRuntimeFingerprint,
  getDiscordModelPickerRuntimeChoices,
  getDiscordModelPickerModelPage,
  getDiscordModelPickerProviderPage,
  normalizeModelPickerPage,
  type DiscordModelPickerBucket,
  type DiscordModelPickerCommandContext,
  type DiscordModelPickerLayout,
  type DiscordModelPickerModelPage,
  type DiscordModelPickerPage,
  type DiscordModelPickerProviderItem,
} from "./model-picker.state.js";

const DISCORD_MODEL_PICKER_PAGE_INDICATOR_CUSTOM_ID = "mdlpk:nav-indicator";
const DISCORD_SELECT_MAX_OPTIONS = 25;
const DISCORD_SELECT_OPTION_MAX_CHARS = 100;
const DISCORD_SELECT_PLACEHOLDER_MAX_CHARS = 150;
const DISCORD_CLASSIC_CONTENT_MAX_CHARS = 2000;
const DISCORD_TEXT_DISPLAY_MAX_CHARS = 4000;
// Two slots remain available for previous/next entries on middle pages.
const DISCORD_RUNTIME_SELECT_PAGE_SIZE = 23;

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
  runtimeFingerprint?: string;
};

type DiscordModelPickerRenderShellParams = {
  layout: DiscordModelPickerLayout;
  title: string;
  detailLines: string[];
  rows: DiscordModelPickerRow[];
  footer?: string;
  /** Text shown after the divider but before the interactive rows. */
  preRowText?: string;
  /** Extra rows appended after the main rows, preceded by a divider. */
  trailingRows?: DiscordModelPickerRow[];
};

type DiscordModelPickerRenderedView = {
  layout: DiscordModelPickerLayout;
  content?: string;
  components: TopLevelComponents[];
};

type DiscordModelPickerProviderViewParams = {
  command: DiscordModelPickerCommandContext;
  interactionBinding: string;
  data: ModelsProviderData;
  page?: number;
  providerBucket?: string;
  currentModel?: string;
  layout?: DiscordModelPickerLayout;
};

type DiscordModelPickerModelViewParams = {
  command: DiscordModelPickerCommandContext;
  interactionBinding: string;
  data: ModelsProviderData;
  provider: string;
  page?: number;
  providerPage?: number;
  providerBucket?: string;
  modelBucket?: string;
  currentModel?: string;
  currentRuntime?: string;
  runtimePage?: number;
  pendingModel?: string;
  pendingModelIndex?: number;
  pendingRuntime?: string;
  quickModels?: string[];
  layout?: DiscordModelPickerLayout;
};

function parseCurrentModelRef(raw?: string): DiscordModelPickerCurrentModelRef | null {
  const separator = raw?.indexOf("/") ?? -1;
  if (!raw || separator <= 0 || separator === raw.length - 1) {
    return null;
  }
  const providerText = raw.slice(0, separator);
  const model = raw.slice(separator + 1);
  const provider = normalizeProviderId(providerText);
  // Preserve the model suffix exactly as entered after "/" so select defaults
  // continue to mirror the stored ref for Discord interactions.
  if (!provider || !model.trim()) {
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
  const options = params.options.map((option) => {
    if (option.value.length > DISCORD_SELECT_OPTION_MAX_CHARS) {
      throw new Error(
        `Discord select option value exceeds ${DISCORD_SELECT_OPTION_MAX_CHARS} chars`,
      );
    }
    return {
      ...option,
      label: formatSelectOptionText(option.label),
      ...(option.description ? { description: formatSelectOptionText(option.description) } : {}),
    };
  });
  class DiscordModelPickerSelect extends StringSelectMenu {
    customId = params.customId;
    override options = options;
    override minValues = 1;
    override maxValues = 1;
    override placeholder = params.placeholder
      ? formatSelectPlaceholderText(params.placeholder)
      : undefined;
    override disabled = params.disabled ?? false;
  }
  return new DiscordModelPickerSelect();
}

function formatSelectOptionText(value: string): string {
  if (value.length <= DISCORD_SELECT_OPTION_MAX_CHARS) {
    return value;
  }
  return `${sliceUtf16Safe(value, 0, DISCORD_SELECT_OPTION_MAX_CHARS - 1)}…`;
}

function formatSelectPlaceholderText(value: string): string {
  if (value.length <= DISCORD_SELECT_PLACEHOLDER_MAX_CHARS) {
    return value;
  }
  return `${sliceUtf16Safe(value, 0, DISCORD_SELECT_PLACEHOLDER_MAX_CHARS - 1)}…`;
}

function truncateDiscordText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${sliceUtf16Safe(value, 0, maxChars - 1)}…`;
}

export function truncateDiscordModelPickerTextDisplay(value: string): string {
  return truncateDiscordText(value, DISCORD_TEXT_DISPLAY_MAX_CHARS);
}

/**
 * Build the alpha-bucket select row that appears above the provider/model
 * surface when the list exceeds {@link DISCORD_MODEL_PICKER_BUCKET_THRESHOLD}.
 *
 * Selecting a bucket emits action=bucket. The chosen bucket travels in the
 * select value, while the custom_id carries only the stable context needed to
 * rebuild the picker under Discord's 100-character custom_id limit.
 */
function buildBucketSelectRow(params: {
  command: DiscordModelPickerCommandContext;
  interactionBinding: string;
  view: "providers" | "models";
  buckets: DiscordModelPickerBucket[];
  currentBucketId: string | undefined;
  provider?: string;
  runtimeFingerprint?: string;
  providerPage?: number;
  providerBucket?: string;
}): Row<StringSelectMenu> | null {
  if (params.buckets.length <= 1) {
    return null;
  }
  const options: APISelectMenuOption[] = params.buckets.map((bucket) => ({
    label: bucket.label,
    value: bucket.id,
    default: bucket.id === params.currentBucketId,
  }));
  // The bucket select uses `action: "bucket"` so the interaction handler
  // can route the chosen value (interaction.values[0]) into providerBucket
  // or modelBucket and re-render. page resets to 1. providerBucket is
  // intentionally omitted from the customId — when view=models the handler
  // derives the provider bucket from `params.provider` via
  // findProviderBucketId, keeping the customId under Discord's 100-char
  // cap for long provider ids + interaction bindings.
  const select = createModelSelect({
    customId: buildDiscordModelPickerCustomId({
      command: params.command,
      action: "bucket",
      view: params.view,
      interactionBinding: params.interactionBinding,
      page: 1,
      provider: params.provider,
      runtimeFingerprint: params.runtimeFingerprint,
      providerPage: params.providerPage,
    }),
    options,
    placeholder:
      params.view === "providers"
        ? "Filter providers by letter range"
        : "Filter models by letter range",
  });
  return new Row([select]);
}

function resolveSelectedRuntime(params: {
  data: ModelsProviderData;
  provider: string;
  currentRuntime?: string;
  pendingRuntime?: string;
}): string {
  const choices = getDiscordModelPickerRuntimeChoices({
    data: params.data,
    provider: params.provider,
  });
  const allowed = new Set(choices.map((choice) => choice.id));
  const pending = params.pendingRuntime?.trim();
  if (pending && allowed.has(pending)) {
    return pending;
  }
  const current = params.currentRuntime?.trim();
  if (current && allowed.has(current)) {
    return current;
  }
  return choices[0]?.id ?? "openclaw";
}

function getRuntimeChoicePage(params: {
  choices: ModelsRuntimeChoice[];
  selectedRuntime: string;
  page?: number;
}): {
  items: ModelsRuntimeChoice[];
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
} {
  const pageSize =
    params.choices.length > DISCORD_SELECT_MAX_OPTIONS
      ? DISCORD_RUNTIME_SELECT_PAGE_SIZE
      : DISCORD_SELECT_MAX_OPTIONS;
  const totalPages = Math.max(1, Math.ceil(params.choices.length / pageSize));
  const selectedIndex = params.choices.findIndex((choice) => choice.id === params.selectedRuntime);
  const selectedPage = selectedIndex >= 0 ? Math.floor(selectedIndex / pageSize) + 1 : 1;
  const requestedPage =
    params.page === undefined ? selectedPage : normalizeModelPickerPage(params.page);
  const page = Math.min(totalPages, requestedPage);
  const start = (page - 1) * pageSize;
  return {
    items: params.choices.slice(start, start + pageSize),
    page,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

function resolveExplicitRuntimeState(params: {
  choices: ModelsRuntimeChoice[];
  currentRuntime?: string;
  pendingRuntime?: string;
}): string | undefined {
  const allowed = new Set(params.choices.map((choice) => choice.id));
  const pending = params.pendingRuntime?.trim();
  if (pending && allowed.has(pending)) {
    return pending;
  }
  const current = params.currentRuntime?.trim();
  if (current && current !== "auto" && current !== "default" && allowed.has(current)) {
    return current;
  }
  return undefined;
}

function getActiveBucketId(
  bucket: DiscordModelPickerBucket | null | undefined,
): string | undefined {
  return bucket && bucket.id !== "all" ? bucket.id : undefined;
}

function resolveCompactRuntimeState(params: {
  provider: string;
  choices: ModelsRuntimeChoice[];
  currentRuntime?: string;
  pendingRuntime?: string;
}): CompactRuntimeState {
  const stateRuntime = resolveExplicitRuntimeState(params);
  return stateRuntime
    ? {
        runtimeFingerprint: createDiscordModelPickerRuntimeFingerprint(
          params.provider,
          stateRuntime,
        ),
      }
    : {};
}

function buildRenderedShell(
  params: DiscordModelPickerRenderShellParams,
): DiscordModelPickerRenderedView {
  if (params.layout === "classic") {
    const lines = [
      params.title,
      ...params.detailLines,
      params.preRowText ? "" : undefined,
      params.preRowText,
      "",
      params.footer,
    ].filter(Boolean);
    return {
      layout: "classic",
      content: truncateDiscordText(lines.join("\n"), DISCORD_CLASSIC_CONTENT_MAX_CHARS),
      components: [...params.rows, ...(params.trailingRows ?? [])],
    };
  }

  const containerComponents: Array<TextDisplay | Separator | DiscordModelPickerRow> = [
    new TextDisplay(truncateDiscordModelPickerTextDisplay(`## ${params.title}`)),
  ];
  if (params.detailLines.length > 0) {
    containerComponents.push(
      new TextDisplay(truncateDiscordModelPickerTextDisplay(params.detailLines.join("\n"))),
    );
  }
  containerComponents.push(new Separator({ divider: true, spacing: "small" }));
  if (params.preRowText) {
    containerComponents.push(
      new TextDisplay(truncateDiscordModelPickerTextDisplay(params.preRowText)),
    );
  }
  containerComponents.push(...params.rows);
  if (params.trailingRows && params.trailingRows.length > 0) {
    containerComponents.push(new Separator({ divider: true, spacing: "small" }));
    containerComponents.push(...params.trailingRows);
  }
  if (params.footer) {
    containerComponents.push(new Separator({ divider: false, spacing: "small" }));
    containerComponents.push(
      new TextDisplay(truncateDiscordModelPickerTextDisplay(`-# ${params.footer}`)),
    );
  }

  const container = new Container(containerComponents);
  return {
    layout: "v2",
    components: [container],
  };
}

function buildProviderSelectRow(params: {
  command: DiscordModelPickerCommandContext;
  interactionBinding: string;
  page: DiscordModelPickerPage<DiscordModelPickerProviderItem>;
  currentProvider?: string;
  providerBucket?: string;
}): Row<StringSelectMenu> | null {
  if (params.page.items.length === 0) {
    return null;
  }
  const options: APISelectMenuOption[] = params.page.items.map((provider) => ({
    label: provider.id,
    value: createDiscordModelPickerProviderFingerprint(provider.id),
    default: provider.id === params.currentProvider,
    description: `${provider.count} ${provider.count === 1 ? "model" : "models"}`,
  }));
  return new Row([
    createModelSelect({
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "provider",
        view: "models",
        page: params.page.page,
        providerPage: params.page.page,
        providerBucket: params.providerBucket,
        interactionBinding: params.interactionBinding,
      }),
      options,
      placeholder: "Select provider",
    }),
  ]);
}

function buildPaginationRow(params: {
  command: DiscordModelPickerCommandContext;
  interactionBinding: string;
  view: "providers" | "models";
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  provider?: string;
  runtimeFingerprint?: string;
  providerPage?: number;
  modelFingerprint?: string;
  providerBucket?: string;
  modelBucket?: string;
}): Row<Button> | null {
  if (params.totalPages <= 1) {
    return null;
  }
  const prevButton = createModelPickerButton({
    label: "◀ Prev",
    style: ButtonStyle.Secondary,
    disabled: !params.hasPrev,
    customId: buildDiscordModelPickerCustomId({
      command: params.command,
      action: "nav",
      view: params.view,
      provider: params.provider,
      runtimeFingerprint: params.runtimeFingerprint,
      page: Math.max(1, params.page - 1),
      providerPage: params.providerPage,
      modelFingerprint: params.modelFingerprint,
      providerBucket: params.providerBucket,
      modelBucket: params.modelBucket,
      interactionBinding: params.interactionBinding,
    }),
  });
  const indicatorButton = createModelPickerButton({
    label: `Page ${params.page}/${params.totalPages}`,
    style: ButtonStyle.Secondary,
    disabled: true,
    customId: DISCORD_MODEL_PICKER_PAGE_INDICATOR_CUSTOM_ID,
  });
  const nextButton = createModelPickerButton({
    label: "Next ▶",
    style: ButtonStyle.Secondary,
    disabled: !params.hasNext,
    customId: buildDiscordModelPickerCustomId({
      command: params.command,
      action: "nav",
      view: params.view,
      provider: params.provider,
      runtimeFingerprint: params.runtimeFingerprint,
      page: Math.min(params.totalPages, params.page + 1),
      providerPage: params.providerPage,
      modelFingerprint: params.modelFingerprint,
      providerBucket: params.providerBucket,
      modelBucket: params.modelBucket,
      interactionBinding: params.interactionBinding,
    }),
  });
  return new Row([prevButton, indicatorButton, nextButton]);
}

function buildModelRows(params: {
  command: DiscordModelPickerCommandContext;
  interactionBinding: string;
  data: ModelsProviderData;
  providerPage: number;
  modelPage: DiscordModelPickerModelPage & {
    bucket?: DiscordModelPickerBucket | null;
    buckets?: DiscordModelPickerBucket[];
  };
  currentModel?: string;
  currentRuntime?: string;
  runtimePage?: number;
  pendingModel?: string;
  pendingModelIndex?: number;
  pendingRuntime?: string;
  quickModels?: string[];
  providerBucket?: string;
}): { rows: DiscordModelPickerRow[]; buttonRow: Row<Button> } {
  const parsedCurrentModel = parseCurrentModelRef(params.currentModel);
  const parsedPendingModel = parseCurrentModelRef(params.pendingModel);
  const pendingModelFingerprint = parsedPendingModel
    ? createDiscordModelPickerModelFingerprint(
        parsedPendingModel.provider,
        parsedPendingModel.model,
      )
    : undefined;
  const rows: DiscordModelPickerRow[] = [];

  const hasQuickModels = (params.quickModels ?? []).length > 0;

  // Preserve the active provider bucket inside the model view so the
  // "switch provider" select shows the same letter range the user picked
  // when entering the model view. Without this the select always falls
  // back to the first bucket and silently jumps the user out of "H–N".
  const providerPage = getDiscordModelPickerProviderPage({
    data: params.data,
    page: params.providerPage,
    bucket: params.providerBucket,
  });
  const providerOptions: APISelectMenuOption[] = providerPage.items.map((provider) => ({
    label: provider.id,
    value: createDiscordModelPickerProviderFingerprint(provider.id),
    default: provider.id === params.modelPage.provider,
  }));
  const activeProviderBucket = getActiveBucketId(providerPage.bucket);
  const activeModelBucket = getActiveBucketId(params.modelPage.bucket);
  // Discord classic messages cap at five action rows. A bucketed model list can
  // need bucket + runtime + model + pagination rows, so omit the provider select
  // and reserve row five for the trailing mutation controls.
  const modelBucketingActive = (params.modelPage.buckets?.length ?? 0) > 1;
  if (!modelBucketingActive) {
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
            providerBucket: activeProviderBucket,
            interactionBinding: params.interactionBinding,
          }),
          options: providerOptions,
          placeholder: "Select provider",
        }),
      ]),
    );
  }

  const runtimeChoices = getDiscordModelPickerRuntimeChoices({
    data: params.data,
    provider: params.modelPage.provider,
  });
  const selectedRuntime = resolveSelectedRuntime({
    data: params.data,
    provider: params.modelPage.provider,
    currentRuntime: params.currentRuntime,
    pendingRuntime: params.pendingRuntime,
  });
  const compactRuntime = resolveCompactRuntimeState({
    provider: params.modelPage.provider,
    choices: runtimeChoices,
    currentRuntime: params.currentRuntime,
    pendingRuntime: params.pendingRuntime,
  });

  if (runtimeChoices.length > 1) {
    const runtimePage = getRuntimeChoicePage({
      choices: runtimeChoices,
      selectedRuntime,
      page: params.runtimePage,
    });
    const runtimeOptions: APISelectMenuOption[] = [];
    if (runtimePage.hasPrev) {
      runtimeOptions.push({
        label: "◀ Previous runtimes",
        value: DISCORD_MODEL_PICKER_RUNTIME_PAGE_PREV_VALUE,
      });
    }
    runtimeOptions.push(
      ...runtimePage.items.map((choice) => {
        const option: APISelectMenuOption = {
          label: choice.label,
          value: createDiscordModelPickerRuntimeFingerprint(params.modelPage.provider, choice.id),
          default: choice.id === selectedRuntime,
        };
        if (choice.description) {
          option.description = choice.description;
        }
        return option;
      }),
    );
    if (runtimePage.hasNext) {
      runtimeOptions.push({
        label: "Next runtimes ▶",
        value: DISCORD_MODEL_PICKER_RUNTIME_PAGE_NEXT_VALUE,
      });
    }
    // Preserve explicit runtime state in the custom id so selecting a page
    // navigation entry cannot reset it while the fresh catalog is reloaded.
    rows.push(
      new Row([
        createModelSelect({
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "runtime",
            view: "models",
            provider: params.modelPage.provider,
            ...(runtimePage.totalPages > 1
              ? { ...compactRuntime, runtimePage: runtimePage.page }
              : {}),
            page: params.modelPage.page,
            providerPage: providerPage.page,
            modelFingerprint: pendingModelFingerprint,
            ...(params.pendingModelIndex === undefined && activeModelBucket
              ? { modelBucket: activeModelBucket }
              : {}),
            interactionBinding: params.interactionBinding,
          }),
          options: runtimeOptions,
          placeholder:
            runtimePage.totalPages > 1
              ? `Select runtime (page ${runtimePage.page}/${runtimePage.totalPages})`
              : "Select runtime",
        }),
      ]),
    );
  }

  const selectedModelRef = parsedPendingModel ?? parsedCurrentModel;
  const modelOptions: APISelectMenuOption[] = params.modelPage.items.map((model) => ({
    label: model,
    value: createDiscordModelPickerModelFingerprint(params.modelPage.provider, model),
    default: selectedModelRef
      ? selectedModelRef.provider === params.modelPage.provider && selectedModelRef.model === model
      : false,
  }));

  // Model select customId omits providerBucket and modelBucket: both are
  // pure functions of the durable state (provider + picked model) and
  // including them risks blowing past Discord's 100-char customId cap for
  // long provider ids + interaction bindings + active bucket strings. The
  // action=model handler derives both buckets via findProviderBucketId /
  // findModelBucketId at re-render time.
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
          interactionBinding: params.interactionBinding,
        }),
        options: modelOptions,
        placeholder: `Select ${params.modelPage.provider} model`,
      }),
    ]),
  );

  const modelNavRow = buildPaginationRow({
    command: params.command,
    interactionBinding: params.interactionBinding,
    view: "models",
    page: params.modelPage.page,
    totalPages: params.modelPage.totalPages,
    hasPrev: params.modelPage.hasPrev,
    hasNext: params.modelPage.hasNext,
    provider: params.modelPage.provider,
    ...compactRuntime,
    providerPage: providerPage.page,
    modelFingerprint: pendingModelFingerprint,
    // Model navigation derives providerBucket from provider on interaction;
    // carrying it here can exceed Discord's 100-char customId limit.
    modelBucket:
      params.modelPage.bucket && params.modelPage.bucket.id !== "all"
        ? params.modelPage.bucket.id
        : undefined,
  });
  if (modelNavRow) {
    rows.push(modelNavRow);
  }

  const resolvedDefault = params.data.resolvedDefault;
  const normalizedDefaultProvider = normalizeProviderId(resolvedDefault.provider);
  const defaultAvailable =
    params.data.byProvider.get(normalizedDefaultProvider)?.has(resolvedDefault.model) === true;
  const shouldDisableReset =
    Boolean(parsedCurrentModel) &&
    parsedCurrentModel?.provider === normalizedDefaultProvider &&
    parsedCurrentModel?.model === resolvedDefault.model;

  const hasPendingSelection =
    Boolean(parsedPendingModel) &&
    parsedPendingModel?.provider === params.modelPage.provider &&
    typeof params.pendingModelIndex === "number" &&
    params.pendingModelIndex > 0;

  const buttonRowItems: Button[] = [
    createModelPickerButton({
      label: "Providers",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "back",
        view: "providers",
        page: providerPage.page,
        providerBucket: activeProviderBucket,
        interactionBinding: params.interactionBinding,
      }),
    }),
    createModelPickerButton({
      label: "Cancel",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "cancel",
        view: "models",
        provider: params.modelPage.provider,
        ...compactRuntime,
        page: params.modelPage.page,
        providerPage: providerPage.page,
        interactionBinding: params.interactionBinding,
      }),
    }),
  ];

  if (defaultAvailable) {
    buttonRowItems.push(
      createModelPickerButton({
        label: "Reset to default",
        style: ButtonStyle.Secondary,
        disabled: shouldDisableReset,
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "reset",
          view: "models",
          provider: params.modelPage.provider,
          ...compactRuntime,
          page: params.modelPage.page,
          providerPage: providerPage.page,
          interactionBinding: params.interactionBinding,
        }),
      }),
    );
  }

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
          ...compactRuntime,
          page: params.modelPage.page,
          providerPage: providerPage.page,
          modelBucket: activeModelBucket,
          interactionBinding: params.interactionBinding,
        }),
      }),
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
        ...compactRuntime,
        page: params.modelPage.page,
        providerPage: providerPage.page,
        modelFingerprint: pendingModelFingerprint,
        interactionBinding: params.interactionBinding,
      }),
    }),
  );

  return { rows, buttonRow: new Row(buttonRowItems) };
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
    interactionBinding: params.interactionBinding,
    view: "providers",
    buckets: page.buckets,
    currentBucketId: page.bucket?.id,
  });
  if (bucketRow) {
    rows.push(bucketRow);
  }

  const activeProviderBucket = page.bucket && page.bucket.id !== "all" ? page.bucket.id : undefined;
  const providerRow = buildProviderSelectRow({
    command: params.command,
    interactionBinding: params.interactionBinding,
    page,
    currentProvider: parsedCurrent?.provider,
    providerBucket: activeProviderBucket,
  });
  if (providerRow) {
    rows.push(providerRow);
  }

  const navRow = buildPaginationRow({
    command: params.command,
    interactionBinding: params.interactionBinding,
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
    layout: params.layout ?? "v2",
    title: "Model Picker",
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
            interactionBinding: params.interactionBinding,
          }),
        }),
      ]),
    ];

    return buildRenderedShell({
      layout: params.layout ?? "v2",
      title: "Model Picker",
      detailLines: [
        formatCurrentModelLine(params.currentModel),
        `Provider not found: ${normalizeProviderId(params.provider)}`,
      ],
      rows,
      footer: "Choose a different provider.",
    });
  }

  const { rows: modelRows, buttonRow } = buildModelRows({
    command: params.command,
    interactionBinding: params.interactionBinding,
    data: params.data,
    providerPage,
    modelPage,
    currentModel: params.currentModel,
    currentRuntime: params.currentRuntime,
    runtimePage: params.runtimePage,
    pendingModel: params.pendingModel,
    pendingModelIndex: params.pendingModelIndex,
    pendingRuntime: params.pendingRuntime,
    quickModels: params.quickModels,
    providerBucket: params.providerBucket,
  });
  const runtimeChoices = getDiscordModelPickerRuntimeChoices({
    data: params.data,
    provider: modelPage.provider,
  });
  const pendingRuntime = resolveExplicitRuntimeState({
    choices: runtimeChoices,
    currentRuntime: params.currentRuntime,
    pendingRuntime: params.pendingRuntime,
  });

  const rows: DiscordModelPickerRow[] = [];
  const bucketRow = buildBucketSelectRow({
    command: params.command,
    interactionBinding: params.interactionBinding,
    view: "models",
    buckets: modelPage.buckets,
    currentBucketId: modelPage.bucket?.id,
    provider: modelPage.provider,
    // Carry pending runtime through bucket changes as a stable fingerprint;
    // reordering choices cannot retarget an existing control.
    runtimeFingerprint: pendingRuntime
      ? createDiscordModelPickerRuntimeFingerprint(modelPage.provider, pendingRuntime)
      : undefined,
    providerPage,
    providerBucket: params.providerBucket,
  });
  if (bucketRow) {
    rows.push(bucketRow);
  }
  rows.push(...modelRows);

  const defaultModel = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  const pendingLine = params.pendingModel
    ? `Selected: ${params.pendingModel} · runtime ${resolveSelectedRuntime({
        data: params.data,
        provider: modelPage.provider,
        currentRuntime: params.currentRuntime,
        pendingRuntime: params.pendingRuntime,
      })} (press Submit)`
    : "Select a model, then press Submit.";

  const detailLines = [formatCurrentModelLine(params.currentModel), `Default: ${defaultModel}`];
  if (modelPage.totalPages > 1) {
    detailLines.push(
      `${modelPage.provider}: page ${modelPage.page}/${modelPage.totalPages} · ${modelPage.totalItems} models`,
    );
  }

  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Model Picker",
    detailLines,
    preRowText: pendingLine,
    rows,
    trailingRows: [buttonRow],
  });
}

type DiscordModelPickerRecentsViewParams = {
  command: DiscordModelPickerCommandContext;
  interactionBinding: string;
  data: ModelsProviderData;
  quickModels: string[];
  currentModel?: string;
  runtimeFingerprint?: string;
  provider?: string;
  page?: number;
  providerPage?: number;
  modelBucket?: string;
  layout?: DiscordModelPickerLayout;
};

function formatRecentsButtonLabel(modelRef: string, suffix?: string): string {
  const maxLen = 80;
  const label = suffix ? `${modelRef} ${suffix}` : modelRef;
  if (label.length <= maxLen) {
    return label;
  }
  const trimmed = suffix
    ? `${sliceUtf16Safe(modelRef, 0, maxLen - suffix.length - 2)}… ${suffix}`
    : `${sliceUtf16Safe(modelRef, 0, maxLen - 1)}…`;
  return trimmed;
}

function createModelRefFingerprint(modelRef: string): string | undefined {
  const parsed = parseCurrentModelRef(modelRef);
  return parsed
    ? createDiscordModelPickerModelFingerprint(parsed.provider, parsed.model)
    : undefined;
}

export function renderDiscordModelPickerRecentsView(
  params: DiscordModelPickerRecentsViewParams,
): DiscordModelPickerRenderedView {
  const defaultProvider = normalizeProviderId(params.data.resolvedDefault.provider);
  const defaultModel = params.data.resolvedDefault.model;
  const defaultModelRef = `${defaultProvider}/${defaultModel}`;
  const defaultAvailable = params.data.byProvider.get(defaultProvider)?.has(defaultModel) === true;
  const rows: DiscordModelPickerRow[] = [];

  // Discord classic messages allow at most five action rows. Keep the five
  // most recent non-default models and pack their buttons before the Back row.
  const dedupedQuickModels = [...new Set(params.quickModels)]
    .filter((modelRef) => modelRef !== defaultModelRef)
    .slice(0, 5);
  const modelButtons = [
    ...(defaultAvailable
      ? [
          createModelPickerButton({
            label: formatRecentsButtonLabel(defaultModelRef, "(default)"),
            style: ButtonStyle.Secondary,
            customId: buildDiscordModelPickerCustomId({
              command: params.command,
              action: "submit",
              view: "recents",
              modelFingerprint: createModelRefFingerprint(defaultModelRef),
              provider: params.provider,
              runtimeFingerprint: params.runtimeFingerprint,
              page: params.page,
              providerPage: params.providerPage,
              interactionBinding: params.interactionBinding,
            }),
          }),
        ]
      : []),
    ...dedupedQuickModels.map((modelRef) =>
      createModelPickerButton({
        label: formatRecentsButtonLabel(modelRef),
        style: ButtonStyle.Secondary,
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "submit",
          view: "recents",
          modelFingerprint: createModelRefFingerprint(modelRef),
          provider: params.provider,
          runtimeFingerprint: params.runtimeFingerprint,
          page: params.page,
          providerPage: params.providerPage,
          interactionBinding: params.interactionBinding,
        }),
      }),
    ),
  ];
  if ((params.layout ?? "v2") === "classic") {
    for (let index = 0; index < modelButtons.length; index += 5) {
      rows.push(new Row(modelButtons.slice(index, index + 5)));
    }
  } else {
    rows.push(...modelButtons.map((button) => new Row([button])));
  }

  // Back button after a divider (via trailingRows).
  const backRow: Row<Button> = new Row([
    createModelPickerButton({
      label: "Back",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "back",
        view: "models",
        provider: params.provider,
        runtimeFingerprint: params.runtimeFingerprint,
        page: params.page,
        providerPage: params.providerPage,
        modelBucket: params.modelBucket,
        interactionBinding: params.interactionBinding,
      }),
    }),
  ]);

  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Recents",
    detailLines: [
      "Models you've previously selected appear here.",
      formatCurrentModelLine(params.currentModel),
    ],
    preRowText: "Tap a model to switch.",
    rows,
    trailingRows: [backRow],
  });
}

export function toDiscordModelPickerMessagePayload(
  view: DiscordModelPickerRenderedView,
): MessagePayloadObject {
  if (view.layout === "classic") {
    return {
      content: view.content,
      components: view.components,
    };
  }
  return {
    components: view.components,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
