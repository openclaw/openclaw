import type { Api, Model } from "@mariozechner/pi-ai";

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";
  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai) return model;

  const compat = model.compat ?? {};
  if (compat.supportsDeveloperRole === false) return model;

  model.compat = { ...compat, supportsDeveloperRole: false };
  return model;
}
