const CATALOG_ID = /^[A-Za-z0-9_-]+$/u;
const OWNER_AND_NAME = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u;

/** Translate document URLs without changing the Gateway's opaque catalog identity. */
export function pluginCatalogRouteSuffix(id: string): string {
  if (id.startsWith("ch_")) {
    try {
      const identity = atob(id.slice(3).replaceAll("-", "+").replaceAll("_", "/"));
      const suffix = identity.startsWith("@") ? identity.slice(1) : "";
      if (OWNER_AND_NAME.test(suffix) && pluginCatalogIdFromRouteSuffix(suffix) === id) {
        return suffix;
      }
    } catch {
      // Local, unscoped, or noncanonical IDs keep their existing document URL.
    }
  }
  return id;
}

export function pluginCatalogIdFromRouteSuffix(suffix: string): string | null {
  if (OWNER_AND_NAME.test(suffix)) {
    return (
      "ch_" +
      btoa("@" + suffix)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")
    );
  }
  return CATALOG_ID.test(suffix) ? suffix : null;
}
