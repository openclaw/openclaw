import { vi } from "vitest";
import type { ProviderExternalAuthProfileResolver } from "../../plugins/provider-external-auth.types.js";

const controls = vi.hoisted(() => {
  let resolver: ProviderExternalAuthProfileResolver | undefined;
  return {
    resetResolveExternalAuthProfilesForTest: (): void => {
      resolver = undefined;
    },
    setResolveExternalAuthProfilesForTest: (next: ProviderExternalAuthProfileResolver): void => {
      resolver = next;
    },
    resolve(
      fallback: ProviderExternalAuthProfileResolver,
      params: Parameters<ProviderExternalAuthProfileResolver>[0],
    ) {
      return (resolver ?? fallback)(params);
    },
  };
});

// Consumers import this fixture before native composition captures the runtime factory.
vi.mock("./external-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./external-auth.js")>();
  return {
    ...actual,
    createExternalAuthRuntime: (
      resolve: ProviderExternalAuthProfileResolver,
      withPreparedExternalAuthProfiles: Parameters<typeof actual.createExternalAuthRuntime>[1],
    ) =>
      actual.createExternalAuthRuntime(
        (params) => controls.resolve(resolve, params),
        withPreparedExternalAuthProfiles,
      ),
  };
});

export const testing = {
  resetResolveExternalAuthProfilesForTest: controls.resetResolveExternalAuthProfilesForTest,
  setResolveExternalAuthProfilesForTest: controls.setResolveExternalAuthProfilesForTest,
};
