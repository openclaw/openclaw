import { b as escapeRegExp, l as normalizeE164, p as resolveUserPath, t as CONFIG_DIR } from "./utils-927g1oFZ.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-ZEce9oym.js";
import "./text-runtime-Dm9-PE_c.js";
import "./runtime-env-SuJzy_mk.js";
import "./account-resolution-BjQzGUOQ.js";
import fs from "node:fs";
import path from "node:path";
//#region extensions/whatsapp/src/targets-runtime.ts
const WHATSAPP_FENCE_PLACEHOLDER = "\0FENCE";
const WHATSAPP_INLINE_CODE_PLACEHOLDER = "\0CODE";
function assertWebChannel(input) {
	if (input !== "web") throw new Error("Web channel must be 'web'");
}
function isSelfChatMode(selfE164, allowFrom) {
	if (!selfE164) return false;
	if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false;
	const normalizedSelf = normalizeE164(selfE164);
	return allowFrom.some((n) => {
		if (n === "*") return false;
		try {
			return normalizeE164(String(n)) === normalizedSelf;
		} catch {
			return false;
		}
	});
}
function toWhatsappJid(number) {
	const withoutPrefix = number.replace(/^whatsapp:/i, "").trim();
	if (withoutPrefix.includes("@")) return withoutPrefix;
	return `${normalizeE164(withoutPrefix).replace(/\D/g, "")}@s.whatsapp.net`;
}
function toWhatsappJidWithLid(number, opts) {
	const stripped = number.replace(/^whatsapp:/i, "").trim();
	if (stripped.includes("@")) return stripped;
	const phoneDigits = normalizeE164(stripped).replace(/\D/g, "");
	const lid = readLidForwardMapping({
		phoneDigits,
		opts
	});
	return lid ? `${lid}@lid` : `${phoneDigits}@s.whatsapp.net`;
}
function resolveLidMappingDirs(params) {
	const dirs = /* @__PURE__ */ new Set();
	const addDir = (dir) => {
		if (!dir) return;
		dirs.add(resolveUserPath(dir));
	};
	addDir(params.opts?.authDir);
	for (const dir of params.opts?.lidMappingDirs ?? []) addDir(dir);
	addDir(CONFIG_DIR);
	addDir(path.join(CONFIG_DIR, "credentials"));
	return [...dirs];
}
function readLidReverseMapping(params) {
	const mappingFilename = `lid-mapping-${params.lid}_reverse.json`;
	const mappingDirs = resolveLidMappingDirs({ opts: params.opts });
	for (const dir of mappingDirs) {
		const mappingPath = path.join(dir, mappingFilename);
		try {
			const data = fs.readFileSync(mappingPath, "utf8");
			const phone = JSON.parse(data);
			if (phone === null || phone === void 0) continue;
			return normalizeE164(String(phone));
		} catch {}
	}
	return null;
}
function readLidForwardMapping(params) {
	const mappingFilename = `lid-mapping-${params.phoneDigits}.json`;
	const mappingDirs = resolveLidMappingDirs({ opts: params.opts });
	for (const dir of mappingDirs) {
		const mappingPath = path.join(dir, mappingFilename);
		try {
			const data = fs.readFileSync(mappingPath, "utf8");
			const lid = JSON.parse(data);
			if (lid === null || lid === void 0) continue;
			const digits = String(lid).replace(/\D/g, "");
			if (digits) return digits;
		} catch {}
	}
	return null;
}
function jidToE164(jid, opts) {
	const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
	if (match) return `+${match[1]}`;
	const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
	if (!lidMatch) return null;
	const phone = readLidReverseMapping({
		lid: lidMatch[1],
		opts
	});
	if (phone) return phone;
	if (opts?.logMissing ?? shouldLogVerbose()) logVerbose(`LID mapping not found for ${lidMatch[1]}; skipping inbound message`);
	return null;
}
async function resolveJidToE164(jid, opts) {
	if (!jid) return null;
	const direct = jidToE164(jid, opts);
	if (direct) return direct;
	if (!/(@lid|@hosted\.lid)$/.test(jid) || !opts?.lidLookup?.getPNForLID) return null;
	try {
		const pnJid = await opts.lidLookup.getPNForLID(jid);
		if (!pnJid) return null;
		return jidToE164(pnJid, opts);
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`LID mapping lookup failed for ${jid}: ${String(err)}`);
		return null;
	}
}
function markdownToWhatsApp(text) {
	if (!text) return text;
	const fences = [];
	let result = text.replace(/```[\s\S]*?```/g, (match) => {
		fences.push(match);
		return `${WHATSAPP_FENCE_PLACEHOLDER}${fences.length - 1}`;
	});
	const inlineCodes = [];
	result = result.replace(/`[^`\n]+`/g, (match) => {
		inlineCodes.push(match);
		return `${WHATSAPP_INLINE_CODE_PLACEHOLDER}${inlineCodes.length - 1}`;
	});
	result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
	result = result.replace(/__(.+?)__/g, "*$1*");
	result = result.replace(/~~(.+?)~~/g, "~$1~");
	result = result.replace(new RegExp(`${escapeRegExp(WHATSAPP_INLINE_CODE_PLACEHOLDER)}(\\d+)`, "g"), (_, idx) => inlineCodes[Number(idx)] ?? "");
	result = result.replace(new RegExp(`${escapeRegExp(WHATSAPP_FENCE_PLACEHOLDER)}(\\d+)`, "g"), (_, idx) => fences[Number(idx)] ?? "");
	return result;
}
//#endregion
export { resolveJidToE164 as a, markdownToWhatsApp as i, isSelfChatMode as n, toWhatsappJid as o, jidToE164 as r, toWhatsappJidWithLid as s, assertWebChannel as t };
