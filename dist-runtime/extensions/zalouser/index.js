import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-D6VN4BvH.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
import "../../json-bigint-DeX5rJv1.js";
import "../../safe-buffer-jOKScm-I.js";
import { C as listZaloFriendsMatching, E as listZaloGroupsMatching, N as setZalouserRuntime, b as checkZaloAuthenticated, i as sendMessageZalouser, n as sendImageZalouser, r as sendLinkZalouser, x as getZaloUserInfo } from "../../send-n-6XRXNN.js";
import "../../form_data-CpN48AVv.js";
import { t as zalouserPlugin } from "../../channel-cB-7k_hp.js";
import { Type } from "@sinclair/typebox";
//#region extensions/zalouser/src/tool.ts
const ACTIONS = [
	"send",
	"image",
	"link",
	"friends",
	"groups",
	"me",
	"status"
];
function stringEnum(values, options = {}) {
	return Type.Unsafe({
		type: "string",
		enum: [...values],
		...options
	});
}
const ZalouserToolSchema = Type.Object({
	action: stringEnum(ACTIONS, { description: `Action to perform: ${ACTIONS.join(", ")}` }),
	threadId: Type.Optional(Type.String({ description: "Thread ID for messaging" })),
	message: Type.Optional(Type.String({ description: "Message text" })),
	isGroup: Type.Optional(Type.Boolean({ description: "Is group chat" })),
	profile: Type.Optional(Type.String({ description: "Profile name" })),
	query: Type.Optional(Type.String({ description: "Search query" })),
	url: Type.Optional(Type.String({ description: "URL for media/link" }))
}, { additionalProperties: false });
function json(payload) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(payload, null, 2)
		}],
		details: payload
	};
}
async function executeZalouserTool(_toolCallId, params, _signal, _onUpdate) {
	try {
		switch (params.action) {
			case "send": {
				if (!params.threadId || !params.message) throw new Error("threadId and message required for send action");
				const result = await sendMessageZalouser(params.threadId, params.message, {
					profile: params.profile,
					isGroup: params.isGroup
				});
				if (!result.ok) throw new Error(result.error || "Failed to send message");
				return json({
					success: true,
					messageId: result.messageId
				});
			}
			case "image": {
				if (!params.threadId) throw new Error("threadId required for image action");
				if (!params.url) throw new Error("url required for image action");
				const result = await sendImageZalouser(params.threadId, params.url, {
					profile: params.profile,
					caption: params.message,
					isGroup: params.isGroup
				});
				if (!result.ok) throw new Error(result.error || "Failed to send image");
				return json({
					success: true,
					messageId: result.messageId
				});
			}
			case "link": {
				if (!params.threadId || !params.url) throw new Error("threadId and url required for link action");
				const result = await sendLinkZalouser(params.threadId, params.url, {
					profile: params.profile,
					caption: params.message,
					isGroup: params.isGroup
				});
				if (!result.ok) throw new Error(result.error || "Failed to send link");
				return json({
					success: true,
					messageId: result.messageId
				});
			}
			case "friends": return json(await listZaloFriendsMatching(params.profile, params.query));
			case "groups": return json(await listZaloGroupsMatching(params.profile, params.query));
			case "me": return json(await getZaloUserInfo(params.profile) ?? { error: "Not authenticated" });
			case "status": {
				const authenticated = await checkZaloAuthenticated(params.profile);
				return json({
					authenticated,
					output: authenticated ? "authenticated" : "not authenticated"
				});
			}
			default:
				params.action;
				throw new Error(`Unknown action: ${String(params.action)}. Valid actions: send, image, link, friends, groups, me, status`);
		}
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : String(err) });
	}
}
//#endregion
//#region extensions/zalouser/index.ts
const plugin = {
	id: "zalouser",
	name: "Zalo Personal",
	description: "Zalo personal account messaging via native zca-js integration",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setZalouserRuntime(api.runtime);
		api.registerChannel(zalouserPlugin);
		if (api.registrationMode !== "full") return;
		api.registerTool({
			name: "zalouser",
			label: "Zalo Personal",
			description: "Send messages and access data via Zalo personal account. Actions: send (text message), image (send image URL), link (send link), friends (list/search friends), groups (list groups), me (profile info), status (auth check).",
			parameters: ZalouserToolSchema,
			execute: executeZalouserTool
		});
	}
};
//#endregion
export { plugin as default };
