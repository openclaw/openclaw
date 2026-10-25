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
