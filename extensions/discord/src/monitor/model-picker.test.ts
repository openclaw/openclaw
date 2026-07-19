// Discord tests cover model picker plugin behavior.
import { ComponentType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { parseCustomId, serializePayload } from "../internal/discord.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  buildDiscordModelPickerCustomId,
  createDiscordModelPickerInteractionBinding,
  createDiscordModelPickerModelFingerprint,
  createDiscordModelPickerProviderFingerprint,
  createDiscordModelPickerRuntimeFingerprint,
  getDiscordModelPickerModelPage,
  getDiscordModelPickerProviderPage,
  findProviderBucketId,
  findProviderBucketLocation,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
} from "./model-picker.state.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";
import {
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload,
} from "./model-picker.view.js";

const DISCORD_CUSTOM_ID_MAX_CHARS = 100;
const INTERACTION_BINDING = "test_binding";
const DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE = 25;
const DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE = 25;
const DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX = 25;

function parseDiscordModelPickerCustomId(customId: string) {
  const parsed = parseCustomId(customId);
  return parsed.key === DISCORD_MODEL_PICKER_CUSTOM_ID_KEY
    ? parseDiscordModelPickerData(parsed.data)
    : null;
}

const buildModelsProviderDataMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/models-provider-runtime", () => ({
  buildModelsProviderData: buildModelsProviderDataMock,
}));

type SerializedComponent = {
  type: number;
  content?: string;
  custom_id?: string;
  label?: string;
  placeholder?: string;
  options?: Array<{ label?: string; value: string; default?: boolean; description?: string }>;
  components?: SerializedComponent[];
};

const DISCORD_CONTAINER_COMPONENT_TYPE: SerializedComponent["type"] = ComponentType.Container;
const DISCORD_ACTION_ROW_COMPONENT_TYPE: SerializedComponent["type"] = ComponentType.ActionRow;
const DISCORD_STRING_SELECT_COMPONENT_TYPE: SerializedComponent["type"] =
  ComponentType.StringSelect;
const DISCORD_TEXT_DISPLAY_COMPONENT_TYPE: SerializedComponent["type"] = ComponentType.TextDisplay;

function extractContainerRows(components?: SerializedComponent[]): SerializedComponent[] {
  const container = components?.find(
    (component) => component.type === DISCORD_CONTAINER_COMPONENT_TYPE,
  );
  if (!container) {
    return [];
  }
  return (container.components ?? []).filter(
    (component) => component.type === DISCORD_ACTION_ROW_COMPONENT_TYPE,
  );
}

function renderModelsViewRows(
  params: Parameters<typeof renderDiscordModelPickerModelsView>[0],
): SerializedComponent[] {
  const rendered = renderDiscordModelPickerModelsView(params);
  const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
    components?: SerializedComponent[];
  };
  return extractContainerRows(payload.components);
}

