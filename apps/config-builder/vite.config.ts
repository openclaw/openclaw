import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONFIG_BUILDER_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    resolve: {
      alias: [
        {
          find: "@openclaw/config",
          replacement: path.resolve(repoRoot, "src/config"),
        },
        {
          // src/config/schema.ts imports ../version.js; redirect to a browser-safe shim.
          find: "../version.js",
          replacement: path.resolve(here, "src/shims/version.ts"),
        },
        {
          // src/config/schema.ts imports ../channels/registry.js; redirect to a light shim.
          find: "../channels/registry.js",
          replacement: path.resolve(here, "src/shims/channel-registry.ts"),
        },
      ],
    },
    optimizeDeps: {
      include: ["lit"],
    },
    build: {
      outDir: path.resolve(here, "../../dist/config-builder"),
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      host: true,
      port: 5174,
      strictPort: true,
    },
  };
});
