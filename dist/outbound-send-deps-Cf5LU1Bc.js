//#region src/cli/outbound-send-mapping.ts
function createOutboundSendDepsFromCliSource(deps) {
	return {
		sendWhatsApp: deps.sendMessageWhatsApp,
		sendTelegram: deps.sendMessageTelegram,
		sendDiscord: deps.sendMessageDiscord,
		sendSlack: deps.sendMessageSlack,
		sendSignal: deps.sendMessageSignal,
		sendIMessage: deps.sendMessageIMessage
	};
}
//#endregion
//#region src/cli/deps.ts
let whatsappSenderRuntimePromise = null;
let telegramSenderRuntimePromise = null;
let discordSenderRuntimePromise = null;
let slackSenderRuntimePromise = null;
let signalSenderRuntimePromise = null;
let imessageSenderRuntimePromise = null;
function loadWhatsAppSenderRuntime() {
	whatsappSenderRuntimePromise ??= import("./deps-send-whatsapp.runtime-DrDIJVnq.js");
	return whatsappSenderRuntimePromise;
}
function loadTelegramSenderRuntime() {
	telegramSenderRuntimePromise ??= import("./deps-send-telegram.runtime-DkiQUZJV.js");
	return telegramSenderRuntimePromise;
}
function loadDiscordSenderRuntime() {
	discordSenderRuntimePromise ??= import("./deps-send-discord.runtime-BURaFQdK.js");
	return discordSenderRuntimePromise;
}
function loadSlackSenderRuntime() {
	slackSenderRuntimePromise ??= import("./deps-send-slack.runtime-d_bB8t-N.js");
	return slackSenderRuntimePromise;
}
function loadSignalSenderRuntime() {
	signalSenderRuntimePromise ??= import("./deps-send-signal.runtime-D57XI5qF.js");
	return signalSenderRuntimePromise;
}
function loadIMessageSenderRuntime() {
	imessageSenderRuntimePromise ??= import("./deps-send-imessage.runtime-DdX_tfLr.js");
	return imessageSenderRuntimePromise;
}
function createDefaultDeps() {
	return {
		sendMessageWhatsApp: async (...args) => {
			const { sendMessageWhatsApp } = await loadWhatsAppSenderRuntime();
			return await sendMessageWhatsApp(...args);
		},
		sendMessageTelegram: async (...args) => {
			const { sendMessageTelegram } = await loadTelegramSenderRuntime();
			return await sendMessageTelegram(...args);
		},
		sendMessageDiscord: async (...args) => {
			const { sendMessageDiscord } = await loadDiscordSenderRuntime();
			return await sendMessageDiscord(...args);
		},
		sendMessageSlack: async (...args) => {
			const { sendMessageSlack } = await loadSlackSenderRuntime();
			return await sendMessageSlack(...args);
		},
		sendMessageSignal: async (...args) => {
			const { sendMessageSignal } = await loadSignalSenderRuntime();
			return await sendMessageSignal(...args);
		},
		sendMessageIMessage: async (...args) => {
			const { sendMessageIMessage } = await loadIMessageSenderRuntime();
			return await sendMessageIMessage(...args);
		}
	};
}
function createOutboundSendDeps$1(deps) {
	return createOutboundSendDepsFromCliSource(deps);
}
//#endregion
//#region src/cli/outbound-send-deps.ts
function createOutboundSendDeps(deps) {
	return createOutboundSendDepsFromCliSource(deps);
}
//#endregion
export { createDefaultDeps as n, createOutboundSendDeps$1 as r, createOutboundSendDeps as t };
