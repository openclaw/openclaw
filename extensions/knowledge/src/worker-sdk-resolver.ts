import Module from "node:module";
import { fileURLToPath } from "node:url";

type BunWorkerRuntime = {
  plugin(options: {
    name: string;
    setup(builder: {
      onResolve(
        options: { filter: RegExp; namespace: "file" },
        resolve: (args: { path: string }) => { path: string; namespace: string } | undefined,
      ): void;
    }): void;
  }): void;
};

/** Workers reuse the exact SDK modules selected by their host thread. */
export function installWorkerSdkResolver(sdk: Record<string, string>): void {
  // SAFETY: Bun exposes this synchronous public API; Node leaves the optional global absent.
  const bun = (globalThis as typeof globalThis & { Bun?: BunWorkerRuntime }).Bun;
  if (bun) {
    const paths = new Map(Object.entries(sdk).map(([name, url]) => [name, fileURLToPath(url)]));
    bun.plugin({
      // The standalone adapter rebases this resolver's SDK targets into its embedded graph.
      name: "openclaw-plugin-sdk-alias",
      setup(builder) {
        builder.onResolve(
          { filter: /^openclaw\/plugin-sdk(?:\/|$)/u, namespace: "file" },
          ({ path: specifier }) => {
            const target = paths.get(specifier);
            return target ? { path: target, namespace: "file" } : undefined;
          },
        );
      },
    });
    return;
  }
  Module.registerHooks({
    resolve(specifier, context, next) {
      const url = sdk[specifier];
      return url ? { url, shortCircuit: true } : next(specifier, context);
    },
  });
}
