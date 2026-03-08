import { webhookTargets } from "./state.js";

export function normalizeWebhookPath(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

export function registerWebhookTarget(target) {
  const key = normalizeWebhookPath(target.path);
  const entry = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, entry]);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((e) => e !== entry);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}
