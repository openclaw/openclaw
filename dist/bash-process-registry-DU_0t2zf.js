import { r as generateSecureInt } from "./secure-random-BxnbXS5x.js";
//#region src/agents/session-slug.ts
const SLUG_ADJECTIVES = [
	"amber",
	"briny",
	"brisk",
	"calm",
	"clear",
	"cool",
	"crisp",
	"dawn",
	"delta",
	"ember",
	"faint",
	"fast",
	"fresh",
	"gentle",
	"glow",
	"good",
	"grand",
	"keen",
	"kind",
	"lucky",
	"marine",
	"mellow",
	"mild",
	"neat",
	"nimble",
	"nova",
	"oceanic",
	"plaid",
	"quick",
	"quiet",
	"rapid",
	"salty",
	"sharp",
	"swift",
	"tender",
	"tidal",
	"tidy",
	"tide",
	"vivid",
	"warm",
	"wild",
	"young"
];
const SLUG_NOUNS = [
	"atlas",
	"basil",
	"bison",
	"bloom",
	"breeze",
	"canyon",
	"cedar",
	"claw",
	"cloud",
	"comet",
	"coral",
	"cove",
	"crest",
	"crustacean",
	"daisy",
	"dune",
	"ember",
	"falcon",
	"fjord",
	"forest",
	"glade",
	"gulf",
	"harbor",
	"haven",
	"kelp",
	"lagoon",
	"lobster",
	"meadow",
	"mist",
	"nudibranch",
	"nexus",
	"ocean",
	"orbit",
	"otter",
	"pine",
	"prairie",
	"reef",
	"ridge",
	"river",
	"rook",
	"sable",
	"sage",
	"seaslug",
	"shell",
	"shoal",
	"shore",
	"slug",
	"summit",
	"tidepool",
	"trail",
	"valley",
	"wharf",
	"willow",
	"zephyr"
];
function randomChoice(values, fallback) {
	return values[generateSecureInt(values.length)] ?? fallback;
}
const SLUG_FALLBACK_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function createFallbackSuffix(length) {
	let suffix = "";
	for (let i = 0; i < length; i += 1) suffix += SLUG_FALLBACK_ALPHABET[generateSecureInt(36)] ?? "x";
	return suffix;
}
function createSlugBase(words = 2) {
	const parts = [randomChoice(SLUG_ADJECTIVES, "steady"), randomChoice(SLUG_NOUNS, "harbor")];
	if (words > 2) parts.push(randomChoice(SLUG_NOUNS, "reef"));
	return parts.join("-");
}
function createAvailableSlug(words, isIdTaken) {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const base = createSlugBase(words);
		if (!isIdTaken(base)) return base;
		for (let i = 2; i <= 12; i += 1) {
			const candidate = `${base}-${i}`;
			if (!isIdTaken(candidate)) return candidate;
		}
	}
}
function createSessionSlug$1(isTaken) {
	const isIdTaken = isTaken ?? (() => false);
	const twoWord = createAvailableSlug(2, isIdTaken);
	if (twoWord) return twoWord;
	const threeWord = createAvailableSlug(3, isIdTaken);
	if (threeWord) return threeWord;
	const fallback = `${createSlugBase(3)}-${createFallbackSuffix(3)}`;
	return isIdTaken(fallback) ? `${fallback}-${Date.now().toString(36)}` : fallback;
}
//#endregion
//#region src/agents/bash-process-registry.ts
const DEFAULT_JOB_TTL_MS = 1800 * 1e3;
const MIN_JOB_TTL_MS = 60 * 1e3;
const MAX_JOB_TTL_MS = 10800 * 1e3;
const DEFAULT_PENDING_OUTPUT_CHARS = 3e4;
function clampTtl(value) {
	if (!value || Number.isNaN(value)) return DEFAULT_JOB_TTL_MS;
	return Math.min(Math.max(value, MIN_JOB_TTL_MS), MAX_JOB_TTL_MS);
}
let jobTtlMs = clampTtl(Number.parseInt(process.env.PI_BASH_JOB_TTL_MS ?? "", 10));
const runningSessions = /* @__PURE__ */ new Map();
const finishedSessions = /* @__PURE__ */ new Map();
let sweeper = null;
function isSessionIdTaken(id) {
	return runningSessions.has(id) || finishedSessions.has(id);
}
function createSessionSlug() {
	return createSessionSlug$1(isSessionIdTaken);
}
function addSession(session) {
	runningSessions.set(session.id, session);
	startSweeper();
}
function getSession(id) {
	return runningSessions.get(id);
}
function getFinishedSession(id) {
	return finishedSessions.get(id);
}
function deleteSession(id) {
	runningSessions.delete(id);
	finishedSessions.delete(id);
}
function appendOutput(session, stream, chunk) {
	session.pendingStdout ??= [];
	session.pendingStderr ??= [];
	session.pendingStdoutChars ??= sumPendingChars(session.pendingStdout);
	session.pendingStderrChars ??= sumPendingChars(session.pendingStderr);
	const buffer = stream === "stdout" ? session.pendingStdout : session.pendingStderr;
	const bufferChars = stream === "stdout" ? session.pendingStdoutChars : session.pendingStderrChars;
	const pendingCap = Math.min(session.pendingMaxOutputChars ?? DEFAULT_PENDING_OUTPUT_CHARS, session.maxOutputChars);
	buffer.push(chunk);
	let pendingChars = bufferChars + chunk.length;
	if (pendingChars > pendingCap) {
		session.truncated = true;
		pendingChars = capPendingBuffer(buffer, pendingChars, pendingCap);
	}
	if (stream === "stdout") session.pendingStdoutChars = pendingChars;
	else session.pendingStderrChars = pendingChars;
	session.totalOutputChars += chunk.length;
	const aggregated = trimWithCap(session.aggregated + chunk, session.maxOutputChars);
	session.truncated = session.truncated || aggregated.length < session.aggregated.length + chunk.length;
	session.aggregated = aggregated;
	session.tail = tail(session.aggregated, 2e3);
}
function drainSession(session) {
	const stdout = session.pendingStdout.join("");
	const stderr = session.pendingStderr.join("");
	session.pendingStdout = [];
	session.pendingStderr = [];
	session.pendingStdoutChars = 0;
	session.pendingStderrChars = 0;
	return {
		stdout,
		stderr
	};
}
function markExited(session, exitCode, exitSignal, status, exitReason) {
	session.exited = true;
	session.exitCode = exitCode;
	session.exitSignal = exitSignal;
	session.exitReason = exitReason;
	session.tail = tail(session.aggregated, 2e3);
	moveToFinished(session, status);
}
function markBackgrounded(session) {
	session.backgrounded = true;
}
function moveToFinished(session, status) {
	runningSessions.delete(session.id);
	if (session.child) {
		session.child.stdin?.destroy?.();
		session.child.stdout?.destroy?.();
		session.child.stderr?.destroy?.();
		session.child.removeAllListeners();
		delete session.child;
	}
	if (session.stdin) {
		if (typeof session.stdin.destroy === "function") session.stdin.destroy();
		else if (typeof session.stdin.end === "function") session.stdin.end();
		try {
			session.stdin.destroyed = true;
		} catch {}
		delete session.stdin;
	}
	if (!session.backgrounded) return;
	finishedSessions.set(session.id, {
		id: session.id,
		command: session.command,
		scopeKey: session.scopeKey,
		startedAt: session.startedAt,
		endedAt: Date.now(),
		cwd: session.cwd,
		status,
		exitCode: session.exitCode,
		exitSignal: session.exitSignal,
		exitReason: session.exitReason,
		aggregated: session.aggregated,
		tail: session.tail,
		truncated: session.truncated,
		totalOutputChars: session.totalOutputChars
	});
}
function tail(text, max = 2e3) {
	if (text.length <= max) return text;
	return text.slice(text.length - max);
}
function sumPendingChars(buffer) {
	let total = 0;
	for (const chunk of buffer) total += chunk.length;
	return total;
}
function capPendingBuffer(buffer, pendingChars, cap) {
	if (pendingChars <= cap) return pendingChars;
	const last = buffer.at(-1);
	if (last && last.length >= cap) {
		buffer.length = 0;
		buffer.push(last.slice(last.length - cap));
		return cap;
	}
	let dropCount = 0;
	while (dropCount < buffer.length) {
		const chunk = buffer[dropCount];
		if (chunk === void 0 || pendingChars - chunk.length < cap) break;
		pendingChars -= chunk.length;
		dropCount += 1;
	}
	if (dropCount > 0) buffer.splice(0, dropCount);
	if (buffer.length && pendingChars > cap) {
		const overflow = pendingChars - cap;
		buffer[0] = buffer[0].slice(overflow);
		pendingChars = cap;
	}
	return pendingChars;
}
function trimWithCap(text, max) {
	if (text.length <= max) return text;
	return text.slice(text.length - max);
}
function listRunningSessions() {
	return Array.from(runningSessions.values()).filter((s) => s.backgrounded);
}
function listFinishedSessions() {
	return Array.from(finishedSessions.values());
}
function setJobTtlMs(value) {
	if (value === void 0 || Number.isNaN(value)) return;
	jobTtlMs = clampTtl(value);
	stopSweeper();
	startSweeper();
}
function pruneFinishedSessions() {
	const cutoff = Date.now() - jobTtlMs;
	for (const [id, session] of finishedSessions.entries()) if (session.endedAt < cutoff) finishedSessions.delete(id);
}
function startSweeper() {
	if (sweeper) return;
	sweeper = setInterval(pruneFinishedSessions, Math.max(3e4, jobTtlMs / 6));
	sweeper.unref?.();
}
function stopSweeper() {
	if (!sweeper) return;
	clearInterval(sweeper);
	sweeper = null;
}
//#endregion
export { drainSession as a, listFinishedSessions as c, markExited as d, setJobTtlMs as f, deleteSession as i, listRunningSessions as l, appendOutput as n, getFinishedSession as o, tail as p, createSessionSlug as r, getSession as s, addSession as t, markBackgrounded as u };
