import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("implicit provider plugin allowlist compatibility", () => {
	it("keeps bundled implicit providers discoverable when plugins.allow is set", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv(["KILOCODE_API_KEY", "MOONSHOT_API_KEY"]);
		process.env.KILOCODE_API_KEY = "test-kilo-key"; // pragma: allowlist secret
		process.env.MOONSHOT_API_KEY = "test-moonshot-key"; // pragma: allowlist secret

		try {
			const providers = await resolveImplicitProvidersForTest({
				agentDir,
				config: {
					plugins: {
						allow: ["openrouter"],
					},
				},
			});
			expect(providers?.kilocode).toBeDefined();
			expect(providers?.moonshot).toBeDefined();
		} finally {
			envSnapshot.restore();
		}
	});

	it("still honors explicit plugin denies over compat allowlist injection", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
		const envSnapshot = captureEnv(["KILOCODE_API_KEY", "MOONSHOT_API_KEY"]);
		process.env.KILOCODE_API_KEY = "test-kilo-key"; // pragma: allowlist secret
		process.env.MOONSHOT_API_KEY = "test-moonshot-key"; // pragma: allowlist secret

		try {
			const providers = await resolveImplicitProvidersForTest({
				agentDir,
				config: {
					plugins: {
						allow: ["openrouter"],
						deny: ["kilocode"],
					},
				},
			});
			expect(providers?.kilocode).toBeUndefined();
			expect(providers?.moonshot).toBeDefined();
		} finally {
			envSnapshot.restore();
		}
	});
});
