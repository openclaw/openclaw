export async function fetchXService(
  host: "api.x.com" | "api.github.com",
  path: string,
  init: RequestInit,
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
  assertActive?: () => void | (() => void) | Promise<void | (() => void)>,
  onDispatch?: () => void,
): Promise<Response> {
  const url = `https://${host}${path}`;
  const authorize =
    (dispatch: typeof fetch): typeof fetch =>
    async (input, prepared) => {
      const assertCurrent = await assertActive?.();
      prepared?.signal?.throwIfAborted();
      assertCurrent?.();
      onDispatch?.();
      return dispatch(input, prepared);
    };
  if (fetchImpl) {
    return authorize((input, prepared) => fetchImpl(String(input), prepared))(url, init);
  }
  const [{ fetchWithSsrFGuard }, { responseWithRelease }, { fetchWithRuntimeDispatcher }] =
    await Promise.all([
      import("openclaw/plugin-sdk/ssrf-runtime"),
      import("openclaw/plugin-sdk/fetch-runtime"),
      import("openclaw/plugin-sdk/runtime-fetch"),
    ]);
  const guarded = await fetchWithSsrFGuard({
    url,
    init,
    capture: false,
    requireHttps: true,
    policy: { hostnameAllowlist: [host] },
    maxRedirects: 0,
    fetchImpl: authorize(fetchWithRuntimeDispatcher),
  });
  // Activity streams retain the pinned dispatcher until their bodies are consumed.
  return responseWithRelease(guarded.response, guarded.release);
}
