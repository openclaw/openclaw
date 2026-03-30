import type { ResolvedBrowserProfile } from "../config.js";
import {
	DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH,
	DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS,
	DEFAULT_AI_SNAPSHOT_MAX_CHARS,
} from "../constants.js";
import {
	resolveDefaultSnapshotFormat,
	shouldUsePlaywrightForAriaSnapshot,
	shouldUsePlaywrightForScreenshot,
} from "../profile-capabilities.js";
import { toBoolean, toNumber, toStringOrEmpty } from "./utils.js";

export type BrowserSnapshotPlan = {
	format: "ai" | "aria";
	mode?: "efficient";
	labels?: boolean;
	limit?: number;
	resolvedMaxChars?: number;
	interactive?: boolean;
	compact?: boolean;
	depth?: number;
	refsMode?: "aria" | "role";
	selectorValue?: string;
	frameSelectorValue?: string;
	wantsRoleSnapshot: boolean;
};

export function resolveSnapshotPlan(params: {
	profile: ResolvedBrowserProfile;
	query: Record<string, unknown>;
	hasPlaywright: boolean;
}): BrowserSnapshotPlan {
	const mode = params.query.mode === "efficient" ? "efficient" : undefined;
	const labels = toBoolean(params.query.labels) ?? undefined;
	const explicitFormat =
		params.query.format === "aria"
			? "aria"
			: params.query.format === "ai"
				? "ai"
				: undefined;
	const format = resolveDefaultSnapshotFormat({
		profile: params.profile,
		hasPlaywright: params.hasPlaywright,
		explicitFormat,
		mode,
	});
	const limitRaw =
		typeof params.query.limit === "string"
			? Number(params.query.limit)
			: undefined;
	const hasMaxChars = Object.hasOwn(params.query, "maxChars");
	const maxCharsRaw =
		typeof params.query.maxChars === "string"
			? Number(params.query.maxChars)
			: undefined;
	const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
	const maxChars =
		typeof maxCharsRaw === "number" &&
		Number.isFinite(maxCharsRaw) &&
		maxCharsRaw > 0
			? Math.floor(maxCharsRaw)
			: undefined;
	const resolvedMaxChars =
		format === "ai"
			? hasMaxChars
				? maxChars
				: mode === "efficient"
					? DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS
					: DEFAULT_AI_SNAPSHOT_MAX_CHARS
			: undefined;
	const interactiveRaw = toBoolean(params.query.interactive);
	const compactRaw = toBoolean(params.query.compact);
	const depthRaw = toNumber(params.query.depth);
	const refsModeRaw = toStringOrEmpty(params.query.refs).trim();
	const refsMode: "aria" | "role" | undefined =
		refsModeRaw === "aria"
			? "aria"
			: refsModeRaw === "role"
				? "role"
				: undefined;
	const interactive =
		interactiveRaw ?? (mode === "efficient" ? true : undefined);
	const compact = compactRaw ?? (mode === "efficient" ? true : undefined);
	const depth =
		depthRaw ??
		(mode === "efficient" ? DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH : undefined);
	const selectorValue =
		toStringOrEmpty(params.query.selector).trim() || undefined;
	const frameSelectorValue =
		toStringOrEmpty(params.query.frame).trim() || undefined;

	return {
		format,
		mode,
		labels,
		limit,
		resolvedMaxChars,
		interactive,
		compact,
		depth,
		refsMode,
		selectorValue,
		frameSelectorValue,
		wantsRoleSnapshot:
			labels === true ||
			mode === "efficient" ||
			interactive === true ||
			compact === true ||
			depth !== undefined ||
			Boolean(selectorValue) ||
			Boolean(frameSelectorValue),
	};
}

export { shouldUsePlaywrightForAriaSnapshot, shouldUsePlaywrightForScreenshot };
