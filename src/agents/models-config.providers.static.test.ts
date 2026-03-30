import { describe, expect, it } from "vitest";
import {
	loadBundledProviderCatalogExportMap,
	resolveBundledProviderCatalogEntries,
} from "./models-config.providers.static.js";

describe("models-config bundled provider catalogs", () => {
	it("detects provider catalogs from plugin folders via metadata artifacts", () => {
		const entries = resolveBundledProviderCatalogEntries();
		expect(entries.map((entry) => entry.dirName)).toEqual(
			expect.arrayContaining(["openrouter", "volcengine"]),
		);
		expect(
			entries.find((entry) => entry.dirName === "volcengine"),
		).toMatchObject({
			dirName: "volcengine",
			pluginId: "volcengine",
		});
	});

	it("loads provider catalog exports from detected plugin folders", async () => {
		const exports = await loadBundledProviderCatalogExportMap();
		expect(exports.buildOpenrouterProvider).toBeTypeOf("function");
		expect(exports.buildDoubaoProvider).toBeTypeOf("function");
		expect(exports.buildDoubaoCodingProvider).toBeTypeOf("function");
	});
});
