import fs from "node:fs/promises";

export async function cleanupCrablineResources(close: () => Promise<void>, authDir?: string) {
  const errors: unknown[] = [];
  try {
    await close();
  } catch (error) {
    errors.push(error);
  }
  if (authDir) {
    try {
      await fs.rm(authDir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Crabline resource cleanup failed");
  }
}
