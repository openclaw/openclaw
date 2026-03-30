import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { listEnabledZaloAccounts } from "./accounts.js";
import type {
	ChannelMessageActionAdapter,
	ChannelMessageActionName,
	OpenClawConfig,
} from "./runtime-api.js";
import { extractToolSend, jsonResult, readStringParam } from "./runtime-api.js";

const loadZaloActionsRuntime = createLazyRuntimeNamedExport(
	() => import("./actions.runtime.js"),
	"zaloActionsRuntime",
);

const providerId = "zalo";

function listEnabledAccounts(cfg: OpenClawConfig) {
	return listEnabledZaloAccounts(cfg).filter(
		(account) => account.enabled && account.tokenSource !== "none",
	);
}

export const zaloMessageActions: ChannelMessageActionAdapter = {
	describeMessageTool: ({ cfg }) => {
		const accounts = listEnabledAccounts(cfg);
		if (accounts.length === 0) {
			return null;
		}
		const actions = new Set<ChannelMessageActionName>(["send"]);
		return { actions: Array.from(actions), capabilities: [] };
	},
	extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
	handleAction: async ({ action, params, cfg, accountId }) => {
		if (action === "send") {
			const to = readStringParam(params, "to", { required: true });
			const content = readStringParam(params, "message", {
				required: true,
				allowEmpty: true,
			});
			const mediaUrl = readStringParam(params, "media", { trim: false });

			const { sendMessageZalo } = await loadZaloActionsRuntime();
			const result = await sendMessageZalo(to ?? "", content ?? "", {
				accountId: accountId ?? undefined,
				mediaUrl: mediaUrl ?? undefined,
				cfg: cfg,
			});

			if (!result.ok) {
				return jsonResult({
					ok: false,
					error: result.error ?? "Failed to send Zalo message",
				});
			}

			return jsonResult({ ok: true, to, messageId: result.messageId });
		}

		throw new Error(
			`Action ${action} is not supported for provider ${providerId}.`,
		);
	},
};
