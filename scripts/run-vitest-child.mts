// The JavaScript launcher owns reporting after this execution process closes.
import { exitVitestBySignal, runGitHubOfflineTests } from "./lib/vitest-process.mts";
import { runVitest } from "./run-vitest.mts";

await runGitHubOfflineTests(() => runVitest(exitVitestBySignal));
