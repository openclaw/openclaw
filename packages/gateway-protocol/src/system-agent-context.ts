/** Ephemeral, quoted UI references. These fields never carry configuration values. */
export const SYSTEM_AGENT_PLUGIN_REFERENCE_MAX_CHARS = 1024;
export const SYSTEM_AGENT_PLUGIN_ID_MAX_CHARS = 128;
export const SYSTEM_AGENT_PLUGIN_NAME_MAX_CHARS = 96;
export const SYSTEM_AGENT_SETTING_PATH_MAX_SEGMENTS = 16;
export const SYSTEM_AGENT_SETTING_SEGMENT_MAX_CHARS = 64;

export type SystemAgentPluginReference = {
  id: string;
  name: string;
  installed?: boolean;
  setting?: { path: string[]; label: string };
};

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
  return JSON.stringify(reference).length <= SYSTEM_AGENT_PLUGIN_REFERENCE_MAX_CHARS
    ? reference
    : undefined;
}
