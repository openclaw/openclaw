export async function prewarmMemorySearchWorker(): Promise<void> {
  const runtime = await import("./src/memory/manager-cpu-worker-runtime.js");
  await runtime.prewarmMemorySearchWorker();
}
