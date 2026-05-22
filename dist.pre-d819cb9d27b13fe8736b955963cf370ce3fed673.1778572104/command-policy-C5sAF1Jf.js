//#region extensions/whatsapp/src/command-policy.ts
const whatsappCommandPolicy = {
	enforceOwnerForCommands: true,
	preferSenderE164ForCommands: true,
	skipWhenConfigEmpty: true
};
//#endregion
export { whatsappCommandPolicy as t };
