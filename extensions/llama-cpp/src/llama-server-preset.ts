import {
  DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
  DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE,
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
} from "./defaults.js";

export type ManagedLlamaModel = {
  id: string;
  path: string;
  contextSize?: number;
  maxTokens?: number;
  projectorPath?: string;
  imageMaxTokens?: number;
  device?: string;
};

export type ManagedLlamaChatModel =
  | { mode: "preserve" }
  | { mode: "remove" }
  | ({ mode: "configure" } & ManagedLlamaModel);

export type LlamaServerPresetOptions = {
  chatModel: ManagedLlamaChatModel;
  configuredChatModelIds?: readonly string[];
  embeddingModelPath?: string;
  defaultEmbeddingModelPath?: string;
  mediaModels?: readonly ManagedLlamaModel[];
  // Settings the router already passes to every model: its args and its effective environment.
  serviceSettings?: {
    args?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
  };
};

function assertIniValue(value: string, label: string): string {
  if (/\r|\n/u.test(value)) {
    throw new Error(`${label} cannot contain a newline`);
  }
  return value;
}

function normalizePresetName(name: string): string {
  const colon = name.lastIndexOf(":");
  if (colon < 0) {
    return name;
  }
  const tag = name.slice(colon + 1);
  const quantization = /[-.]([a-zA-Z0-9_]+)$/u.exec(tag)?.[1] ?? tag;
  return name.slice(0, colon + 1) + quantization.replace(/[a-z]/g, (char) => char.toUpperCase());
}