function renderRecentsViewRows(
  params: Parameters<typeof renderDiscordModelPickerRecentsView>[0],
): SerializedComponent[] {
  const rendered = renderDiscordModelPickerRecentsView(params);
  const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
    components?: SerializedComponent[];
  };
  return extractContainerRows(payload.components);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function flattenSerializedComponents(
  components: SerializedComponent[] | undefined,
): SerializedComponent[] {
  const flattened: SerializedComponent[] = [];
  for (const component of components ?? []) {
    flattened.push(component, ...flattenSerializedComponents(component.components));
  }
  return flattened;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe("loadDiscordModelPickerData", () => {
  it("reuses buildModelsProviderData as source of truth with agent scope", async () => {
    const expected = createModelsProviderData({ openai: ["gpt-4o"] });
    const cfg = EMPTY_DISCORD_TEST_CONFIG;
    buildModelsProviderDataMock.mockResolvedValue(expected);

    const result = await loadDiscordModelPickerData(cfg, "support");

    expect(buildModelsProviderDataMock).toHaveBeenCalledTimes(1);
    expect(buildModelsProviderDataMock).toHaveBeenCalledWith(cfg, "support");
    expect(result).toBe(expected);
  });
});

describe("Discord model picker custom_id", () => {
  it("encodes and decodes command/provider/page/authority context", () => {
    const customId = buildDiscordModelPickerCustomId({
      command: "models",
      action: "provider",
      view: "models",
      provider: "OpenAI",
      page: 3,
      interactionBinding: INTERACTION_BINDING,
    });

    const parsed = parseDiscordModelPickerCustomId(customId);

    expect(parsed).toEqual({
      command: "models",
      action: "provider",
      view: "models",
      provider: "openai",
      page: 3,
      interactionBinding: INTERACTION_BINDING,
    });
  });

  it("binds picker state to the principal and exact session", () => {
    const base = createDiscordModelPickerInteractionBinding({
      accountId: "default",
      userId: "maintainer",
      route: { agentId: "main", sessionKey: "agent:main:discord:channel:one" },
    });

    expect(base).toHaveLength(12);
    expect(
      createDiscordModelPickerInteractionBinding({
        accountId: "work",
        userId: "maintainer",
        route: { agentId: "main", sessionKey: "agent:main:discord:channel:one" },
      }),
    ).not.toBe(base);
    expect(
      createDiscordModelPickerInteractionBinding({
        accountId: "default",
        userId: "maintainer",
        route: { agentId: "worker", sessionKey: "agent:main:discord:channel:one" },
      }),
    ).not.toBe(base);
    expect(
      createDiscordModelPickerInteractionBinding({
        accountId: "default",
        userId: "outsider",
        route: { agentId: "main", sessionKey: "agent:main:discord:channel:one" },
      }),
    ).not.toBe(base);
    expect(
      createDiscordModelPickerInteractionBinding({
        accountId: "default",
        userId: "maintainer",
        route: { agentId: "main", sessionKey: "agent:main:discord:channel:two" },
      }),
    ).not.toBe(base);
  });

  it("rejects legacy unbound picker ids", () => {
    expect(
      parseDiscordModelPickerData({
        c: "model",
        a: "submit",
        v: "models",
        u: "1234567890",
        p: "openai",
        g: "1",
      }),
    ).toBeNull();
  });

  it("parses component data payloads", () => {
    const parsed = parseDiscordModelPickerData({
      cmd: "model",
      act: "back",
      view: "providers",
      b: INTERACTION_BINDING,
      p: "anthropic",
      pg: "2",
    });

    expect(parsed).toEqual({
      command: "model",
      action: "back",
      view: "providers",
      interactionBinding: INTERACTION_BINDING,
      provider: "anthropic",
      page: 2,
    });
  });

  it("rejects positional model and recents state", () => {
    expect(
      parseDiscordModelPickerData({
        c: "models",
        a: "submit",
        v: "models",
        b: INTERACTION_BINDING,
        p: "openai",
        g: "3",
        mi: "2",
      }),
    ).toBeNull();
    expect(
      parseDiscordModelPickerData({
        c: "models",
        a: "submit",
        v: "recents",
        b: INTERACTION_BINDING,
        g: "1",
        rs: "1",
      }),
    ).toBeNull();
  });

  it("parses plus-signed compact numeric fields", () => {
    const parsed = parseDiscordModelPickerData({
      c: "models",
      a: "submit",
      v: "recents",
      b: INTERACTION_BINDING,
      p: "openai",
      g: "+03",
      pp: "+02",
    });

    expect(parsed).toEqual({
      command: "models",
      action: "submit",
      view: "recents",
      interactionBinding: INTERACTION_BINDING,
      provider: "openai",
      page: 3,
      providerPage: 2,
    });
  });

  it("parses stable model and runtime fingerprints", () => {
    const runtimeFingerprint = createDiscordModelPickerRuntimeFingerprint("openai", "codex");
    const modelFingerprint = createDiscordModelPickerModelFingerprint("openai", "gpt-4o");
    const parsed = parseDiscordModelPickerData({
      cmd: "models",
      act: "submit",
      view: "models",
      b: INTERACTION_BINDING,
      p: "openai",
      rt: runtimeFingerprint,
      m: modelFingerprint,
      pg: "1",
    });

    expect(parsed).toEqual({
      command: "models",
      action: "submit",
      view: "models",
      interactionBinding: INTERACTION_BINDING,
      provider: "openai",
      runtimeFingerprint,
      modelFingerprint,
      page: 1,
    });
  });

  it("does not coerce partial numeric custom_id fields", () => {
    expect(
      parseDiscordModelPickerData({
        cmd: "models",
        act: "submit",
        view: "models",
        b: INTERACTION_BINDING,
        p: "openai",
        pg: "3next",
      }),
    ).toEqual({
      command: "models",
      action: "submit",
      view: "models",
      interactionBinding: INTERACTION_BINDING,
      provider: "openai",
      page: 1,
    });
  });

  it("rejects invalid command/action/view values", () => {
    expect(
      parseDiscordModelPickerData({
        cmd: "status",
        act: "nav",
        view: "providers",
        b: INTERACTION_BINDING,
      }),
    ).toBeNull();
    expect(
      parseDiscordModelPickerData({
        cmd: "model",
        act: "unknown",
        view: "providers",
        b: INTERACTION_BINDING,
      }),
    ).toBeNull();
    expect(
      parseDiscordModelPickerData({
        cmd: "model",
        act: "nav",
        view: "unknown",
        b: INTERACTION_BINDING,
      }),
    ).toBeNull();
  });

  it("compacts long provider state within Discord's custom_id limit", () => {
    const longProvider = `provider-${"x".repeat(DISCORD_CUSTOM_ID_MAX_CHARS)}`;
    const customId = buildDiscordModelPickerCustomId({
      command: "model",
      action: "provider",
      view: "models",
      provider: longProvider,
      page: 1,
      interactionBinding: INTERACTION_BINDING,
    });

    expect(customId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
    expect(parseDiscordModelPickerCustomId(customId)).toMatchObject({
      command: "model",
      action: "provider",
      view: "models",
      providerFingerprint: createDiscordModelPickerProviderFingerprint(longProvider),
      interactionBinding: INTERACTION_BINDING,
    });
  });

  it("compacts terminal picker controls without dropping stable authorization state", () => {
    const provider = "azure-openai-responses";
    const runtimeFingerprint = createDiscordModelPickerRuntimeFingerprint(provider, "codex");
    const modelFingerprint = createDiscordModelPickerModelFingerprint(provider, " gpt-5.5");

    for (const action of ["submit", "nav", "recents"] as const) {
      const customId = buildDiscordModelPickerCustomId({
        command: "models",
        action,
        view: action === "recents" ? "recents" : "models",
        provider,
        runtimeFingerprint,
        runtimePage: 4,
        modelFingerprint,
        page: 12,
        providerPage: 9,
        interactionBinding: INTERACTION_BINDING,
      });
      expect(customId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
      expect(parseDiscordModelPickerCustomId(customId)).toMatchObject({
        command: "models",
        action,
        providerFingerprint: createDiscordModelPickerProviderFingerprint(provider),
        runtimeFingerprint,
        runtimePage: 4,
        modelFingerprint,
        interactionBinding: INTERACTION_BINDING,
      });
    }
  });

  it("preserves complete non-BMP bucket ids through custom_id encoding", () => {
    const customId = buildDiscordModelPickerCustomId({
      command: "models",
      action: "nav",
      view: "models",
      provider: "openai",
      page: 2,
      modelBucket: "😀-🚀",
      interactionBinding: INTERACTION_BINDING,
    });

    expect(parseDiscordModelPickerCustomId(customId)?.modelBucket).toBe("😀-🚀");
  });

  it("keeps typical submit ids under Discord max length", () => {
    const modelFingerprint = createDiscordModelPickerModelFingerprint(
      "azure-openai-responses",
      "gpt-5.5",
    );
    const customId = buildDiscordModelPickerCustomId({
      command: "models",
      action: "submit",
      view: "models",
      provider: "azure-openai-responses",
      page: 1,
      providerPage: 1,
      modelFingerprint,
      interactionBinding: INTERACTION_BINDING,
    });

    expect(customId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
    const parsed = parseDiscordModelPickerCustomId(customId);
    expect(parsed?.modelFingerprint).toBe(modelFingerprint);
  });
});

describe("provider paging", () => {
  it("keeps providers on a single page when count fits Discord select options", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX - 2; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const data = createModelsProviderData(entries);

    const page = getDiscordModelPickerProviderPage({ data, page: 1 });

    expect(page.items).toHaveLength(DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX - 2);
    expect(page.totalPages).toBe(1);
    expect(page.pageSize).toBe(DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX);
    expect(page.hasPrev).toBe(false);
    expect(page.hasNext).toBe(false);
  });

  it("buckets providers when count exceeds the alpha-bucket threshold", () => {
    // 28 providers all starting with the same letter ("p") → letter-bucket
    // fallback uses count-based numeric chunks of 20 items.
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX + 3; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const data = createModelsProviderData(entries);

    const firstBucket = getDiscordModelPickerProviderPage({ data, page: 1 });
    expect(firstBucket.buckets).toHaveLength(2);
    expect(firstBucket.bucket?.id).toBe("1-20");
    expect(firstBucket.items).toHaveLength(20);
    expect(firstBucket.totalPages).toBe(1);
    expect(firstBucket.hasNext).toBe(false);

    const secondBucket = getDiscordModelPickerProviderPage({
      data,
      page: 1,
      bucket: "21-28",
    });
    expect(secondBucket.bucket?.id).toBe("21-28");
    expect(secondBucket.items).toHaveLength(8);
    expect(secondBucket.totalPages).toBe(1);
    expect(secondBucket.hasPrev).toBe(false);
  });

  it("caps custom provider page size at Discord-safe max", () => {
    const compactData = createModelsProviderData({
      anthropic: ["claude-sonnet-4-5"],
      openai: ["gpt-4o"],
      google: ["gemini-3-pro"],
    });
    const compactPage = getDiscordModelPickerProviderPage({
      data: compactData,
      page: 1,
      pageSize: 999,
    });
    expect(compactPage.pageSize).toBe(DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX);
    expect(compactPage.buckets).toHaveLength(1);
    expect(compactPage.bucket?.id).toBe("all");

    // 26 providers → buckets engage. First bucket has 20 items which fits a
    // single select page; the user navigates between buckets, not pages.
    const pagedEntries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX + 1; i += 1) {
      pagedEntries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const pagedData = createModelsProviderData(pagedEntries);
    const pagedPage = getDiscordModelPickerProviderPage({
      data: pagedData,
      page: 1,
      pageSize: 999,
    });
    expect(pagedPage.buckets.length).toBeGreaterThan(1);
    expect(pagedPage.items.length).toBeLessThanOrEqual(
      DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX,
    );
  });
});

describe("model paging", () => {
  it("sorts models and buckets them across the Discord select-option constraint", () => {
    // 29 models all starting with the same prefix → numeric bucket fallback,
    // 20 in the first bucket and 9 in the second.
    const models = Array.from(
      { length: DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE + 4 },
      (_, idx) =>
        `model-${String(DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE + 4 - idx).padStart(2, "0")}`,
    );
    const data = createModelsProviderData({ openai: models });

    const firstBucket = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", page: 1 }),
      "expected first model bucket for openai",
    );
    expect(firstBucket.buckets.length).toBeGreaterThan(1);
    expect(firstBucket.bucket?.id).toBe("1-20");
    expect(firstBucket.items[0]).toBe("model-01");
    expect(firstBucket.items.length).toBeLessThanOrEqual(DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE);

    const secondBucket = requireValue(
      getDiscordModelPickerModelPage({
        data,
        provider: "openai",
        page: 1,
        bucket: "21-29",
      }),
      "expected second model bucket for openai",
    );
    expect(secondBucket.bucket?.id).toBe("21-29");
    expect(secondBucket.items[0]).toBe("model-21");
    expect(secondBucket.items).toHaveLength(9);
  });

  it("uses complete Unicode code points for non-BMP model buckets", () => {
    const models = [
      ...Array.from({ length: 20 }, (_, index) => `😀-model-${index}`),
      ...Array.from({ length: 10 }, (_, index) => `🚀-model-${index}`),
    ];
    const data = createModelsProviderData({ openai: models });
    const emojiPage = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", bucket: "😀" }),
      "emoji model page should exist",
    );
    const rocketPage = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", bucket: "🚀" }),
      "rocket model page should exist",
    );

    expect(emojiPage.buckets.map((bucket) => bucket.id)).toEqual(
      expect.arrayContaining(["😀", "🚀"]),
    );
    expect(emojiPage.items).toHaveLength(20);
    expect(emojiPage.items.every((model) => model.startsWith("😀"))).toBe(true);
    expect(rocketPage.items).toHaveLength(10);
    expect(rocketPage.items.every((model) => model.startsWith("🚀"))).toBe(true);
  });

  it("keeps locale-interleaved Unicode prefix buckets unique and reachable", () => {
    const models = ["a", "á", "b"].flatMap((prefix) =>
      Array.from({ length: 20 }, (_, index) => `${prefix}-model-${String(index).padStart(2, "0")}`),
    );
    const data = createModelsProviderData({ openai: models });
    const initialPage = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai" }),
      "Unicode bucket model page should exist",
    );
    const bucketIds = initialPage.buckets.map((bucket) => bucket.id);

    expect(new Set(bucketIds).size).toBe(bucketIds.length);
    const rows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
    });
    const bucketSelect = requireValue(
      rows
        .flatMap((row) => row.components ?? [])
        .find((component) => component.options?.some((option) => bucketIds.includes(option.value))),
      "Unicode bucket select should render",
    );
    const selectValues = bucketSelect.options?.map((option) => option.value) ?? [];
    expect(new Set(selectValues).size).toBe(selectValues.length);
    expect(new Set(selectValues)).toEqual(new Set(bucketIds));

    const reachableModels = new Set<string>();
    for (const bucket of initialPage.buckets) {
      const firstPage = requireValue(
        getDiscordModelPickerModelPage({ data, provider: "openai", bucket: bucket.id }),
        `bucket ${bucket.id} should resolve`,
      );
      for (let page = 1; page <= firstPage.totalPages; page += 1) {
        const resolvedPage = requireValue(
          getDiscordModelPickerModelPage({
            data,
            provider: "openai",
            bucket: bucket.id,
            page,
          }),
          `bucket ${bucket.id} page ${page} should resolve`,
        );
        for (const model of resolvedPage.items) {
          reachableModels.add(model);
        }
      }
    }
    expect(reachableModels.size).toBe(models.length);
    expect(models.every((model) => reachableModels.has(model))).toBe(true);
  });

  it("preserves an exact NBSP bucket through paginated model controls", () => {
    const nbsp = "\u00a0";
    const nbspModels = Array.from({ length: 26 }, (_, index) => `${nbsp}model-${index}`);
    const data = createModelsProviderData({
      openai: [...nbspModels, ...Array.from({ length: 20 }, (_, index) => `a-model-${index}`)],
    });
    const firstPage = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", bucket: nbsp }),
      "NBSP bucket should resolve",
    );
    const secondPage = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", bucket: nbsp, page: 2 }),
      "NBSP bucket second page should resolve",
    );

    expect(firstPage.bucket?.id).toBe(nbsp);
    expect(firstPage.items).toHaveLength(25);
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([...firstPage.items, ...secondPage.items])).toEqual(new Set(nbspModels));

    const rows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      modelBucket: nbsp,
    });
    const nextButton = requireValue(
      rows.flatMap((row) => row.components ?? []).find((component) => component.label === "Next ▶"),
      "NBSP bucket should render model pagination",
    );
    expect(parseDiscordModelPickerCustomId(nextButton.custom_id ?? "")?.modelBucket).toBe(nbsp);
  });

  it("returns null for unknown provider", () => {
    const data = createModelsProviderData({ anthropic: ["claude-sonnet-4-5"] });
    const page = getDiscordModelPickerModelPage({ data, provider: "openai", page: 1 });
    expect(page).toBeNull();
  });

  it("caps custom model page size at Discord select-option max", () => {
    const data = createModelsProviderData({ openai: ["gpt-4o", "gpt-4.1"] });
    const page = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "openai", pageSize: 999 }),
      "expected model page when provider exists",
    );
    expect(page.pageSize).toBe(DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE);
  });
});

