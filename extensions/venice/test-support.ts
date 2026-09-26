import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

type VeniceTestApi = {
  setImageFetchGuard: (impl: typeof fetchWithSsrFGuard | null) => void;
  setVideoFetchGuard: (impl: typeof fetchWithSsrFGuard | null) => void;
};

function getVeniceTestApi(): VeniceTestApi {
  const api = Reflect.get(globalThis, Symbol.for("openclaw.veniceTestApi"));
  if (!api) {
    throw new Error("Venice test API is unavailable");
  }
  return api as VeniceTestApi;
}

export function setVeniceImageFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  getVeniceTestApi().setImageFetchGuard(impl);
}

export function setVeniceVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  getVeniceTestApi().setVideoFetchGuard(impl);
}
