/** Ephemeral, quoted UI references. These fields never carry configuration values. */
export const SYSTEM_AGENT_PLUGIN_REFERENCE_MAX_CHARS = 1024;
export const SYSTEM_AGENT_PLUGIN_ID_MAX_CHARS = 128;
export const SYSTEM_AGENT_PLUGIN_NAME_MAX_CHARS = 96;
export const SYSTEM_AGENT_SETTING_PATH_MAX_SEGMENTS = 16;
export const SYSTEM_AGENT_SETTING_SEGMENT_MAX_CHARS = 64;
export const SYSTEM_AGENT_PLUGIN_CAPABILITY_MAX_ITEMS = 8;
export const SYSTEM_AGENT_PLUGIN_CAPABILITY_MAX_CHARS = 128;
const CAPABILITY_GROUPS = [
  "tools",
  "providers",
  "channels",
  "contracts",
  "skills",
  "mcpServers",
] as const;

type PluginDeclaredCapabilities = Partial<Record<(typeof CAPABILITY_GROUPS)[number], string[]>> & {
  incomplete?: boolean;
};

export type SystemAgentPluginReference = {
  id: string;
  name: string;
  installed?: boolean;
  setting?: { path: string[]; label: string };
  declared?: PluginDeclaredCapabilities;
};

function addDeclaredCapabilities(reference: SystemAgentPluginReference, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  // SAFETY: the guard excludes null and arrays; each accepted group is validated below.
  const raw = value as Record<string, unknown>;
  // Reserve the omission marker before adding names. The setting keeps priority
  // and no clipped identifier can be mistaken for an actual tool or provider.
  const declared: PluginDeclaredCapabilities = { incomplete: true };
  reference.declared = declared;
  const fits = () => JSON.stringify(reference).length <= SYSTEM_AGENT_PLUGIN_REFERENCE_MAX_CHARS;
  if (!fits()) {
    delete reference.declared;
    return;
  }
  let incomplete = raw.incomplete === true;
  for (const group of CAPABILITY_GROUPS) {
    const items = raw[group];
    if (items === undefined) {
      continue;
    }
    if (!Array.isArray(items)) {
      incomplete = true;
      continue;
    }
    const accepted: string[] = [];
    declared[group] = accepted;
    if (!fits()) {
      delete declared[group];
      incomplete = true;
      continue;
    }
    const valid = items.filter(
      (item): item is string =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= SYSTEM_AGENT_PLUGIN_CAPABILITY_MAX_CHARS,
    );
    const names = [...new Set(valid)].toSorted();
    incomplete ||=
      valid.length !== items.length || names.length > SYSTEM_AGENT_PLUGIN_CAPABILITY_MAX_ITEMS;
    for (const item of names.slice(0, SYSTEM_AGENT_PLUGIN_CAPABILITY_MAX_ITEMS)) {
      accepted.push(item);
      if (!fits()) {
        accepted.pop();
        incomplete = true;
      }
    }
  }
  if (!incomplete) {
    delete declared.incomplete;
  }
}

export function normalizeSystemAgentPluginReference(
  value: unknown,
): SystemAgentPluginReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: the guard above excludes null and arrays; fields remain unknown until checked.
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,127}$/u.test(raw.id)) {
    return undefined;
  }
  if (
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > SYSTEM_AGENT_PLUGIN_NAME_MAX_CHARS
  ) {
    return undefined;
  }
  const reference: SystemAgentPluginReference = { id: raw.id, name: raw.name.trim() };
  if (typeof raw.installed === "boolean") {
    reference.installed = raw.installed;
  }
  if (raw.setting && typeof raw.setting === "object" && !Array.isArray(raw.setting)) {
    // SAFETY: the branch establishes a non-null object; each accepted field is validated below.
    const setting = raw.setting as Record<string, unknown>;
    if (
      Array.isArray(setting.path) &&
      setting.path.length > 0 &&
      setting.path.length <= SYSTEM_AGENT_SETTING_PATH_MAX_SEGMENTS &&
      setting.path.every(
        (part) =>
          typeof part === "string" &&
          part.length > 0 &&
          part.length <= SYSTEM_AGENT_SETTING_SEGMENT_MAX_CHARS,
      ) &&
      typeof setting.label === "string" &&
      setting.label.trim() &&
      setting.label.length <= SYSTEM_AGENT_PLUGIN_NAME_MAX_CHARS
    ) {
      reference.setting = { path: [...setting.path], label: setting.label.trim() };
    }
  }
  // JSON escaping can expand control characters sixfold. Bound the serialized
  // reference as well as individual fields; never trim a structural path.
  if (JSON.stringify(reference).length > SYSTEM_AGENT_PLUGIN_REFERENCE_MAX_CHARS) {
    delete reference.setting;
  }
  addDeclaredCapabilities(reference, raw.declared);
  return JSON.stringify(reference).length <= SYSTEM_AGENT_PLUGIN_REFERENCE_MAX_CHARS
    ? reference
    : undefined;
}