describe("Discord model picker rendering", () => {
  it("renders provider view on one page when provider count is <= 25", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= 22; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    entries["azure-openai-responses"] = ["gpt-4.1"];
    entries["vercel-ai-gateway"] = ["gpt-4o-mini"];
    const data = createModelsProviderData(entries);

    const rendered = renderDiscordModelPickerProvidersView({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      currentModel: "provider-01/model-1",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      content?: string;
      components?: SerializedComponent[];
    };

    expect(payload.content).toBeUndefined();
    const firstComponent = requireValue(
      payload.components?.[0],
      "provider view should render a container component",
    );
    expect(firstComponent.type).toBe(ComponentType.Container);

    const rows = extractContainerRows(payload.components);
    expect(rows).toHaveLength(1);

    const providerSelect = requireValue(
      rows[0]?.components?.find(
        (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
      ),
      "provider view should render a provider select",
    );
    expect(providerSelect.options).toHaveLength(Object.keys(entries).length);
    expect(providerSelect.options?.find((option) => option.label === "provider-01")?.default).toBe(
      true,
    );

    const providerState = parseDiscordModelPickerCustomId(providerSelect.custom_id ?? "");
    expect(providerState?.action).toBe("provider");
    expect(providerState?.view).toBe("models");

    const customIds = rows
      .flatMap((row) => row.components ?? [])
      .map((component) => component.custom_id ?? "");
    expect(customIds.filter((customId) => customId.includes(";a=nav;"))).toEqual([]);
  });

  it("renders a bucket select when provider count exceeds the bucket threshold", () => {
    // 29 providers (>25) trigger alpha-bucket mode; the rendered view now
    // surfaces a `bucket` select row before the provider select.
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX + 4; i += 1) {
      entries[`provider-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    const data = createModelsProviderData(entries);

    const rendered = renderDiscordModelPickerProvidersView({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      currentModel: "provider-01/model-1",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };

    const rows = extractContainerRows(payload.components);
    expect(rows.length).toBeGreaterThan(0);

    const allComponents = rows.flatMap((row) => row.components ?? []);
    const customIds = allComponents.map((component) => component.custom_id ?? "");
    // Exactly one bucket-action select exists; it carries view=providers.
    const bucketIds = customIds.filter((customId) => customId.includes(";a=bucket;"));
    expect(bucketIds).toHaveLength(1);
    expect(bucketIds[0]).toContain(`a=bucket;v=providers;b=${INTERACTION_BINDING}`);
  });

  it("model select customId omits providerBucket/modelBucket (derived at re-render)", () => {
    // After reviewloop pass 3 we moved providerBucket/modelBucket OUT of
    // per-item customIds — both are pure functions of the durable state
    // (provider + picked model) so re-renders compute them via
    // findProviderBucketId / findModelBucketId. This test pins the new
    // shape and guards against accidentally re-introducing pb/mb on the
    // model select, which previously pushed the customId past Discord's
    // 100-char cap for long providers + interaction bindings.
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const data = createModelsProviderData({ vllm: models });

    const rendered = renderDiscordModelPickerModelsView({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "vllm",
      page: 1,
      providerPage: 1,
      modelBucket: "21-30",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };
    const rows = extractContainerRows(payload.components);
    const allComponents = rows.flatMap((row) => row.components ?? []);
    const customIds = allComponents.map((component) => component.custom_id ?? "");

    const modelActionIds = customIds.filter((customId) => customId.includes(";a=model;"));
    expect(modelActionIds).toHaveLength(1);
    expect(modelActionIds[0]).not.toMatch(/;pb=/);
    expect(modelActionIds[0]).not.toMatch(/;mb=/);
  });

  it("keeps model select customId under 100 chars with a long provider and binding", () => {
    // Regression for reviewloop pass 3 finding #1: combining a long
    // provider id, interaction binding, and bucket fields was
    // pushing the model select customId past 100 chars and crashing the
    // render. With pb/mb dropped, the cap holds.
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const data = createModelsProviderData({ "azure-openai-responses": models });

    const rendered = renderDiscordModelPickerModelsView({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "azure-openai-responses",
      page: 1,
      providerPage: 1,
      providerBucket: "a-z",
      modelBucket: "21-30",
      pendingRuntime: "codex",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };
    const rows = extractContainerRows(payload.components);
    const allComponents = rows.flatMap((row) => row.components ?? []);
    for (const component of allComponents) {
      const id = component.custom_id ?? "";
      expect(id.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
    }
  });

  it("runtime select preserves bucket state without exceeding Discord's customId limit", () => {
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const data = createModelsProviderData({ google: models });
    data.runtimeChoicesByProvider = new Map([
      [
        "google",
        [
          {
            id: "google-gemini-cli",
            label: "Google Gemini CLI",
            description:
              "Use the Google Gemini CLI runtime selected by the effective harness policy.",
          },
          {
            id: "openclaw",
            label: "OpenClaw Default",
            description: "Use the built-in OpenClaw runtime.",
          },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "google",
      page: 1,
      providerPage: 1,
      modelBucket: "21-30",
      currentRuntime: "google-gemini-cli",
    });

    const runtimeSelect = rows
      .flatMap((row) => row.components ?? [])
      .find((component) => {
        const parsed = parseDiscordModelPickerCustomId(component.custom_id ?? "");
        return parsed?.action === "runtime";
      });
    const runtimeCustomId = requireValue(
      runtimeSelect?.custom_id,
      "models view should render a runtime select",
    );
    const parsed = requireValue(
      parseDiscordModelPickerCustomId(runtimeCustomId),
      "runtime select custom id should parse",
    );

    expect(runtimeCustomId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
    expect(parsed.modelBucket).toBe("21-30");
    expect(parsed.runtimeFingerprint).toBeUndefined();
  });

  it("model bucket select keeps long runtime state compact", () => {
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const data = createModelsProviderData({ "google-gemini-cli": models });
    data.runtimeChoicesByProvider = new Map([
      [
        "google-gemini-cli",
        [
          {
            id: "google-gemini-cli",
            label: "Google Gemini CLI",
            description:
              "Use the Google Gemini CLI runtime selected by the effective harness policy.",
          },
          {
            id: "openclaw",
            label: "OpenClaw Default",
            description: "Use the built-in OpenClaw runtime.",
          },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "google-gemini-cli",
      page: 1,
      providerPage: 1,
      currentRuntime: "google-gemini-cli",
      pendingRuntime: "google-gemini-cli",
    });

    const bucketSelect = rows
      .flatMap((row) => row.components ?? [])
      .find((component) => {
        const parsed = parseDiscordModelPickerCustomId(component.custom_id ?? "");
        return parsed?.action === "bucket" && parsed.view === "models";
      });
    const bucketCustomId = requireValue(
      bucketSelect?.custom_id,
      "models view should render a bucket select",
    );
    const parsed = requireValue(
      parseDiscordModelPickerCustomId(bucketCustomId),
      "bucket select custom id should parse",
    );

    expect(bucketCustomId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
    expect(parsed.runtimeFingerprint).toBe(
      createDiscordModelPickerRuntimeFingerprint("google-gemini-cli", "google-gemini-cli"),
    );
  });

  it("model pagination derives provider buckets to stay under Discord's customId limit", () => {
    const models = [
      ...Array.from({ length: 30 }, (_, i) => `a-model-${String(i + 1).padStart(2, "0")}`),
      "b-model-01",
    ];
    const data = createModelsProviderData({ "azure-openai-responses": models });

    const rows = renderModelsViewRows({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "azure-openai-responses",
      page: 1,
      providerPage: 1,
      providerBucket: "a-z",
      modelBucket: "a",
    });

    const navIds = rows
      .flatMap((row) => row.components ?? [])
      .map((component) => component.custom_id ?? "")
      .filter((customId) => customId.includes(";a=nav;v=models;"));
    expect(navIds.length).toBeGreaterThan(0);
    for (const customId of navIds) {
      expect(customId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
      expect(customId).not.toContain(";pb=");
      expect(customId).toContain(";mb=a");
    }
  });

  it("provider pages use Discord's select-option cap when buckets are active", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= 30; i += 1) {
      entries[`p-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    entries["z-01"] = ["model-z"];
    const data = createModelsProviderData(entries);

    const firstBucket = getDiscordModelPickerProviderPage({ data, page: 1, bucket: "p" });
    expect(firstBucket.bucket?.id).toBe("p");
    expect(firstBucket.pageSize).toBe(DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE);
    expect(firstBucket.items).toHaveLength(DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE);
    expect(firstBucket.totalPages).toBe(2);
    expect(findProviderBucketLocation(data, "p-30")).toEqual({ bucket: "p", page: 2 });
  });

  it("sorts mixed-case model ids by the same key used for bucket labels", () => {
    const models = [
      "zulu-lower",
      "MiniMaxAI/model",
      "openai/model",
      "Qwen/model",
      "NousResearch/model",
      ...Array.from({ length: 25 }, (_, i) => `camel-${String(i + 1).padStart(2, "0")}`),
    ];
    const data = createModelsProviderData({ chutes: models });

    const page = requireValue(
      getDiscordModelPickerModelPage({ data, provider: "chutes", bucket: "m-z" }),
      "model page should exist",
    );
    const rangeLabels = page.buckets
      .map((bucket) => bucket.label)
      .filter((label) => label.includes("–"));

    expect(rangeLabels.every((label) => !/M–C|Q–N|O–C/u.test(label))).toBe(true);
    expect(page.items.some((item) => item.startsWith("MiniMaxAI/"))).toBe(true);
  });

  it("provider select and pagination preserve the active provider bucket", () => {
    const entries: Record<string, string[]> = {};
    for (let i = 1; i <= 30; i += 1) {
      entries[`p-${String(i).padStart(2, "0")}`] = [`model-${i}`];
    }
    entries["z-01"] = ["model-z"];
    const data = createModelsProviderData(entries);

    const rendered = renderDiscordModelPickerProvidersView({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      providerBucket: "p",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };
    const rows = extractContainerRows(payload.components);
    const allComponents = rows.flatMap((row) => row.components ?? []);
    const customIds = allComponents.map((component) => component.custom_id ?? "");

    const providerActionIds = customIds.filter((customId) => customId.includes(";a=provider;"));
    expect(providerActionIds).toHaveLength(1);
    expect(providerActionIds[0]).toContain("pb=p");

    const providerSelect = requireValue(
      allComponents.find(
        (component) =>
          component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE &&
          component.custom_id?.includes(";a=provider;"),
      ),
      "provider view should render a provider select",
    );
    expect(providerSelect.options).toHaveLength(DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE);

    // The nav customId carries the active bucket because pagination is
    // bucket-scoped and the user's "current" range is the only durable
    // hint of where to keep them.
    const navIds = customIds.filter((customId) => customId.includes(";a=nav;"));
    expect(navIds.length).toBeGreaterThan(0);
    for (const customId of navIds) {
      expect(customId).toContain("pb=p");
    }
  });

  it("supports classic fallback rendering with content + action rows", () => {
    const data = createModelsProviderData({ openai: ["gpt-4o"], anthropic: ["claude-sonnet-4-5"] });

    const rendered = renderDiscordModelPickerProvidersView({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      layout: "classic",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      content?: string;
      components?: SerializedComponent[];
    };

    expect(payload.content).toContain("Model Picker");
    const firstComponent = requireValue(
      payload.components?.[0],
      "classic provider view should render an action row",
    );
    expect(firstComponent.type).toBe(ComponentType.ActionRow);
  });

  it("caps v2 text displays and classic content without splitting Unicode", () => {
    const provider = `provider-${"😀".repeat(2_100)}`;
    const model = `model-${"🚀".repeat(2_100)}`;
    const modelRef = `${provider}/${model}`;
    const data = createModelsProviderData({ [provider]: [model] });

    const v2Payload = serializePayload(
      toDiscordModelPickerMessagePayload(
        renderDiscordModelPickerModelsView({
          command: "model",
          interactionBinding: INTERACTION_BINDING,
          data,
          provider,
          currentModel: modelRef,
          pendingModel: modelRef,
          pendingModelIndex: 1,
        }),
      ),
    ) as { components?: SerializedComponent[] };
    const textDisplays = flattenSerializedComponents(v2Payload.components).filter(
      (component) => component.type === DISCORD_TEXT_DISPLAY_COMPONENT_TYPE,
    );

    expect(textDisplays.length).toBeGreaterThan(1);
    expect(textDisplays.every((component) => (component.content?.length ?? 0) <= 4_000)).toBe(true);
    expect(textDisplays.every((component) => isWellFormedUtf16(component.content ?? ""))).toBe(
      true,
    );
    expect(textDisplays.some((component) => component.content?.endsWith("…"))).toBe(true);

    const classicPayload = serializePayload(
      toDiscordModelPickerMessagePayload(
        renderDiscordModelPickerModelsView({
          command: "model",
          interactionBinding: INTERACTION_BINDING,
          data,
          provider,
          currentModel: modelRef,
          pendingModel: modelRef,
          pendingModelIndex: 1,
          layout: "classic",
        }),
      ),
    ) as { content?: string };

    expect(classicPayload.content?.length).toBeLessThanOrEqual(2_000);
    expect(classicPayload.content?.endsWith("…")).toBe(true);
    expect(isWellFormedUtf16(classicPayload.content ?? "")).toBe(true);
  });

  it("omits reset and default recent controls when the configured default is filtered out", () => {
    const data = createModelsProviderData({ openai: ["gpt-visible"] });
    data.resolvedDefault = { provider: "anthropic", model: "claude-hidden" };

    const modelRows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      currentModel: "openai/gpt-visible",
      pendingModel: "openai/gpt-visible",
      pendingModelIndex: 1,
      quickModels: ["anthropic/claude-hidden", "openai/gpt-visible"],
    });
    const modelComponents = modelRows.flatMap((row) => row.components ?? []);

    expect(
      modelComponents.some((component) =>
        component.options?.some((option) => option.label === "gpt-visible"),
      ),
    ).toBe(true);
    expect(modelComponents.some((component) => component.label === "Submit")).toBe(true);
    expect(modelComponents.some((component) => component.label === "Reset to default")).toBe(false);
    expect(modelComponents.some((component) => component.custom_id?.includes(";a=reset;"))).toBe(
      false,
    );

    const recentLabels = renderRecentsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      quickModels: ["anthropic/claude-hidden", "openai/gpt-visible"],
    })
      .flatMap((row) => row.components ?? [])
      .map((component) => component.label);
    expect(recentLabels).toContain("openai/gpt-visible");
    expect(recentLabels).not.toContain("anthropic/claude-hidden (default)");
    expect(recentLabels).not.toContain("anthropic/claude-hidden");
  });

  it("keeps trailing model and recents controls in classic fallback rendering", () => {
    const data = createModelsProviderData({ openai: ["gpt-4.1", "gpt-4o"] });
    const modelPayload = serializePayload(
      toDiscordModelPickerMessagePayload(
        renderDiscordModelPickerModelsView({
          command: "model",
          interactionBinding: INTERACTION_BINDING,
          data,
          provider: "openai",
          currentModel: "openai/gpt-4.1",
          pendingModel: "openai/gpt-4o",
          pendingModelIndex: 2,
          layout: "classic",
        }),
      ),
    ) as { content?: string; components?: SerializedComponent[] };
    const modelCustomIds = (modelPayload.components ?? [])
      .flatMap((row) => row.components ?? [])
      .map((component) => component.custom_id ?? "");
    expect(modelPayload.content).toContain("Selected: openai/gpt-4o");
    expect(modelCustomIds.some((customId) => customId.includes(";a=submit;"))).toBe(true);
    expect(modelCustomIds.some((customId) => customId.includes(";a=reset;"))).toBe(true);

    const recentsPayload = serializePayload(
      toDiscordModelPickerMessagePayload(
        renderDiscordModelPickerRecentsView({
          command: "model",
          interactionBinding: INTERACTION_BINDING,
          data,
          quickModels: ["openai/gpt-4o"],
          layout: "classic",
        }),
      ),
    ) as { content?: string; components?: SerializedComponent[] };
    const recentsCustomIds = (recentsPayload.components ?? [])
      .flatMap((row) => row.components ?? [])
      .map((component) => component.custom_id ?? "");
    expect(recentsPayload.content).toContain("Tap a model to switch.");
    expect(recentsCustomIds.some((customId) => customId.includes(";a=back;"))).toBe(true);
  });

  it("caps the maximal classic models view at five action rows", () => {
    const bucketedModels = [
      ...Array.from({ length: 30 }, (_, index) => `alpha-${String(index + 1).padStart(2, "0")}`),
      "beta-01",
    ];
    const providerEntries = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `provider-${String(index + 1).padStart(2, "0")}`,
        ["model"],
      ]),
    );
    const data = createModelsProviderData({ ...providerEntries, vllm: bucketedModels });
    data.resolvedDefault = { provider: "vllm", model: "alpha-01" };
    data.runtimeChoicesByProvider = new Map([
      [
        "vllm",
        [
          { id: "openclaw", label: "OpenClaw Default" },
          { id: "codex", label: "Codex" },
        ],
      ],
    ]);

    const payload = serializePayload(
      toDiscordModelPickerMessagePayload(
        renderDiscordModelPickerModelsView({
          command: "model",
          interactionBinding: INTERACTION_BINDING,
          data,
          provider: "vllm",
          page: 1,
          currentModel: "vllm/alpha-02",
          currentRuntime: "codex",
          pendingModel: "vllm/alpha-03",
          pendingModelIndex: 3,
          pendingRuntime: "codex",
          quickModels: ["vllm/beta-01"],
          layout: "classic",
        }),
      ),
    ) as { components?: SerializedComponent[] };
    const rows = payload.components ?? [];
    const controls = rows.flatMap((row) => row.components ?? []);
    const actions = controls.flatMap((component) => {
      const action = parseDiscordModelPickerCustomId(component.custom_id ?? "")?.action;
      return action ? [action] : [];
    });

    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.type === DISCORD_ACTION_ROW_COMPONENT_TYPE)).toBe(true);
    expect(rows.every((row) => (row.components?.length ?? 0) <= 5)).toBe(true);
    expect(actions).toEqual(
      expect.arrayContaining(["bucket", "runtime", "model", "nav", "reset", "submit"]),
    );
    expect(actions).not.toContain("provider");
    expect(controls.map((component) => component.label)).toEqual(
      expect.arrayContaining(["Reset to default", "Submit"]),
    );
  });

  it("packs and caps classic recents within Discord's five action rows", () => {
    const models = Array.from({ length: 7 }, (_, index) => `model-${index}`);
    const data = createModelsProviderData({ openai: models });
    const payload = serializePayload(
      toDiscordModelPickerMessagePayload(
        renderDiscordModelPickerRecentsView({
          command: "model",
          interactionBinding: INTERACTION_BINDING,
          data,
          quickModels: models.slice(1).map((model) => `openai/${model}`),
          layout: "classic",
        }),
      ),
    ) as { components?: SerializedComponent[] };
    const rows = payload.components ?? [];

    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => (row.components?.length ?? 0) <= 5)).toBe(true);
    const labels = rows.flatMap((row) => row.components ?? []).map((component) => component.label);
    expect(labels).toContain("openai/model-5");
    expect(labels).not.toContain("openai/model-6");
    expect(labels).toContain("Back");
  });

  it("preserves the stored model suffix spacing in Discord current-model text", () => {
    const data = createModelsProviderData({ openai: [" gpt-5", "gpt-4o"] });

    const rendered = renderDiscordModelPickerProvidersView({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      currentModel: " OpenAI/ gpt-5 ",
      layout: "classic",
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      content?: string;
    };

    expect(payload.content).toContain("Current model: openai/ gpt-5");
  });

  it("keeps provider navigation available when model bucketing drops the provider select", () => {
    const models = Array.from({ length: 30 }, (_, i) => `qwen3-${String(i + 1).padStart(2, "0")}`);
    const providerEntries = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `provider-${String(i + 1).padStart(2, "0")}`,
        ["model"],
      ]),
    );
    const data = createModelsProviderData({ ...providerEntries, vllm: models });
    const providerBucket = requireValue(
      findProviderBucketId(data, "vllm"),
      "test data should bucket the selected provider",
    );

    const rows = renderModelsViewRows({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "vllm",
      page: 1,
      providerPage: 1,
      providerBucket,
      modelBucket: "21-30",
    });

    const providerSelect = rows
      .flatMap((row) => row.components ?? [])
      .find(
        (component) =>
          component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE &&
          parseDiscordModelPickerCustomId(component.custom_id ?? "")?.action === "provider",
      );
    expect(providerSelect).toBeUndefined();

    const buttons = rows.at(-1)?.components ?? [];
    const providersButton = requireValue(
      buttons.find((button) => button.custom_id?.includes(";a=back;v=providers;")),
      "bucketed model view should render a providers button",
    );
    const state = requireValue(
      parseDiscordModelPickerCustomId(providersButton.custom_id ?? ""),
      "providers button custom id should parse",
    );
    expect(state.action).toBe("back");
    expect(state.view).toBe("providers");
    expect(state.providerBucket).toBe(providerBucket);
    expect((providersButton.custom_id ?? "").length).toBeLessThanOrEqual(
      DISCORD_CUSTOM_ID_MAX_CHARS,
    );
  });

  it("renders model view with select menu and explicit submit button", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o", "o3"],
      anthropic: ["claude-sonnet-4-5"],
    });

    const rendered = renderDiscordModelPickerModelsView({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      page: 1,
      providerPage: 2,
      currentModel: "openai/gpt-4o",
      pendingModel: "openai/o3",
      pendingModelIndex: 3,
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };

    const rows = extractContainerRows(payload.components);
    expect(rows).toHaveLength(3);

    const providerSelect = rows[0]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    if (!providerSelect) {
      throw new Error("models view did not render a provider select");
    }
    expect(providerSelect.options?.length).toBe(2);
    const openaiProviderOption = providerSelect.options?.find(
      (option) => option.label === "openai",
    );
    expect(openaiProviderOption?.default).toBe(true);
    const parsedProviderState = parseDiscordModelPickerCustomId(providerSelect.custom_id ?? "");
    expect(parsedProviderState?.action).toBe("provider");

    const modelSelect = rows[1]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    if (!modelSelect) {
      throw new Error("models view did not render a model select");
    }
    expect(modelSelect.options?.length).toBe(3);
    const o3ModelOption = modelSelect.options?.find((option) => option.label === "o3");
    expect(o3ModelOption?.default).toBe(true);

    const parsedModelSelectState = parseDiscordModelPickerCustomId(modelSelect.custom_id ?? "");
    expect(parsedModelSelectState?.action).toBe("model");
    expect(parsedModelSelectState?.provider).toBe("openai");

    const navButtons = rows[2]?.components ?? [];
    expect(navButtons).toHaveLength(4);

    const providersState = parseDiscordModelPickerCustomId(navButtons[0]?.custom_id ?? "");
    expect(providersState?.action).toBe("back");
    expect(providersState?.view).toBe("providers");
    expect(providersState?.page).toBe(1);

    const cancelState = parseDiscordModelPickerCustomId(navButtons[1]?.custom_id ?? "");
    expect(cancelState?.action).toBe("cancel");

    const resetState = parseDiscordModelPickerCustomId(navButtons[2]?.custom_id ?? "");
    expect(resetState?.action).toBe("reset");
    expect(resetState?.provider).toBe("openai");

    const submitState = parseDiscordModelPickerCustomId(navButtons[3]?.custom_id ?? "");
    expect(submitState?.action).toBe("submit");
    expect(submitState?.provider).toBe("openai");
    expect(submitState?.modelFingerprint).toBe(
      createDiscordModelPickerModelFingerprint("openai", "o3"),
    );
  });

  it("keeps select labels and opaque values within Discord limits", () => {
    const provider = `provider-${"p".repeat(180)}`;
    const model = ` ${"m".repeat(140)}`;
    const runtime = `runtime-${"r".repeat(120)}`;
    const data = createModelsProviderData({ [provider]: [model] });
    data.runtimeChoicesByProvider = new Map([
      [
        provider,
        [
          {
            id: runtime,
            label: `Runtime ${"L".repeat(120)}`,
            description: `Runtime description ${"D".repeat(120)}`,
          },
          { id: "openclaw", label: "OpenClaw Default" },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider,
      pendingModel: `${provider}/${model}`,
      pendingModelIndex: 1,
      pendingRuntime: runtime,
    });
    const options = rows
      .flatMap((row) => row.components ?? [])
      .flatMap((component) => component.options ?? []);

    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.label?.length ?? 0).toBeLessThanOrEqual(100);
      expect(option.value.length).toBeLessThanOrEqual(100);
      expect(option.description?.length ?? 0).toBeLessThanOrEqual(100);
    }
    const modelOption = requireValue(
      options.find(
        (option) => option.value === createDiscordModelPickerModelFingerprint(provider, model),
      ),
      "long model should render with an opaque select value",
    );
    expect(modelOption.label).toHaveLength(100);
    expect(modelOption.label?.endsWith("…")).toBe(true);
    expect(modelOption.default).toBe(true);
    const modelSelect = requireValue(
      rows
        .flatMap((row) => row.components ?? [])
        .find((component) =>
          component.options?.some((option) => option.value === modelOption.value),
        ),
      "long provider model select should render",
    );
    expect(modelSelect.placeholder).toHaveLength(150);
    expect(modelSelect.placeholder?.endsWith("…")).toBe(true);

    const emojiProvider = `provider-${"😀".repeat(100)}`;
    const emojiRows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data: createModelsProviderData({ [emojiProvider]: ["model"] }),
      provider: emojiProvider,
    });
    const emojiPlaceholder = requireValue(
      emojiRows
        .flatMap((row) => row.components ?? [])
        .find((component) => component.options?.some((option) => option.label === "model"))
        ?.placeholder,
      "emoji provider model select should have a placeholder",
    );
    expect(emojiPlaceholder.length).toBeLessThanOrEqual(150);
    expect(emojiPlaceholder.endsWith("…")).toBe(true);
    expect(emojiPlaceholder.slice(0, -1).endsWith("😀")).toBe(true);
  });

  it("paginates runtime choices within Discord's 25-option limit", () => {
    const data = createModelsProviderData({ openai: ["gpt-4o"] });
    data.runtimeChoicesByProvider = new Map([
      [
        "openai",
        Array.from({ length: 60 }, (_, index) => ({
          id: `runtime-${String(index + 1).padStart(2, "0")}`,
          label: `Runtime ${index + 1}`,
        })),
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      currentRuntime: "runtime-30",
    });
    const runtimeSelect = requireValue(
      rows
        .flatMap((row) => row.components ?? [])
        .find((component) => component.placeholder?.startsWith("Select runtime")),
      "runtime picker should render",
    );

    expect(runtimeSelect.options).toHaveLength(25);
    expect(runtimeSelect.options?.some((option) => option.value === "runtime-page-prev")).toBe(
      true,
    );
    expect(runtimeSelect.options?.some((option) => option.value === "runtime-page-next")).toBe(
      true,
    );
    expect(runtimeSelect.options?.find((option) => option.label === "Runtime 30")?.default).toBe(
      true,
    );
    expect(runtimeSelect.placeholder).toBe("Select runtime (page 2/3)");
    expect(parseDiscordModelPickerCustomId(runtimeSelect.custom_id ?? "")).toMatchObject({
      action: "runtime",
      runtimePage: 2,
      runtimeFingerprint: createDiscordModelPickerRuntimeFingerprint("openai", "runtime-30"),
    });
  });

  it("defaults the runtime picker to the first effective runtime choice", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o", "o3"],
      anthropic: ["claude-sonnet-4-5"],
    });
    data.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          {
            id: "codex",
            label: "OpenAI Codex",
            description: "Use the OpenAI Codex runtime selected by the effective harness policy.",
          },
          {
            id: "openclaw",
            label: "OpenClaw Default",
            description: "Use the built-in OpenClaw runtime.",
          },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      page: 1,
      providerPage: 2,
      currentModel: "openai/gpt-4o",
      pendingModel: "openai/o3",
      pendingModelIndex: 3,
    });

    expect(rows).toHaveLength(4);
    const runtimeSelect = rows[1]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    if (!runtimeSelect) {
      throw new Error("models view did not render a runtime select");
    }
    expect(runtimeSelect.options?.find((option) => option.label === "OpenAI Codex")?.default).toBe(
      true,
    );
    expect(
      runtimeSelect.options?.find((option) => option.label === "OpenClaw Default")?.default,
    ).toBe(false);

    const modelSelect = rows[2]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    const parsedModelSelectState = parseDiscordModelPickerCustomId(modelSelect?.custom_id ?? "");
    expect(parsedModelSelectState?.runtimeFingerprint).toBeUndefined();

    const navButtons = rows[3]?.components ?? [];
    const submitState = parseDiscordModelPickerCustomId(navButtons.at(-1)?.custom_id ?? "");
    expect(submitState?.action).toBe("submit");
    expect(submitState?.runtimeFingerprint).toBeUndefined();
    expect(submitState?.modelFingerprint).toBe(
      createDiscordModelPickerModelFingerprint("openai", "o3"),
    );
  });

  it("carries only explicit runtime picker state into model submit ids", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
    });
    data.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          {
            id: "codex",
            label: "OpenAI Codex",
            description: "Use the OpenAI Codex runtime selected by the effective harness policy.",
          },
          {
            id: "openclaw",
            label: "OpenClaw Default",
            description: "Use the built-in OpenClaw runtime.",
          },
        ],
      ],
    ]);

    const rows = renderModelsViewRows({
      command: "models",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      currentModel: "openai/gpt-4.1",
      pendingModel: "openai/gpt-4o",
      pendingModelIndex: 2,
      pendingRuntime: "openclaw",
    });

    const modelSelect = rows[2]?.components?.find(
      (component) => component.type === DISCORD_STRING_SELECT_COMPONENT_TYPE,
    );
    const modelSelectState = parseDiscordModelPickerCustomId(modelSelect?.custom_id ?? "");
    const runtimeFingerprint = createDiscordModelPickerRuntimeFingerprint("openai", "openclaw");
    expect(modelSelectState?.runtimeFingerprint).toBe(runtimeFingerprint);
    const submitState = parseDiscordModelPickerCustomId(
      rows[3]?.components?.at(-1)?.custom_id ?? "",
    );
    expect(submitState?.runtimeFingerprint).toBe(runtimeFingerprint);
    const resetState = parseDiscordModelPickerCustomId(rows[3]?.components?.[2]?.custom_id ?? "");
    expect(resetState?.action).toBe("reset");
    expect(resetState?.runtimeFingerprint).toBe(runtimeFingerprint);
  });

  it("renders not-found model view with a back button", () => {
    const data = createModelsProviderData({ openai: ["gpt-4o"] });

    const rendered = renderDiscordModelPickerModelsView({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "does-not-exist",
      providerPage: 3,
    });

    const payload = serializePayload(toDiscordModelPickerMessagePayload(rendered)) as {
      components?: SerializedComponent[];
    };

    const rows = extractContainerRows(payload.components);
    expect(rows).toHaveLength(1);

    const backButton = requireValue(
      rows[0]?.components?.[0],
      "models view should render a back button row",
    );
    expect(backButton.type).toBe(ComponentType.Button);

    const state = requireValue(
      parseDiscordModelPickerCustomId(backButton.custom_id ?? ""),
      "back button custom id should parse",
    );
    expect(state.action).toBe("back");
    expect(state.view).toBe("providers");
    expect(state.page).toBe(3);
  });

  it("shows Recents button when quickModels are provided", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });

    const rows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      page: 1,
      providerPage: 1,
      currentModel: "openai/gpt-4o",
      quickModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
    });
    const buttonRow = rows[2];
    const buttons = buttonRow?.components ?? [];
    expect(buttons).toHaveLength(5);

    const favoritesState = requireValue(
      parseDiscordModelPickerCustomId(buttons[3]?.custom_id ?? ""),
      "recents button custom id should parse",
    );
    expect(favoritesState.action).toBe("recents");
    expect(favoritesState.view).toBe("recents");
  });

  it("preserves the active model bucket when opening Recents", () => {
    const data = createModelsProviderData({
      openai: Array.from({ length: 30 }, (_, i) => `model-${String(i + 1).padStart(2, "0")}`),
    });

    const rows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      page: 1,
      providerPage: 1,
      modelBucket: "21-30",
      currentModel: "openai/model-21",
      quickModels: ["openai/model-21"],
    });
    const buttonRow = rows.at(-1);
    const recentsButton = requireValue(
      buttonRow?.components?.find(
        (button) => parseDiscordModelPickerCustomId(button.custom_id ?? "")?.action === "recents",
      ),
      "models view should render Recents button",
    );
    const state = requireValue(
      parseDiscordModelPickerCustomId(recentsButton.custom_id ?? ""),
      "recents button custom id should parse",
    );

    expect(state.action).toBe("recents");
    expect(state.view).toBe("recents");
    expect(state.modelBucket).toBe("21-30");
    expect((recentsButton.custom_id ?? "").length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
  });

  it("omits Recents button when no quickModels", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
    });

    const rows = renderModelsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      provider: "openai",
      page: 1,
      providerPage: 1,
      currentModel: "openai/gpt-4o",
    });
    const buttonRow = rows[2];
    const buttons = buttonRow?.components ?? [];
    expect(buttons).toHaveLength(4);

    const allActions = buttons.map(
      (b) => parseDiscordModelPickerCustomId(b?.custom_id ?? "")?.action,
    );
    expect(allActions).not.toContain("recents");
  });
});

