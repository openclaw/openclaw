import fs from "node:fs";
import path from "node:path";
import { readNativeTypeScriptConfig } from "./native-typescript-config.mts";

/** Admission for the native compiler's traced reads and untraced metadata lookups. */
export function createNativeDeclarationPolicy(
  root: string,
  config: string,
  originalConfig: string,
  admit: (file: string) => string,
  inputs: Set<string>,
) {
  const within = (file: string) => {
    const relative = path.relative(root, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const manifest = (file: string): Record<string, unknown> => {
    const accepted = admit(file);
    const value: unknown = JSON.parse(fs.readFileSync(accepted, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid declaration package manifest: ${file}`);
    }
    inputs.add(accepted);
    return value as Record<string, unknown>;
  };
  // A real root package scope stops native source-metadata lookup before ancestors.
  manifest(path.join(root, "package.json"));
  const parsed = readNativeTypeScriptConfig({
    cwd: root,
    configFileName: config,
    readFile: (file) => fs.readFileSync(admit(file), "utf8"),
  });
  const typeRoots: string[] = [];
  if (Array.isArray(parsed.options.typeRoots)) {
    for (const directory of parsed.options.typeRoots) {
      if (typeof directory !== "string") {
        throw new Error("Invalid native declaration typeRoots");
      }
      typeRoots.push(admit(directory));
    }
  } else {
    // Automatic type discovery has no trace. Keep every effective local root,
    // including nested config roots, while excluding ambient ancestor installs.
    for (
      let directory = path.dirname(originalConfig);
      within(directory);
      directory = path.dirname(directory)
    ) {
      typeRoots.push(admit(path.join(directory, "node_modules/@types")));
      if (directory === root) {
        break;
      }
    }
  }
  if (Array.isArray(parsed.options.types) && parsed.options.types.includes("*")) {
    for (const directory of typeRoots) {
      if (!fs.existsSync(directory)) {
        continue;
      }
      for (const entry of fs.readdirSync(directory)) {
        const packageDir = admit(path.join(directory, entry));
        if (
          fs.statSync(packageDir).isDirectory() &&
          fs.existsSync(path.join(packageDir, "package.json"))
        ) {
          manifest(path.join(packageDir, "package.json"));
        }
      }
    }
  }
  const ancestorInstalls: string[] = [];
  const ancestorNamespaces: string[] = [];
  for (let directory = path.dirname(root); ; directory = path.dirname(directory)) {
    const installation = path.join(directory, "node_modules");
    ancestorNamespaces.push(installation);
    if (fs.existsSync(installation) && fs.statSync(installation).isDirectory()) {
      ancestorInstalls.push(installation);
    }
    if (path.dirname(directory) === directory) {
      break;
    }
  }
  let unboundedLookup: Error | undefined;
  const observed = (file: string) => {
    const accepted = admit(file);
    if (fs.statSync(accepted).isFile()) {
      inputs.add(accepted);
    }
  };
  return {
    typeRoots,
    recordTrace(line: string) {
      const pair = /^Resolving real path for '(.+)', result '(.+)'\.$/u.exec(line);
      if (pair) {
        observed(pair[1]!);
        observed(pair[2]!);
        return;
      }
      const found =
        /^(?:Found 'package\.json' at '(.+)'|File '(.+)' exists(?: according to earlier cached lookups| - use it as a name resolution result))\.$/u.exec(
          line,
        );
      if (found) {
        observed(found[1] ?? found[2]!);
        return;
      }
      const missing =
        /^(?:File '(.+)' does not exist(?: according to earlier cached lookups)?\.|Directory '(.+)' does not exist, skipping all lookups in it\.)$/u.exec(
          line,
        );
      if (missing) {
        const requested = path.resolve(missing[1] ?? missing[2]!);
        const namespace = ancestorNamespaces.find(
          (installation) =>
            requested === installation || requested.startsWith(`${installation}${path.sep}`),
        );
        if (!within(requested) && (!namespace || ancestorInstalls.includes(namespace))) {
          unboundedLookup ??= new Error(
            namespace
              ? `Declaration resolution depends on an ancestor installation: ${requested}. Supply checkout-local declarations for this lookup or build in a separate physical checkout without ancestor node_modules (${namespace}).`
              : `Declaration resolution depends on an outside lookup: ${requested}. Keep declaration imports and their missing-file lookup locations inside ${root}.`,
          );
        }
        return;
      }
      const scope =
        /^Directory '(.+)' has no containing package\.json scope\. Imports will not resolve\.$/u.exec(
          line,
        );
      if (scope) {
        admit(scope[1]!);
        return;
      }
      if (/^File name '(.+)' has a '(.+)' extension - stripping it\.$/u.test(line)) {
        return;
      }
      if (
        /^(?:Found 'package\.json' at |File '|File name '|Directory '|Resolving real path for )/u.test(
          line,
        )
      ) {
        throw new Error(
          `Unrecognized native declaration resolution trace: ${JSON.stringify(line)}`,
        );
      }
    },
    admitEmissionSources(sources: Iterable<string>) {
      if (unboundedLookup) {
        throw unboundedLookup;
      }
      const packages = new Set<string>();
      for (const source of sources) {
        for (let directory = path.dirname(source); ; directory = path.dirname(directory)) {
          admit(directory);
          const file = path.join(directory, "package.json");
          if (fs.existsSync(file)) {
            packages.add(file);
            break;
          }
          if (directory === root) {
            throw new Error(`Missing declaration package scope: ${source}`);
          }
        }
      }
      for (const file of packages) {
        const metadata = manifest(file);
        const dependencies = new Set<string>();
        for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
          const value = metadata[field];
          if (value && typeof value === "object" && !Array.isArray(value)) {
            Object.keys(value).forEach((name) => dependencies.add(name));
          }
        }
        for (const name of dependencies) {
          if (!/^(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*$/u.test(name)) {
            throw new Error(`Invalid native declaration dependency name in ${file}: ${name}`);
          }
          let resolved = false;
          // Pinned TS7 ResolvePackageDirectory uses directory existence, ignoring
          // exports/main/types. Each level prefers implementation, then @types.
          for (
            let directory = path.dirname(file);
            within(directory);
            directory = path.dirname(directory)
          ) {
            if (path.basename(directory) !== "node_modules") {
              const candidates = [path.join(directory, "node_modules", name)];
              if (!parsed.options.noDtsResolution) {
                const typesName = name.startsWith("@") ? name.slice(1).replace("/", "__") : name;
                candidates.push(path.join(directory, "node_modules/@types", typesName));
              }
              for (const candidate of candidates) {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                  admit(candidate);
                  resolved = true;
                  break;
                }
              }
            }
            if (resolved || directory === root) {
              break;
            }
          }
          if (!resolved && ancestorInstalls.length) {
            throw new Error(
              `Cannot bound native declaration dependency ${name} from ${file}: no checkout-local package directory precedes ancestor installs (${ancestorInstalls.join(", ")}). Install the dependency locally or build in a separate physical checkout without ancestor node_modules.`,
            );
          }
        }
      }
    },
  };
}
