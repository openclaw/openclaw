import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
	build: {
		lib: {
			entry: {
				index: resolve(__dirname, "src/index.ts"),
				agent: resolve(__dirname, "src/agent.ts"),
				tools: resolve(__dirname, "src/tools/index.ts"),
				conversation: resolve(__dirname, "src/conversation.ts"),
				streaming: resolve(__dirname, "src/streaming.ts"),
			},
			formats: ["es"],
			fileName: (format, entryName) => `${entryName}.js`,
		},
		outDir: "dist",
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			external: [
				"ai",
				"@ai-sdk/openai",
				"@ai-sdk/anthropic",
				"@ai-sdk/google",
				"zod",
			],
			output: {
				preserveModules: true,
				preserveModulesRoot: "src",
			},
		},
		target: "esnext",
		minify: false,
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
});
