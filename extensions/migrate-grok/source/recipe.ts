const MAX_GROK_BOT_RECIPE_BYTES = 25 * 1024 * 1024;

export type GrokBotImportWarning = { code: string; message: string };

export type GrokBotRecipe = {
  profile: {
    name: string;
    title?: string;
    description: string;
    avatarColor?: string;
    avatarShape?: string;
  };
  memory: Array<{ kind?: "profile" | "log"; createdAt?: string; content: string }>;
  skills: Array<{ name: string; description: string; content: string }>;
  routines: Array<{ name: string; slug: string; description: string; content: string }>;
  plugins: Array<{ name: string; description?: string; pluginId: string }>;
  gettingStarted?: { skill: string };
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Grok Bot recipe: ${path} must be an object.`);
  }
  // SAFETY: The guard excludes null, arrays, and primitives; property values remain unknown.
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid Grok Bot recipe: ${path} must be a string.`);
  }
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function items(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Grok Bot recipe: ${path} must be an array.`);
  }
  return value.map((item, i) => record(item, `${path}[${i}]`));
}

export function parseGrokBotRecipe(input: string | Uint8Array): GrokBotRecipe {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (bytes.byteLength > MAX_GROK_BOT_RECIPE_BYTES) {
    throw new Error("Grok Bot recipe exceeds the 25 MiB import limit.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Grok Bot recipe must be valid UTF-8 JSON.");
  }
  const root = record(decoded, "recipe");
  const profile = record(root.profile, "profile");
  const name = text(profile.name, "profile.name");
  if (!name.trim()) {
    throw new Error("Invalid Grok Bot recipe: profile.name must not be empty.");
  }
  return {
    profile: {
      name,
      title: optionalText(profile.title, "profile.title"),
      description: text(profile.description, "profile.description"),
      avatarColor: optionalText(profile.avatarColor, "profile.avatarColor"),
      avatarShape: optionalText(profile.avatarShape, "profile.avatarShape"),
    },
    memory: items(root.memory, "memory").map((item, i) => {
      if (item.kind !== undefined && item.kind !== "profile" && item.kind !== "log") {
        throw new Error(`Invalid Grok Bot recipe: memory[${i}].kind must be profile or log.`);
      }
      return {
        kind: item.kind,
        createdAt: optionalText(item.createdAt, `memory[${i}].createdAt`),
        content: text(item.content, `memory[${i}].content`),
      };
    }),
    skills: items(root.skills, "skills").map((item, i) => ({
      name: text(item.name, `skills[${i}].name`),
      description: text(item.description, `skills[${i}].description`),
      content: text(item.content, `skills[${i}].content`),
    })),
    routines: items(root.routines, "routines").map((item, i) => ({
      name: text(item.name, `routines[${i}].name`),
      slug: text(item.slug, `routines[${i}].slug`),
      description: text(item.description, `routines[${i}].description`),
      content: text(item.content, `routines[${i}].content`),
    })),
    plugins: items(root.plugins, "plugins").map((item, i) => ({
      name: text(item.name, `plugins[${i}].name`),
      description: optionalText(item.description, `plugins[${i}].description`),
      pluginId: text(item.pluginId, `plugins[${i}].pluginId`),
    })),
    ...(root.gettingStarted !== undefined
      ? {
          gettingStarted: {
            skill: text(
              record(root.gettingStarted, "gettingStarted").skill,
              "gettingStarted.skill",
            ),
          },
        }
      : {}),
  };
}
