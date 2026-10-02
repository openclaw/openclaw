import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConfiguredModulesDir } from "./tsx-cli-shim.mjs";

function contained(root, target) {
  const physical = realpathSync(target);
  const rel = relative(root, physical);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new Error("Tooling package escapes its installed dependency owner.");
  }
  return physical;
}

function qualifiedPackage(checkout, root, specifier, consumer) {
  const name = specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
  const manifest = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  const required =
    manifest.dependencies?.[name] ??
    manifest.devDependencies?.[name] ??
    manifest.optionalDependencies?.[name];
  const modules = realpathSync(join(root, "node_modules"));
  // A workspace link would execute another checkout's source. Only installed
  // third-party packages can fill missing dependencies in this checkout.
  const directory = contained(modules, join(modules, name));
  const installed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (!required || installed.name !== name || installed.version !== required) {
    throw new Error(
      `Installed ${consumer} dependency '${name}' has version ${installed.version}; this checkout requires ${required ?? "undeclared"}. Tooling root: ${root}. Refresh that tooling root with pnpm install --frozen-lockfile in a clean main checkout or install dependencies locally.`,
    );
  }
  return directory;
}

// Keep repository identity aligned with scripts/pr's tooling-root bootstrap.
function repository(url, root) {
  if (/^(?:\.?\.?\/|\/)/.test(url)) {
    return realpathSync(resolve(root, url));
  }
  const parsed = new URL(url.replace(/^git@([^:]+):/, "ssh://git@$1/"));
  if (parsed.protocol === "file:") {
    return realpathSync(decodeURIComponent(parsed.pathname));
  }
  return `${parsed.hostname.toLowerCase()}/${parsed.pathname
    .replace(/^\/|\/$/g, "")
    .replace(/\.git$/, "")
    .toLowerCase()}`;
}

export function toolingDependencyOptions(checkout, consumer, { tsx = false } = {}) {
  // A configured pnpm modules directory keeps the shim's existing link contract.
  if (
    statSync(join(checkout, "node_modules"), { throwIfNoEntry: false })?.isDirectory() ||
    resolveConfiguredModulesDir(checkout)
  ) {
    return {};
  }
  let root = checkout;
  try {
    const git = (cwd, args) =>
      spawnSync(process.env.OPENCLAW_PR_GIT || "git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const common = git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.status !== 0) {
      throw new Error("Cannot find the canonical checkout.");
    }
    const canonical = realpathSync(dirname(common.stdout.trim()));
    let requested = process.env.OPENCLAW_PR_TOOLING_ROOT;
    if (!requested) {
      const config = git(canonical, ["config", "--path", "--get", "openclaw.pr.toolingRoot"]);
      if (config.status !== 0 && config.status !== 1) {
        throw new Error("Cannot read openclaw.pr.toolingRoot.");
      }
      requested = config.stdout.trim();
    }
    root = resolve(canonical, requested || ".");
    root = realpathSync(root);
    if (requested) {
      const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
      const top = git(root, ["rev-parse", "--show-toplevel"]);
      if (
        inside.status !== 0 ||
        inside.stdout.trim() !== "true" ||
        top.status !== 0 ||
        realpathSync(top.stdout.trim()) !== root
      ) {
        throw new Error("Not a repository top level.");
      }
      const sparse = git(root, ["config", "--bool", "--get", "core.sparseCheckout"]);
      if (sparse.status !== 0 && sparse.status !== 1) {
        throw new Error("Cannot read core.sparseCheckout.");
      }
      if (sparse.stdout.trim() === "true") {
        throw new Error("Sparse checkout.");
      }
      const origin = git(root, ["remote", "get-url", "origin"]);
      const checkoutOrigin = git(checkout, ["remote", "get-url", "origin"]);
      if (origin.status !== 0 || checkoutOrigin.status !== 0) {
        throw new Error("Cannot identify origin repository.");
      }
      if (
        repository(origin.stdout.trim(), root) !==
        repository(checkoutOrigin.stdout.trim(), checkout)
      ) {
        throw new Error("Different repository.");
      }
    }
    if (!statSync(join(root, "node_modules"), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("Missing node_modules.");
    }
  } catch (error) {
    throw new Error(
      `Cannot resolve tooling dependencies at ${root}. ${error.message} Install dependencies in this checkout or set OPENCLAW_PR_TOOLING_ROOT to an installed checkout of this repository.`,
      { cause: error },
    );
  }
  const hook = new URL(import.meta.url);
  hook.searchParams.set("root", root);
  hook.searchParams.set("checkout", checkout);
  hook.searchParams.set("consumer", consumer);
  let tsxImport;
  if (tsx) {
    const directory = qualifiedPackage(checkout, root, "tsx/esm", consumer);
    const require = createRequire(join(directory, "package.json"));
    tsxImport = pathToFileURL(contained(directory, require.resolve("tsx/esm"))).href;
  }
  console.error(`[${consumer}] resolving missing packages from scripts/pr tooling root ${root}`);
  // A node_modules link would change scripts/pr's wrapper selection in this checkout.
  return { execArgv: ["--import", hook.href], ...(tsxImport ? { tsxImport } : {}) };
}

const params = new URL(import.meta.url).searchParams;
const root = params.get("root");
if (root) {
  const checkout = params.get("checkout");
  const consumer = params.get("consumer");
  const parentURL = pathToFileURL(join(root, "package.json")).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let resolved;
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (
          error?.code !== "ERR_MODULE_NOT_FOUND" ||
          isAbsolute(specifier) ||
          /^(?:\.{1,2}(?:\/|$)|[a-z][a-z\d+.-]*:|#)/i.test(specifier)
        ) {
          throw error;
        }
        resolved = nextResolve(specifier, { ...context, parentURL });
      }
      const directory = qualifiedPackage(checkout, root, specifier, consumer);
      contained(directory, fileURLToPath(resolved.url));
      return resolved;
    },
  });
}
