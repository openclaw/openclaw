export const DATABRICKS_DEFAULT_MODEL_REF = "databricks/databricks-meta-llama-3-1-70b-instruct";

export function normalizeDatabricksBaseUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  let normalized = url.trim();
  if (!normalized) {
    return undefined;
  }
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`;
  }
  return normalized.replace(/\/+$/, "");
}
