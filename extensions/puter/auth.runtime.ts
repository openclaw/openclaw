export async function getPuterAuthToken(): Promise<string> {
  const mod = await import("@heyputer/puter.js/src/init.cjs");
  const token = await mod.getAuthToken();
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Puter browser sign-in returned an empty auth token.");
  }
  return token.trim();
}
