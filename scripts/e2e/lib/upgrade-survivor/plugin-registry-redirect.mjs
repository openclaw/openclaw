const registryValue = process.env.OPENCLAW_UPGRADE_SURVIVOR_NPM_REGISTRY?.trim();

if (registryValue) {
  const registry = new URL(registryValue);
  if (
    (registry.protocol !== "http:" && registry.protocol !== "https:") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(registry.hostname) ||
    registry.username ||
    registry.password ||
    registry.pathname !== "/" ||
    registry.search ||
    registry.hash
  ) {
    throw new Error("OPENCLAW_UPGRADE_SURVIVOR_NPM_REGISTRY must be a loopback HTTP(S) origin");
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const requestUrl = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    );
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(requestUrl.pathname);
    } catch {
      return originalFetch(input, init);
    }
    if (
      requestUrl.origin !== "https://registry.npmjs.org" ||
      !decodedPath.startsWith("/@openclaw/")
    ) {
      return originalFetch(input, init);
    }
    const redirected = new URL(`${requestUrl.pathname}${requestUrl.search}`, registry);
    return originalFetch(
      input instanceof Request ? new Request(redirected, input) : redirected,
      init,
    );
  };
}
