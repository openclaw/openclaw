import { c as it } from "./dist-BosyQhji.js";
import { t as globalExpect } from "./test.DNmyFkvJ-C-ie2OOa.js";
//#region src/test-helpers/resolve-target-error-cases.ts
function installCommonResolveTargetErrorCases(params) {
	const { resolveTarget, implicitAllowFrom } = params;
	it("should error on normalization failure with allowlist (implicit mode)", () => {
		const result = resolveTarget({
			to: "invalid-target",
			mode: "implicit",
			allowFrom: implicitAllowFrom
		});
		globalExpect(result.ok).toBe(false);
		globalExpect(result.error).toBeDefined();
	});
	it("should error when no target provided with allowlist", () => {
		const result = resolveTarget({
			to: void 0,
			mode: "implicit",
			allowFrom: implicitAllowFrom
		});
		globalExpect(result.ok).toBe(false);
		globalExpect(result.error).toBeDefined();
	});
	it("should error when no target and no allowlist", () => {
		const result = resolveTarget({
			to: void 0,
			mode: "explicit",
			allowFrom: []
		});
		globalExpect(result.ok).toBe(false);
		globalExpect(result.error).toBeDefined();
	});
	it("should handle whitespace-only target", () => {
		const result = resolveTarget({
			to: "   ",
			mode: "explicit",
			allowFrom: []
		});
		globalExpect(result.ok).toBe(false);
		globalExpect(result.error).toBeDefined();
	});
}
//#endregion
export { installCommonResolveTargetErrorCases as t };