describe("Discord model picker recents view", () => {
  it("renders one button per model with back button after divider", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });

    // Default is openai/gpt-4.1 (first key in entries).
    // Neither quickModel matches, so no deduping — 1 default + 2 recents + 1 back = 4 rows.
    const rows = renderRecentsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      quickModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
      currentModel: "openai/gpt-4o",
    });
    expect(rows).toHaveLength(4);

    // First row: default model button.
    const defaultBtn = requireValue(
      rows[0]?.components?.[0],
      "recents view should render a default model button",
    );
    expect(defaultBtn.type).toBe(ComponentType.Button);
    const defaultState = requireValue(
      parseDiscordModelPickerCustomId(defaultBtn.custom_id ?? ""),
      "default recents button custom id should parse",
    );
    expect(defaultState.action).toBe("submit");
    expect(defaultState.view).toBe("recents");
    expect(defaultState.modelFingerprint).toBe(
      createDiscordModelPickerModelFingerprint("openai", "gpt-4.1"),
    );

    // Second row: first recent.
    const recentBtn1 = requireValue(
      rows[1]?.components?.[0],
      "recents view should render first recent button",
    );
    const recentState1 = requireValue(
      parseDiscordModelPickerCustomId(recentBtn1.custom_id ?? ""),
      "first recent custom id should parse",
    );
    expect(recentState1.modelFingerprint).toBe(
      createDiscordModelPickerModelFingerprint("openai", "gpt-4o"),
    );

    // Third row: second recent.
    const recentBtn2 = requireValue(
      rows[2]?.components?.[0],
      "recents view should render second recent button",
    );
    const recentState2 = requireValue(
      parseDiscordModelPickerCustomId(recentBtn2.custom_id ?? ""),
      "second recent custom id should parse",
    );
    expect(recentState2.modelFingerprint).toBe(
      createDiscordModelPickerModelFingerprint("anthropic", "claude-sonnet-4-5"),
    );

    // Fourth row (after divider): Back button.
    const backBtn = requireValue(
      rows[3]?.components?.[0],
      "recents view should render a back button",
    );
    const backState = requireValue(
      parseDiscordModelPickerCustomId(backBtn.custom_id ?? ""),
      "recents back button custom id should parse",
    );
    expect(backState.action).toBe("back");
    expect(backState.view).toBe("models");
  });

  it("preserves explicit runtime state only on recents back buttons", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
    });

    const rows = renderRecentsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      quickModels: ["openai/gpt-4o"],
      currentModel: "openai/gpt-4o",
      runtimeFingerprint: createDiscordModelPickerRuntimeFingerprint("openai", "codex"),
    });

    const defaultState = requireValue(
      parseDiscordModelPickerCustomId(rows[0]?.components?.[0]?.custom_id ?? ""),
      "default recents button custom id should parse",
    );
    const recentState = requireValue(
      parseDiscordModelPickerCustomId(rows[1]?.components?.[0]?.custom_id ?? ""),
      "recent model button custom id should parse",
    );
    const backState = requireValue(
      parseDiscordModelPickerCustomId(rows[2]?.components?.[0]?.custom_id ?? ""),
      "recents back button custom id should parse",
    );

    const runtimeFingerprint = createDiscordModelPickerRuntimeFingerprint("openai", "codex");
    expect(defaultState.runtimeFingerprint).toBe(runtimeFingerprint);
    expect(recentState.runtimeFingerprint).toBe(runtimeFingerprint);
    expect(backState.runtimeFingerprint).toBe(runtimeFingerprint);
  });

  it("preserves the browse model bucket on recents back buttons", () => {
    const data = createModelsProviderData({
      openai: Array.from({ length: 30 }, (_, i) => `model-${String(i + 1).padStart(2, "0")}`),
    });

    const rows = renderRecentsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      quickModels: ["openai/model-21"],
      currentModel: "openai/model-21",
      provider: "openai",
      page: 1,
      providerPage: 1,
      modelBucket: "21-30",
    });

    const backState = requireValue(
      parseDiscordModelPickerCustomId(rows.at(-1)?.components?.[0]?.custom_id ?? ""),
      "recents back button custom id should parse",
    );

    expect(backState.action).toBe("back");
    expect(backState.view).toBe("models");
    expect(backState.modelBucket).toBe("21-30");
  });

  it("keeps compact runtime state on recents buttons under the customId limit", () => {
    const data = createModelsProviderData({
      "google-gemini-cli": ["qwen3-01", "qwen3-02"],
    });

    const rows = renderRecentsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      quickModels: ["google-gemini-cli/qwen3-02"],
      currentModel: "google-gemini-cli/qwen3-02",
      provider: "google-gemini-cli",
      runtimeFingerprint: createDiscordModelPickerRuntimeFingerprint(
        "google-gemini-cli",
        "google-gemini-cli",
      ),
    });

    const states = rows.map((row) => {
      const customId = requireValue(row.components?.[0]?.custom_id, "recents row custom id");
      expect(customId.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX_CHARS);
      return requireValue(
        parseDiscordModelPickerCustomId(customId),
        "recents custom id should parse",
      );
    });
    const runtimeFingerprint = createDiscordModelPickerRuntimeFingerprint(
      "google-gemini-cli",
      "google-gemini-cli",
    );
    expect(states[0]?.runtimeFingerprint).toBe(runtimeFingerprint);
    expect(states[1]?.runtimeFingerprint).toBe(runtimeFingerprint);
    expect(states[2]?.runtimeFingerprint).toBe(runtimeFingerprint);
  });

  it("includes (default) suffix on default model button label", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4o"],
    });

    const rows = renderRecentsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      quickModels: ["openai/gpt-4o"],
      currentModel: "openai/gpt-4o",
    });
    const defaultBtn = requireValue(
      rows[0]?.components?.[0] as { label?: string } | undefined,
      "recents default row should include a button",
    );
    expect(defaultBtn.label).toContain("(default)");
  });

  it("deduplicates recents that match the default model", () => {
    const data = createModelsProviderData({
      openai: ["gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });
    // Default is openai/gpt-4o (first key). quickModels contains the default.
    const rows = renderRecentsViewRows({
      command: "model",
      interactionBinding: INTERACTION_BINDING,
      data,
      quickModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
      currentModel: "openai/gpt-4o",
    });
    // 1 default + 1 deduped recent + 1 back = 3 rows (openai/gpt-4o not shown twice)
    expect(rows).toHaveLength(3);

    const defaultBtn = requireValue(
      rows[0]?.components?.[0] as { label?: string } | undefined,
      "deduped recents should keep the default button",
    );
    expect(defaultBtn.label).toContain("openai/gpt-4o");
    expect(defaultBtn.label).toContain("(default)");

    const recentBtn = requireValue(
      rows[1]?.components?.[0] as { label?: string } | undefined,
      "deduped recents should keep the non-default recent button",
    );
    expect(recentBtn.label).toContain("anthropic/claude-sonnet-4-5");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
