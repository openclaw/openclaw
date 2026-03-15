import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../paths-OqPpu-UR.js";
import "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-BpDGEQsl.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import "../../compat-DDXNEdAm.js";
import "../../inbound-envelope-DsNRW6ln.js";
import "../../run-command-Psw08BkS.js";
import "../../device-pairing-DYWF-CWB.js";
import "../../line-iO245OTq.js";
import "../../upsert-with-lock-CLs2bE4R.js";
import "../../self-hosted-provider-setup-C4OZCxyb.js";
import "../../ollama-setup-BM-G12b6.js";
import "../../json-bigint-fVriNVNM.js";
import "../../safe-buffer-B4qVAFt3.js";
import { C as listZaloFriendsMatching, E as listZaloGroupsMatching, N as setZalouserRuntime, b as checkZaloAuthenticated, i as sendMessageZalouser, n as sendImageZalouser, r as sendLinkZalouser, x as getZaloUserInfo } from "../../send-BhRqDvr62.js";
import "../../form_data-Clx54gfw.js";
import { t as zalouserPlugin } from "../../channel-B8g4wlNG.js";
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
