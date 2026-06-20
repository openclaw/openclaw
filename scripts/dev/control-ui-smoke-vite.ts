import { join } from "node:path";

export function controlUiSmokeViteResolve(root = process.cwd()) {
  return {
    alias: [
      {
        find: "./openclaw-root.js",
        replacement: join(root, "scripts/dev/browser-stubs/openclaw-root.ts"),
      },
      {
        find: "../infra/openclaw-root.js",
        replacement: join(root, "scripts/dev/browser-stubs/openclaw-root.ts"),
      },
      {
        find: "../../infra/openclaw-root.js",
        replacement: join(root, "scripts/dev/browser-stubs/openclaw-root.ts"),
      },
      {
        find: "../../../infra/openclaw-root.js",
        replacement: join(root, "scripts/dev/browser-stubs/openclaw-root.ts"),
      },
      {
        find: "./private-qa-cli.js",
        replacement: join(root, "scripts/dev/browser-stubs/private-qa-cli.ts"),
      },
      {
        find: "../config/paths.js",
        replacement: join(root, "scripts/dev/browser-stubs/config-paths.ts"),
      },
      {
        find: "../../config/paths.js",
        replacement: join(root, "scripts/dev/browser-stubs/config-paths.ts"),
      },
      {
        find: "../../../config/paths.js",
        replacement: join(root, "scripts/dev/browser-stubs/config-paths.ts"),
      },
      {
        find: /^@openclaw\/normalization-core\/(.+)$/,
        replacement: join(root, "packages/normalization-core/src/$1.ts"),
      },
      {
        find: "@openclaw/normalization-core",
        replacement: join(root, "packages/normalization-core/src/index.ts"),
      },
      {
        find: /^@openclaw\/media-core\/(.+)$/,
        replacement: join(root, "packages/media-core/src/$1.ts"),
      },
      {
        find: "@openclaw/media-core",
        replacement: join(root, "packages/media-core/src/index.ts"),
      },
      {
        find: /^@openclaw\/net-policy\/(.+)$/,
        replacement: join(root, "packages/net-policy/src/$1.ts"),
      },
      {
        find: "@openclaw/net-policy",
        replacement: join(root, "packages/net-policy/src/index.ts"),
      },
    ],
  };
}
