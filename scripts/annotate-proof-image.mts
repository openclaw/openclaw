#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../ui/src/test-helpers/proof-annotations.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      annotations: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.input || !values.annotations || !values.out?.endsWith(".png")) {
    throw new Error("Usage: --input <raw.png> --annotations <frame.json> --out <annotated.png>");
  }
  const frame = JSON.parse(await readFile(values.annotations, "utf8")) as Parameters<
    typeof rasterizeProofAnnotations
  >[1];
  const image = await readFile(values.input);
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  try {
    const output = await rasterizeProofAnnotations(browser, { ...frame, image });
    await writeFile(values.out, output, { flag: "wx" });
    console.log(values.out);
  } finally {
    await browser.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