// Native INI uses CR/LF boundaries; Unicode separators stay inside comments and values.
function readModelSections(contents: string) {
  const headers = [
    ...contents.matchAll(
      /(?<![^\r\n])\[[ \t]*([^\]]+)\][ \t]*(?:[;#][^\r\n]*)?(?:\r\n|\n|\r|(?![\s\S]))/g,
    ),
  ];
  return {
    header: contents.slice(0, headers[0]?.index ?? contents.length),
    sections: new Map(
      headers.map((match, index) => [
        // SAFETY: the header expression always captures a nonempty section name.
        match[1]!,
        contents.slice(match.index, headers[index + 1]?.index ?? contents.length),
      ]),
    ),
  };
}

// Match native aliases so an old spelling cannot override an updated managed setting.
const PRESET_KEY_ALIASES: Record<string, string> = {
  m: "model",
  LLAMA_ARG_MODEL: "model",
  c: "ctx-size",
  LLAMA_ARG_CTX_SIZE: "ctx-size",
  n: "n-predict",
  predict: "n-predict",
  LLAMA_ARG_N_PREDICT: "n-predict",
  "no-jinja": "jinja",
  LLAMA_ARG_JINJA: "jinja",
  ub: "ubatch-size",
  LLAMA_ARG_UBATCH: "ubatch-size",
  embeddings: "embedding",
  LLAMA_ARG_EMBEDDINGS: "embedding",
  LLAMA_ARG_MMPROJ: "mmproj",
  mm: "mmproj",
  mmdev: "mmproj-device",
  MTMD_BACKEND_DEVICE: "mmproj-device",
  LLAMA_ARG_IMAGE_MAX_TOKENS: "image-max-tokens",
  np: "parallel",
  LLAMA_ARG_N_PARALLEL: "parallel",
  dev: "device",
  LLAMA_ARG_DEVICE: "device",
  sm: "split-mode",
  LLAMA_ARG_SPLIT_MODE: "split-mode",

  LLAMA_ARG_KV_UNIFIED_PER_SLOT: "kv-unified-per-slot",
};

// Router CLI options override model sections in the pinned llama.cpp runtime.
export function assertMediaPresetLimits(
  args: readonly string[],
  models: readonly { contextSize: number; imageMaxTokens: number }[],
): void {
  const limits: Record<string, number> = {
    "ctx-size": Math.min(...models.map((model) => model.contextSize)),
    "image-max-tokens": Math.min(...models.map((model) => model.imageMaxTokens)),
    parallel: 1,
  };
  for (let index = 0; index < args.length; index++) {
    const [option = "", inlineValue] = args[index]!.split("=", 2);
    const name = option.replace(/^--?/u, "").replaceAll("_", "-");
    const key = PRESET_KEY_ALIASES[name] ?? name;
    const limit = limits[key];
    if (limit === undefined) {
      continue;
    }
    const value = Number(inlineValue ?? args[++index]);
    if (!Number.isInteger(value) || value < 1 || value > limit) {
      throw new Error(
        `Router option ${option} exceeds the local media limit (${limit}). Lower it or move it into the existing model's preset section, then retry local media setup. Existing configuration is unchanged.`,
      );
    }
  }
}

const PRESET_SETTING_PATTERN =
  /(?<![^\r\n])([a-zA-Z_][a-zA-Z0-9_.-]*)([ \t]*=[ \t]*)([^\r\n]*?)([ \t]*(?:[;#][^\r\n]*)?)(\r\n|\n|\r|(?![\s\S]))/g;

function readSettingKeys(section: string | undefined): Set<string> {
  return new Set(
    [...(section ?? "").matchAll(PRESET_SETTING_PATTERN)].map(
      ([, key = ""]) => PRESET_KEY_ALIASES[key] ?? key,
    ),
  );
}

// Router children inherit the service env, so those keys count as configured too. A preset
// key becomes a child CLI option, which llama.cpp applies over the inherited env value.
function readServiceSettingKeys(service: LlamaServerPresetOptions["serviceSettings"]): Set<string> {
  const caseInsensitiveEnv = process.platform === "win32";
  const keys = [
    ...Object.entries(service?.env ?? {})
      .filter(([, value]) => value !== undefined)
      // The env aliases are uppercase, so this matches `llama_arg_n_parallel` the way Windows does.
      .map(([key]) => (caseInsensitiveEnv ? key.toUpperCase() : key))
      .filter((key) => key.startsWith("LLAMA_ARG_")),
    ...(service?.args ?? [])
      .filter((arg) => arg.startsWith("-"))
      // Native CLI normalizes underscores only in double-dash options.
      .map((arg) => (arg.startsWith("--") ? arg.slice(2).replaceAll("_", "-") : arg.slice(1))),
  ];
  return new Set(keys.map((key) => PRESET_KEY_ALIASES[key] ?? key));
}

function updateModelSection(
  sections: Map<string, string>,
  id: string,
  values: Record<string, string>,
  newline: string,
): void {
  assertIniValue(id, "llama.cpp model id");
  if (id.includes("]")) {
    throw new Error("llama.cpp model ids cannot contain ]");
  }
  // Native presets sort raw names before resolving quantization aliases.
  const name =
    [...sections.keys()]
      .filter((candidate) => normalizePresetName(candidate) === normalizePresetName(id))
      .toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .at(-1) ?? id;
  const pending = new Set(Object.keys(values));
  let contents = (sections.get(name) ?? `[${id}]${newline}`).replace(
    PRESET_SETTING_PATTERN,
    (line, key: string, separator: string, _value: string, comment: string, ending: string) => {
      const canonical = PRESET_KEY_ALIASES[key] ?? key;
      if (!Object.hasOwn(values, canonical)) {
        return line;
      }
      pending.delete(canonical);
      return `${canonical}${separator}${values[canonical]}${comment}${ending}`;
    },
  );
  for (const key of pending) {
    contents += `${/[\r\n]$/u.test(contents) ? "" : newline}${key} = ${values[key]}${newline}`;
  }
  sections.set(name, contents);
}

export function buildLlamaServerPreset(
  existing: string | undefined,
  params: LlamaServerPresetOptions,
): string {
  const newline = existing?.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  const { header, sections } = readModelSections(existing ?? "version = 1\n\n");
  const configuredIds = params.configuredChatModelIds
    ? new Set(params.configuredChatModelIds.map(normalizePresetName))
    : undefined;
  for (const id of sections.keys()) {
    if (
      id !== "*" &&
      id !== DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID &&
      (params.chatModel.mode === "remove" ||
        (configuredIds && !configuredIds.has(normalizePresetName(id))))
    ) {
      sections.delete(id);
    }
  }
  const models = [
    ...(params.chatModel.mode === "configure" ? [params.chatModel] : []),
    ...(params.mediaModels ?? []),
  ];
  for (const model of models) {
    updateModelSection(
      sections,
      model.id,
      {
        model: assertIniValue(model.path, "llama.cpp model path"),
        "ctx-size": String(model.contextSize ?? DEFAULT_LLAMA_CPP_CONTEXT_SIZE),
        "n-predict": String(model.maxTokens ?? 2048),
        jinja: "true",
        ...(model.projectorPath
          ? {
              mmproj: assertIniValue(model.projectorPath, "llama.cpp projector path"),
              "image-max-tokens": String(model.imageMaxTokens ?? 1024),
              parallel: "1",
              "load-on-startup": "false",
            }
          : {}),
        ...(model.device
          ? {
              device: assertIniValue(model.device, "llama.cpp device"),
              "mmproj-device": assertIniValue(model.device, "llama.cpp projector device"),
              "split-mode": "none",
            }
          : {}),
      },
      newline,
    );
  }
  const embeddingPath =
    params.embeddingModelPath ??
    (!sections.has(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID)
      ? params.defaultEmbeddingModelPath
      : undefined);
  if (embeddingPath) {
    const configured = new Set([
      ...readSettingKeys(sections.get(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID)),
      ...readSettingKeys(sections.get("*")),
      ...readServiceSettingKeys(params.serviceSettings),
    ]);
    // One slot bounds the vocabulary-sized output buffer to one input (ggml-org/llama.cpp#29388).
    const defaults: Record<string, string> = {
      parallel: "1",
      "ctx-size": String(DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE),
      "ubatch-size": String(DEFAULT_LLAMA_CPP_EMBEDDING_CONTEXT_SIZE),
    };
    // Explicit slots can divide total context; a per-slot cap can also auto-size it.
    if (configured.has("parallel") || configured.has("kv-unified-per-slot")) {
      delete defaults["ctx-size"];
    }
    for (const key of configured) {
      delete defaults[key];
    }
    updateModelSection(
      sections,
      DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID,
      {
        model: assertIniValue(embeddingPath, "llama.cpp embedding model path"),
        embedding: "true",
        ...defaults,
      },
      newline,
    );
  }
  const embeddingSection = sections.get(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID);
  if (!embeddingSection && params.mediaModels === undefined) {
    throw new Error("llama.cpp embedding model path is required for a new managed preset");
  }
  sections.delete(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_ID);
  const orderedSections = [
    ...[...sections]
      .toSorted(([left], [right]) => Number(left > right) - Number(left < right))
      .map(([, section]) => section),
    ...(embeddingSection ? [embeddingSection] : []),
  ];
  return (
    header +
    (header && !/[\r\n]$/u.test(header) ? newline : "") +
    orderedSections.map((section) => section.replace(/[\r\n]+$/u, "")).join(newline + newline) +
    newline
  );
}
