import "./security-audit-shared-Q0jwS14J.js";
//#region extensions/feishu/src/message-action-contract.ts
const messageActionTargetAliases = {
	read: { aliases: ["messageId"] },
	pin: { aliases: ["messageId"] },
	unpin: { aliases: ["messageId"] },
	"list-pins": { aliases: ["chatId"] },
	"channel-info": { aliases: ["chatId"] }
};
//#endregion
export { messageActionTargetAliases as t };
