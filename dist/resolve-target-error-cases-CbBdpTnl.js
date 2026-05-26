import { expect, it } from "vitest";
//#region src/test-helpers/resolve-target-error-cases.ts
function installCommonResolveTargetErrorCases(params) {
	const { resolveTarget, implicitAllowFrom } = params;
	const expectResolveTargetError = (result) => {
		expect(result.ok).toBe(false);
		if (result.error === void 0) throw new Error("expected resolveTarget to return an error");
	};
	it("should error on normalization failure with allowlist (implicit mode)", () => {
		expectResolveTargetError(resolveTarget({
			to: "invalid-target",
			mode: "implicit",
			allowFrom: implicitAllowFrom
		}));
	});
	it("should error when no target provided with allowlist", () => {
		expectResolveTargetError(resolveTarget({
			to: void 0,
			mode: "implicit",
			allowFrom: implicitAllowFrom
		}));
	});
	it("should error when no target and no allowlist", () => {
		expectResolveTargetError(resolveTarget({
			to: void 0,
			mode: "explicit",
			allowFrom: []
		}));
	});
	it("should handle whitespace-only target", () => {
		expectResolveTargetError(resolveTarget({
			to: "   ",
			mode: "explicit",
			allowFrom: []
		}));
	});
}
//#endregion
export { installCommonResolveTargetErrorCases as t };
