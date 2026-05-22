//#region extensions/whatsapp/src/doctor.ts
function normalizeCompatibilityConfig({ cfg }) {
	const legacyAckReaction = cfg.messages?.ackReaction?.trim();
	if (!legacyAckReaction || cfg.channels?.whatsapp === void 0) return {
		config: cfg,
		changes: []
	};
	if (cfg.channels.whatsapp?.ackReaction !== void 0) return {
		config: cfg,
		changes: []
	};
	const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
	let direct = true;
	let group = "mentions";
	if (legacyScope === "all") {
		direct = true;
		group = "always";
	} else if (legacyScope === "direct") {
		direct = true;
		group = "never";
	} else if (legacyScope === "group-all") {
		direct = false;
		group = "always";
	} else if (legacyScope === "group-mentions") {
		direct = false;
		group = "mentions";
	}
	return {
		config: {
			...cfg,
			channels: {
				...cfg.channels,
				whatsapp: {
					...cfg.channels?.whatsapp,
					ackReaction: {
						emoji: legacyAckReaction,
						direct,
						group
					}
				}
			}
		},
		changes: [`Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`]
	};
}
const whatsappDoctor = { normalizeCompatibilityConfig };
//#endregion
export { whatsappDoctor as n, normalizeCompatibilityConfig as t };
