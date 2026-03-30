import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("loads the plugin-entry runtime wrapper through native ESM import", async () => {
	const wrapperPath = path.join(
		process.cwd(),
		"extensions",
		"matrix",
		"src",
		"plugin-entry.runtime.js",
	);
	const wrapperUrl = pathToFileURL(wrapperPath);
	const mod = await import(wrapperUrl.href);

	expect(mod).toMatchObject({
		ensureMatrixCryptoRuntime: expect.any(Function),
		handleVerifyRecoveryKey: expect.any(Function),
		handleVerificationBootstrap: expect.any(Function),
		handleVerificationStatus: expect.any(Function),
	});
}, 240_000);
