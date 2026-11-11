import { registerHooks } from "node:module";

export function installReportFixtureTransport(fixture: string, failureMessage: string) {
  globalThis.fetch = async () => {
    throw new Error(failureMessage);
  };
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "openclaw/plugin-sdk/ssrf-runtime"
        ? {
            url: new URL(fixture, import.meta.url).href,
            shortCircuit: true,
          }
        : nextResolve(specifier, context);
    },
  });
}
