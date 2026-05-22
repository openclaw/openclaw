import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { r as theme } from "./theme-CVJvORNs.js";
//#region src/terminal/health-style.ts
function styleHealthChannelLine(line, rich) {
	if (!rich) return line;
	const colon = line.indexOf(":");
	if (colon === -1) return line;
	const label = line.slice(0, colon + 1);
	const detail = line.slice(colon + 1).trimStart();
	const normalized = normalizeLowercaseStringOrEmpty(detail);
	const applyPrefix = (prefix, color) => `${label} ${color(detail.slice(0, prefix.length))}${detail.slice(prefix.length)}`;
	if (normalized.startsWith("failed")) return applyPrefix("failed", theme.error);
	if (normalized.startsWith("ok")) return applyPrefix("ok", theme.success);
	if (normalized.startsWith("linked")) return applyPrefix("linked", theme.success);
	if (normalized.startsWith("configured")) return applyPrefix("configured", theme.success);
	if (normalized.startsWith("not linked")) return applyPrefix("not linked", theme.warn);
	if (normalized.startsWith("not configured")) return applyPrefix("not configured", theme.muted);
	if (normalized.startsWith("unknown")) return applyPrefix("unknown", theme.warn);
	return line;
}
//#endregion
export { styleHealthChannelLine as t };
