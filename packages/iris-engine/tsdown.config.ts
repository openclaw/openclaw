import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/agent-loop.ts", "src/iris-agent.ts"],
  outDir: "dist",
  platform: "node",
  fixedExtension: false,
  dts: true,
  clean: true,
});
