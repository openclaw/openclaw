const BLOCKED_MERGE_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function deepMergeDefined(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === void 0 ? base : override;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_MERGE_KEYS.has(key) || value === void 0) {
      continue;
    }
    const existing = result[key];
    result[key] = key in result ? deepMergeDefined(existing, value) : value;
  }
  return result;
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export {
  deepMergeDefined
};
