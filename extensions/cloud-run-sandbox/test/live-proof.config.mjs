import { fileURLToPath } from "node:url";

export default {
  cwd: fileURLToPath(new URL("../../../", import.meta.url)),
  entry: ["extensions/cloud-run-sandbox/test/live-proof.mjs"],
  platform: "node",
  target: "node24",
  dts: false,
  outDir: ".artifacts/cloud-run-live",
  deps: { neverBundle: [/^openclaw(?:\/|$)/, "zod"] },
};
