export const CORTEX_PATH = "/api/v2/cortex/v1";

export function snowflakeUrl(value: string | undefined, path: string): URL {
  const url = value ? URL.parse(value) : null;
  if (
    !url ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".snowflakecomputing.com") ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== path
  ) {
    throw new Error(
      `Configure models.providers.snowflake.baseUrl as https://<account>.snowflakecomputing.com${CORTEX_PATH}.`,
    );
  }
  return url;
}
