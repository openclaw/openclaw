import { startQaLabServer } from "./lab-server.js";

export async function runQaE2eSelfCheck(params?: { repoRoot?: string; outputPath?: string }) {
  const server = await startQaLabServer({
    repoRoot: params?.repoRoot,
    outputPath: params?.outputPath,
  });
  try {
    return await server.runSelfCheck();
  } finally {
    await server.stop();
  }
}
