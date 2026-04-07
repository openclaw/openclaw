export async function runQaSuiteFromRuntime(
  ...args: Parameters<typeof import("./suite.js").runQaSuite>
) {
  const { runQaSuite } = await import("./suite.js");
  return await runQaSuite(...args);
}
