import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConfiguredModulesDir } from "./tsx-cli-shim.mjs";

function isWithin(root, target) {
  const rel = relative(root, target);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith("../") &&
    !rel.startsWith("..\\") &&
    !isAbsolute(rel)
  );
}

function contained(root, target) {
  const physical = realpathSync(target);
  if (!isWithin(root, physical)) {
    throw new Error("Tooling package escapes its installed dependency owner.");
  }
  return physical;
}

function packageName(specifier) {
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

function declaredVersion(manifest, name) {
  return (
    manifest.dependencies?.[name] ??
    manifest.devDependencies?.[name] ??
    manifest.optionalDependencies?.[name]
  );
}

function readManifest(checkout) {
  return JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
}

function qualifiedPackage(manifest, root, specifier, consumer, owner = root) {
  const name = packageName(specifier);
  const required = declaredVersion(manifest, name);
  const modules = realpathSync(join(root, "node_modules"));
  // A workspace link would execute another checkout's source. Only installed
  // third-party packages can fill missing dependencies in this checkout.
  const directory = contained(modules, join(owner, "node_modules", name));
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
    const directory = qualifiedPackage(readManifest(checkout), root, "tsx/esm", consumer);
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
  const checkout = realpathSync(params.get("checkout"));
  const consumer = params.get("consumer");
  const manifests = new Map([[checkout, readManifest(checkout)]]);
  const sourceOwner = (context) => {
    const importer = context.parentURL?.startsWith("file:")
      ? fileURLToPath(context.parentURL)
      : undefined;
    if (
      !importer ||
      !isWithin(checkout, importer) ||
      relative(checkout, importer).split(sep).includes("node_modules")
    ) {
      return undefined;
    }
    let directory = dirname(contained(checkout, importer));
    while (!manifests.has(directory)) {
      if (statSync(join(directory, "package.json"), { throwIfNoEntry: false })?.isFile()) {
        manifests.set(directory, readManifest(directory));
        break;
      }
      directory = dirname(directory);
    }
    return { directory, manifest: manifests.get(directory) };
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isAbsolute(specifier) || /^(?:\.{1,2}(?:\/|$)|[a-z][a-z\d+.-]*:|#)/i.test(specifier)) {
        return nextResolve(specifier, context);
      }
      const owner = sourceOwner(context);
      // Dependency-owned imports retain their own private versions and failures.
      if (!owner) {
        return nextResolve(specifier, context);
      }
      let resolved;
      try {
        resolved = nextResolve(specifier, context);
      } catch (error) {
        if (
          error?.code !== "ERR_MODULE_NOT_FOUND" &&
          !declaredVersion(owner.manifest, packageName(specifier))
        ) {
          throw error;
        }
      }
      if (resolved) {
        const target = resolved.url.startsWith("file:") ? fileURLToPath(resolved.url) : undefined;
        if (!target || isWithin(checkout, realpathSync(target))) {
          return resolved;
        }
        if (!target.split(sep).includes("node_modules")) {
          throw new Error("Tooling package escapes its installed dependency owner.");
        }
      }
      // A workspace package owns its pins and its donor resolution context.
      // Its pnpm links may land in the root store, never in foreign source.
      const donor =
        owner.directory === checkout
          ? root
          : contained(root, join(root, relative(checkout, owner.directory)));
      const directory = qualifiedPackage(owner.manifest, root, specifier, consumer, donor);
      resolved = nextResolve(specifier, {
        ...context,
        parentURL: pathToFileURL(join(donor, "package.json")).href,
      });
      contained(directory, fileURLToPath(resolved.url));
      return resolved;
    },
  });
}
