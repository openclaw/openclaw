export function resolveTestRuntime(env: NodeJS.ProcessEnv = process.env): "node" | "bun" {
  const runtime = env.OPENCLAW_VITEST_RUNTIME?.trim() || "node";
  if (runtime !== "node" && runtime !== "bun") {
    throw new Error(`Invalid OPENCLAW_VITEST_RUNTIME: ${runtime}; expected node or bun`);
  }
  return runtime;
}
