import { runClawLoopVNext } from "../src/claw-loop-vnext/cli.js";

const result = await runClawLoopVNext(process.argv.slice(2));
process.exit(result.exitCode);
