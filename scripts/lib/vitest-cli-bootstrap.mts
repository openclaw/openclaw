import { writeFailedTrailer } from "./failed-trailer.mts";
import { VITEST_INFRASTRUCTURE_EXIT_CODE } from "./vitest-outcome.mts";
import type { runVitestCli } from "./vitest-process.mts";

/** Own loader startup before any test execution module can import dependencies. */
export async function runVitestEntry(
  tool: string | undefined,
  load: () => Promise<Parameters<typeof runVitestCli>[1]>,
) {
  try {
    // Preserved compiled workers run native JavaScript without a generation-local TSX install.
    if (new URL(import.meta.url).pathname.endsWith(".mts")) {
      await import("../tsx.mjs");
    }
    const { runVitestCli } = await import("./vitest-process.mts");
    await runVitestCli(tool, await load());
  } catch (error) {
    console.error(error);
    process.exitCode = VITEST_INFRASTRUCTURE_EXIT_CODE;
    if (tool) {
      writeFailedTrailer(tool, VITEST_INFRASTRUCTURE_EXIT_CODE);
    }
  }
}
