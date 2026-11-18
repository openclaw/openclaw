import { createHash } from "node:crypto";
import path from "node:path";

function identityPath(value, sourceRoot) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    return value;
  }
  const relative = path.relative(sourceRoot, value);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    return value;
  }
  // This tagged value exists only in the hash input, never in compiler options.
  return { sourceRelativePath: relative.split(path.sep).join("/") };
}

/** Hash checkout-owned paths by identity without changing their resolution values. */
export function standaloneSourceContextIdentity(sourceRoot, context) {
  return {
    ...context,
    ...(context.alias
      ? {
          alias: Object.fromEntries(
            Object.entries(context.alias).map(([name, target]) => [
              name,
              identityPath(target, sourceRoot),
            ]),
          ),
        }
      : {}),
    ...(Object.hasOwn(context, "cwd") ? { cwd: identityPath(context.cwd, sourceRoot) } : {}),
    ...(Object.hasOwn(context, "tsconfig")
      ? { tsconfig: identityPath(context.tsconfig, sourceRoot) }
      : {}),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value instanceof RegExp) {
    return { regexp: value.source, flags: value.flags };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** Bind recorded typed source inputs before build identity is stamped into the graph. */
export function standaloneSourceGraphSha256(sourceRoot, manifest) {
  const identity = {
    contexts: manifest.contexts
      .map((context) => standaloneSourceContextIdentity(sourceRoot, context))
      .toSorted((left, right) => compare(left.id, right.id)),
    roots: manifest.roots.toSorted(),
    files: manifest.files.toSorted(
      (left, right) => compare(left.source, right.source) || compare(left.context, right.context),
    ),
  };
  return createHash("sha256")
    .update("openclaw-standalone-source-v1\0")
    .update(JSON.stringify(stableValue(identity)))
    .digest("hex");
}
