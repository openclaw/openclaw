export function parseTestProjectsArgs(args) {
  const forwardedArgs = [];
  let watchMode = false;

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--watch") {
      watchMode = true;
      continue;
    }
    forwardedArgs.push(arg);
  }

  return { forwardedArgs, watchMode };
}

export function buildVitestArgs(args) {
  const { forwardedArgs, watchMode } = parseTestProjectsArgs(args);
  return [
    "exec",
    "vitest",
    ...(watchMode ? [] : ["run"]),
    "--config",
    "vitest.config.ts",
    ...forwardedArgs,
  ];
}
