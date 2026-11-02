import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Only this reviewed native protocol is implemented. Catalog strings cannot select
// an arbitrary destination, model alias, or another upstream credential owner.
export function grantsLuna(rows: readonly unknown[]): boolean {
  return rows.some(
    (provider) =>
      isRecord(provider) &&
      provider.id === "openai" &&
      provider.nativeBaseUrl === "/v1/native/openai" &&
      Array.isArray(provider.routes) &&
      provider.routes.some(
        (route: unknown) =>
          isRecord(route) &&
          route.path === "/v1/decisions" &&
          route.requestFormat === "openai.decisions" &&
          Array.isArray(route.methods) &&
          route.methods.includes("POST"),
      ) &&
      Array.isArray(provider.models) &&
      provider.models.some(
        (model: unknown) =>
          isRecord(model) &&
          model.id === "openai/gpt-6-luna" &&
          model.upstream === "gpt-6-luna" &&
          Array.isArray(model.capabilities) &&
          model.capabilities.includes("llm.decisions"),
      ),
  );
}
