import { runQaE2eSelfCheck } from "../src/qa-e2e/runner.js";

const outputPath = process.argv[2]?.trim() || ".artifacts/qa-e2e/self-check.md";

const result = await runQaE2eSelfCheck({ outputPath });
process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
