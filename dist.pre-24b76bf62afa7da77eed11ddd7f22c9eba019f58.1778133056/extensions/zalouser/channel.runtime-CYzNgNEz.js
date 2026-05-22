import { i as formatErrorMessage } from "../../errors-QN8rySzW.js";
import "../../error-runtime-ByBXRpxU.js";
import { t as collectZalouserSecurityAuditFindings } from "./security-audit-Bh2v7o-V.js";
import { a as listZaloGroupMembers, b as waitForZaloQrLogin, c as logoutZaloProfile, i as listZaloFriendsMatching, n as getZaloUserInfo, s as listZaloGroupsMatching, y as startZaloQrLogin } from "./zalo-js-oVPmcseP.js";
import { a as sendReactionZalouser, i as sendMessageZalouser } from "./send-DgVzclMq.js";
//#region extensions/zalouser/src/probe.ts
async function probeZalouser(profile, timeoutMs) {
	try {
		const user = timeoutMs ? await Promise.race([getZaloUserInfo(profile), new Promise((resolve) => setTimeout(() => resolve(null), Math.max(timeoutMs, 1e3)))]) : await getZaloUserInfo(profile);
		if (!user) return {
			ok: false,
			error: "Not authenticated"
		};
		return {
			ok: true,
			user
		};
	} catch (error) {
		return {
			ok: false,
			error: formatErrorMessage(error)
		};
	}
}
//#endregion
export { collectZalouserSecurityAuditFindings, getZaloUserInfo, listZaloFriendsMatching, listZaloGroupMembers, listZaloGroupsMatching, logoutZaloProfile, probeZalouser, sendMessageZalouser, sendReactionZalouser, startZaloQrLogin, waitForZaloQrLogin };
