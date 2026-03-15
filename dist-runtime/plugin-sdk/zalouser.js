import { i as __require, o as __toESM, r as __exportAll, t as __commonJSMin } from "./chunk-DORXReHP.js";
import { g as normalizeAccountId, h as DEFAULT_ACCOUNT_ID } from "./session-key-CbP51u9x.js";
import { Ct as warnMissingProviderGroupPolicyFallbackOnce, bt as resolveDefaultGroupPolicy, fn as createAccountListHelpers, ft as evaluateGroupRouteAccessForPolicy, gt as resolveSenderScopedGroupPolicy, xt as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-DRRlb-lt.js";
import { Ka as createScopedPairingAccess, L as createPluginRuntimeStore, Nt as formatAllowFromLowercase, Wa as issuePairingChallenge, Xt as resolveMentionGatingWithBypass, eo as createTypingCallbacks, m as setTopLevelChannelDmPolicyWithAllowFrom, r as mergeAllowFromEntries, t as addWildcardAllowFrom } from "./setup-wizard-helpers-Bds9SZeS.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-DEV1v8zB.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-DGafsubg.js";
import "./subsystem-BunQspj4.js";
import "./utils-C9epF7GR.js";
import "./fetch-s6LpGbVn.js";
import "./retry-Bdb5CNwD.js";
import { t as emptyPluginConfigSchema } from "./config-schema-X8cahxVt.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-0CmwkA_V.js";
import "./paths-BoU0P6Xb.js";
import { o as formatResolvedUnresolvedNote } from "./plugin-sdk-VLbTPvOr.js";
import "./webhook-targets-DPRi3syU.js";
import { A as ToolPolicySchema, H as buildBaseAccountStatusSnapshot } from "./signal-Bycwzc0M.js";
import { T as MarkdownConfigSchema, a as formatPairingApproveHint, n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection, u as buildChannelConfigSchema } from "./config-helpers-C9J9Kf27.js";
import "./fetch-CokEYQHV.js";
import "./exec-LHBFP7K9.js";
import "./agent-scope-BAdJcjtf.js";
import { a as patchScopedAccountConfig, n as applySetupAccountConfigPatch, r as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "./setup-helpers-kuIKtuQw.js";
import { n as createReplyPrefixOptions, u as formatDocsLink } from "./reply-prefix-B-13vT7e.js";
import "./logger-kC9I1OJ3.js";
import "./fetch-guard-COmtEumo.js";
import "./resolve-route-5UJLanKQ.js";
import "./pairing-token-BUkoGEse.js";
import "./query-expansion-DrHj090u.js";
import "./redact-DDISwu8-.js";
import "./channel-plugin-common-cMzLzrLW.js";
import "./secret-file-B_1xic5c.js";
import "./line-DxANBoSD.js";
import { i as resolveSenderCommandAuthorization, n as resolveChannelAccountConfigBasePath, o as buildChannelSendResult, t as chunkTextForOutbound } from "./text-chunking-Km2nBx_6.js";
import { a as resolveOutboundMediaUrls, o as sendMediaWithLeadingCaption, r as isNumericTargetId, s as sendPayloadWithChunkedTextAndMedia } from "./reply-payload-Cm6YO5gx.js";
import "./inbound-reply-dispatch-SyBMbS2x.js";
import { t as loadOutboundMediaFromUrl } from "./outbound-media-nwsOJ3Sf.js";
import "./run-command-Z5uOHylE.js";
import "./device-pairing-cTvIZwx2.js";
import { i as mergeAllowlist, o as summarizeMapping } from "./resolve-utils-D-PSzOHf.js";
import "./bluebubbles-BUOnMB_W.js";
import "./upsert-with-lock-A5dg0Uin.js";
import "./self-hosted-provider-setup-DGcVewib.js";
import "./ollama-setup-CObwBzad.js";
import "./vllm-setup-Pbn0jwU6.js";
import "./compat.js";
import { r as require_semver, t as require_form_data } from "./form_data-BQr7BHm-.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto$1, { randomUUID } from "node:crypto";
import fs$1, { writeFile } from "node:fs/promises";
import WebSocket$1 from "ws";
import EventEmitter from "events";
//#region extensions/zalouser/src/setup-core.ts
const channel$1 = "zalouser";
const zalouserSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: () => null,
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: input.name
		});
		return applySetupAccountConfigPatch({
			cfg: accountId !== "default" ? migrateBaseNameToDefaultAccount({
				cfg: namedConfig,
				channelKey: channel$1
			}) : namedConfig,
			channelKey: channel$1,
			accountId,
			patch: {}
		});
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/Errors/ZaloApiError.js
var ZaloApiError = class extends Error {
	constructor(message, code) {
		super(message);
		this.name = "ZcaApiError";
		this.code = code || null;
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/Errors/ZaloApiMissingImageMetadataGetter.js
var ZaloApiMissingImageMetadataGetter = class extends ZaloApiError {
	constructor() {
		super("Missing `imageMetadataGetter`. Please provide it in the Zalo object options.");
		this.name = "ZaloApiMissingImageMetadataGetter";
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/Errors/ZaloApiLoginQRAborted.js
var ZaloApiLoginQRAborted = class extends ZaloApiError {
	constructor(message = "Operation aborted") {
		super(message);
		this.name = "ZaloApiLoginQRAborted";
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/Errors/ZaloApiLoginQRDeclined.js
var ZaloApiLoginQRDeclined = class extends ZaloApiError {
	constructor(message = "Login QR request declined") {
		super(message);
		this.name = "ZaloApiLoginQRDeclined";
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/AutoReply.js
var AutoReplyScope;
(function(AutoReplyScope) {
	AutoReplyScope[AutoReplyScope["Everyone"] = 0] = "Everyone";
	AutoReplyScope[AutoReplyScope["Stranger"] = 1] = "Stranger";
	AutoReplyScope[AutoReplyScope["SpecificFriends"] = 2] = "SpecificFriends";
	AutoReplyScope[AutoReplyScope["FriendsExcept"] = 3] = "FriendsExcept";
})(AutoReplyScope || (AutoReplyScope = {}));
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/Board.js
var BoardType;
(function(BoardType) {
	BoardType[BoardType["Note"] = 1] = "Note";
	BoardType[BoardType["PinnedMessage"] = 2] = "PinnedMessage";
	BoardType[BoardType["Poll"] = 3] = "Poll";
})(BoardType || (BoardType = {}));
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/Enum.js
var ThreadType$1;
(function(ThreadType) {
	ThreadType[ThreadType["User"] = 0] = "User";
	ThreadType[ThreadType["Group"] = 1] = "Group";
})(ThreadType$1 || (ThreadType$1 = {}));
var DestType;
(function(DestType) {
	DestType[DestType["Group"] = 1] = "Group";
	DestType[DestType["User"] = 3] = "User";
	DestType[DestType["Page"] = 5] = "Page";
})(DestType || (DestType = {}));
var Gender;
(function(Gender) {
	Gender[Gender["Male"] = 0] = "Male";
	Gender[Gender["Female"] = 1] = "Female";
})(Gender || (Gender = {}));
var AvatarSize;
(function(AvatarSize) {
	AvatarSize[AvatarSize["Small"] = 120] = "Small";
	AvatarSize[AvatarSize["Large"] = 240] = "Large";
})(AvatarSize || (AvatarSize = {}));
/**
* @note Bank codes list after Mitm on Mobile and Bank's supported by Zalo
* @documents https://developers.zalo.me/docs/zalo-notification-service/phu-luc/danh-sach-bin-code - docs missing bin code and short_name bank
*/
var BinBankCard;
(function(BinBankCard) {
	/**
	* NH TMCP An Bình
	*/
	BinBankCard[BinBankCard["ABBank"] = 970425] = "ABBank";
	/**
	* NH TMCP Á Châu
	*/
	BinBankCard[BinBankCard["ACB"] = 970416] = "ACB";
	/**
	* NH Nông nghiệp và Phát triển Nông thôn Việt Nam
	*/
	BinBankCard[BinBankCard["Agribank"] = 970405] = "Agribank";
	/**
	* NH TMCP Đầu tư và Phát triển Việt Nam
	*/
	BinBankCard[BinBankCard["BIDV"] = 970418] = "BIDV";
	/**
	* NH TMCP Bản Việt
	*/
	BinBankCard[BinBankCard["BVBank"] = 970454] = "BVBank";
	/**
	* NH TMCP Bắc Á
	*/
	BinBankCard[BinBankCard["BacA_Bank"] = 970409] = "BacA_Bank";
	/**
	* NH TMCP Bảo Việt
	*/
	BinBankCard[BinBankCard["BaoViet_Bank"] = 970438] = "BaoViet_Bank";
	/**
	* NH số CAKE by VPBank - TMCP Việt Nam Thịnh Vượng
	*/
	BinBankCard[BinBankCard["CAKE"] = 546034] = "CAKE";
	/**
	* NH Thương mại TNHH MTV Xây dựng Việt Nam
	*/
	BinBankCard[BinBankCard["CB_Bank"] = 970444] = "CB_Bank";
	/**
	* NH TNHH MTV CIMB Việt Nam
	*/
	BinBankCard[BinBankCard["CIMB_Bank"] = 422589] = "CIMB_Bank";
	/**
	* NH Hợp tác xã Việt Nam
	*/
	BinBankCard[BinBankCard["Coop_Bank"] = 970446] = "Coop_Bank";
	/**
	* NH TNHH MTV Phát triển Singapore - CN TP. Hồ Chí Minh
	*/
	BinBankCard[BinBankCard["DBS_Bank"] = 796500] = "DBS_Bank";
	/**
	* NH TMCP Đông Á
	*/
	BinBankCard[BinBankCard["DongA_Bank"] = 970406] = "DongA_Bank";
	/**
	* NH TMCP Xuất Nhập khẩu Việt Nam
	*/
	BinBankCard[BinBankCard["Eximbank"] = 970431] = "Eximbank";
	/**
	* NH TMCP Dầu khí Toàn cầu
	*/
	BinBankCard[BinBankCard["GPBank"] = 970408] = "GPBank";
	/**
	* NH TMCP Phát triển TP. Hồ Chí Minh
	*/
	BinBankCard[BinBankCard["HDBank"] = 970437] = "HDBank";
	/**
	* NH TNHH MTV HSBC (Việt Nam)
	*/
	BinBankCard[BinBankCard["HSBC"] = 458761] = "HSBC";
	/**
	* NH TNHH MTV Hong Leong Việt Nam
	*/
	BinBankCard[BinBankCard["HongLeong_Bank"] = 970442] = "HongLeong_Bank";
	/**
	* NH Công nghiệp Hàn Quốc - CN TP. Hồ Chí Minh
	*/
	BinBankCard[BinBankCard["IBK_HCM"] = 970456] = "IBK_HCM";
	/**
	* NH Công nghiệp Hàn Quốc - CN Hà Nội
	*/
	BinBankCard[BinBankCard["IBK_HN"] = 970455] = "IBK_HN";
	/**
	* NH TNHH Indovina
	*/
	BinBankCard[BinBankCard["Indovina_Bank"] = 970434] = "Indovina_Bank";
	/**
	* NH Đại chúng TNHH Kasikornbank - CN TP. Hồ Chí Minh
	*/
	BinBankCard[BinBankCard["KBank"] = 668888] = "KBank";
	/**
	* NH TMCP Kiên Long
	*/
	BinBankCard[BinBankCard["KienlongBank"] = 970452] = "KienlongBank";
	/**
	* NH Kookmin - CN TP. Hồ Chí Minh
	*/
	BinBankCard[BinBankCard["Kookmin_Bank_HCM"] = 970463] = "Kookmin_Bank_HCM";
	/**
	* NH Kookmin - CN Hà Nội
	*/
	BinBankCard[BinBankCard["Kookmin_Bank_HN"] = 970462] = "Kookmin_Bank_HN";
	/**
	* NH TMCP Lộc Phát Việt Nam
	*/
	BinBankCard[BinBankCard["LPBank"] = 970449] = "LPBank";
	/**
	* NH TMCP Quân đội
	*/
	BinBankCard[BinBankCard["MB_Bank"] = 970422] = "MB_Bank";
	/**
	* NH TMCP Hàng Hải
	*/
	BinBankCard[BinBankCard["MSB"] = 970426] = "MSB";
	/**
	* NH TMCP Quốc Dân
	*/
	BinBankCard[BinBankCard["NCB"] = 970419] = "NCB";
	/**
	* NH TMCP Nam Á
	*/
	BinBankCard[BinBankCard["Nam_A_Bank"] = 970428] = "Nam_A_Bank";
	/**
	* NH Nonghyup - CN Hà Nội
	*/
	BinBankCard[BinBankCard["NongHyup_Bank"] = 801011] = "NongHyup_Bank";
	/**
	* NH TMCP Phương Đông
	*/
	BinBankCard[BinBankCard["OCB"] = 970448] = "OCB";
	/**
	* NH Thương mại TNHH MTV Đại Dương
	*/
	BinBankCard[BinBankCard["Ocean_Bank"] = 970414] = "Ocean_Bank";
	/**
	* NH TMCP Thịnh vượng và Phát triển
	*/
	BinBankCard[BinBankCard["PGBank"] = 970430] = "PGBank";
	/**
	* NH TMCP Đại Chúng Việt Nam
	*/
	BinBankCard[BinBankCard["PVcomBank"] = 970412] = "PVcomBank";
	/**
	* NH TNHH MTV Public Việt Nam
	*/
	BinBankCard[BinBankCard["Public_Bank_Vietnam"] = 970439] = "Public_Bank_Vietnam";
	/**
	* NH TMCP Sài Gòn
	*/
	BinBankCard[BinBankCard["SCB"] = 970429] = "SCB";
	/**
	* NH TMCP Sài Gòn - Hà Nội
	*/
	BinBankCard[BinBankCard["SHB"] = 970443] = "SHB";
	/**
	* NH TMCP Sài Gòn Thương Tín
	*/
	BinBankCard[BinBankCard["Sacombank"] = 970403] = "Sacombank";
	/**
	* NH TMCP Sài Gòn Công Thương
	*/
	BinBankCard[BinBankCard["Saigon_Bank"] = 970400] = "Saigon_Bank";
	/**
	* NH TMCP Đông Nam Á
	*/
	BinBankCard[BinBankCard["SeABank"] = 970440] = "SeABank";
	/**
	* NH TNHH MTV Shinhan Việt Nam
	*/
	BinBankCard[BinBankCard["Shinhan_Bank"] = 970424] = "Shinhan_Bank";
	/**
	* NH TNHH MTV Standard Chartered Bank Việt Nam
	*/
	BinBankCard[BinBankCard["Standard_Chartered_Vietnam"] = 970410] = "Standard_Chartered_Vietnam";
	/**
	* NH số TNEX
	*/
	BinBankCard[BinBankCard["TNEX"] = 9704261] = "TNEX";
	/**
	* NH TMCP Tiên Phong
	*/
	BinBankCard[BinBankCard["TPBank"] = 970423] = "TPBank";
	/**
	* NH TMCP Kỹ thương Việt Nam
	*/
	BinBankCard[BinBankCard["Techcombank"] = 970407] = "Techcombank";
	/**
	* NH số Timo by Bản Việt Bank
	*/
	BinBankCard[BinBankCard["Timo"] = 963388] = "Timo";
	/**
	* NH số UBank by VPBank
	*/
	BinBankCard[BinBankCard["UBank"] = 546035] = "UBank";
	/**
	* NH United Overseas Bank Việt Nam
	*/
	BinBankCard[BinBankCard["United_Overseas_Bank_Vietnam"] = 970458] = "United_Overseas_Bank_Vietnam";
	/**
	* NH TMCP Quốc tế Việt Nam
	*/
	BinBankCard[BinBankCard["VIB"] = 970441] = "VIB";
	/**
	* NH TMCP Việt Nam Thịnh Vượng
	*/
	BinBankCard[BinBankCard["VPBank"] = 970432] = "VPBank";
	/**
	* NH Liên doanh Việt - Nga
	*/
	BinBankCard[BinBankCard["VRB"] = 970421] = "VRB";
	/**
	* NH TMCP Việt Á
	*/
	BinBankCard[BinBankCard["VietABank"] = 970427] = "VietABank";
	/**
	* NH TMCP Việt Nam Thương Tín
	*/
	BinBankCard[BinBankCard["VietBank"] = 970433] = "VietBank";
	/**
	* NH TMCP Ngoại Thương Việt Nam
	*/
	BinBankCard[BinBankCard["Vietcombank"] = 970436] = "Vietcombank";
	/**
	* NH TMCP Công thương Việt Nam
	*/
	BinBankCard[BinBankCard["VietinBank"] = 970415] = "VietinBank";
	/**
	* NH TNHH MTV Woori Việt Nam
	*/
	BinBankCard[BinBankCard["Woori_Bank"] = 970457] = "Woori_Bank";
})(BinBankCard || (BinBankCard = {}));
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/DeliveredMessage.js
var UserDeliveredMessage = class {
	constructor(data) {
		this.type = ThreadType$1.User;
		this.data = data;
		this.threadId = data.deliveredUids[0];
		this.isSelf = false;
	}
};
var GroupDeliveredMessage = class {
	constructor(uid, data) {
		this.type = ThreadType$1.Group;
		this.data = data;
		this.threadId = data.groupId;
		this.isSelf = data.deliveredUids.includes(uid);
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/FriendEvent.js
var FriendEventType;
(function(FriendEventType) {
	FriendEventType[FriendEventType["ADD"] = 0] = "ADD";
	FriendEventType[FriendEventType["REMOVE"] = 1] = "REMOVE";
	FriendEventType[FriendEventType["REQUEST"] = 2] = "REQUEST";
	FriendEventType[FriendEventType["UNDO_REQUEST"] = 3] = "UNDO_REQUEST";
	FriendEventType[FriendEventType["REJECT_REQUEST"] = 4] = "REJECT_REQUEST";
	FriendEventType[FriendEventType["SEEN_FRIEND_REQUEST"] = 5] = "SEEN_FRIEND_REQUEST";
	FriendEventType[FriendEventType["BLOCK"] = 6] = "BLOCK";
	FriendEventType[FriendEventType["UNBLOCK"] = 7] = "UNBLOCK";
	FriendEventType[FriendEventType["BLOCK_CALL"] = 8] = "BLOCK_CALL";
	FriendEventType[FriendEventType["UNBLOCK_CALL"] = 9] = "UNBLOCK_CALL";
	FriendEventType[FriendEventType["PIN_UNPIN"] = 10] = "PIN_UNPIN";
	FriendEventType[FriendEventType["PIN_CREATE"] = 11] = "PIN_CREATE";
	FriendEventType[FriendEventType["UNKNOWN"] = 12] = "UNKNOWN";
})(FriendEventType || (FriendEventType = {}));
function initializeFriendEvent(uid, data, type) {
	if (type == FriendEventType.ADD || type == FriendEventType.REMOVE || type == FriendEventType.BLOCK || type == FriendEventType.UNBLOCK || type == FriendEventType.BLOCK_CALL || type == FriendEventType.UNBLOCK_CALL) {return {
		type,
		data,
		threadId: data,
		isSelf: ![FriendEventType.ADD, FriendEventType.REMOVE].includes(type)
	};}
	else if (type == FriendEventType.REJECT_REQUEST || type == FriendEventType.UNDO_REQUEST) {return {
		type,
		data,
		threadId: data.toUid,
		isSelf: data.fromUid == uid
	};}
	else if (type == FriendEventType.REQUEST) {return {
		type,
		data,
		threadId: data.toUid,
		isSelf: data.fromUid == uid
	};}
	else if (type == FriendEventType.SEEN_FRIEND_REQUEST) {return {
		type,
		data,
		threadId: uid,
		isSelf: true
	};}
	else if (type == FriendEventType.PIN_CREATE) {return {
		type,
		data,
		threadId: data.conversationId,
		isSelf: data.actorId == uid
	};}
	else if (type == FriendEventType.PIN_UNPIN) {return {
		type,
		data,
		threadId: data.conversationId,
		isSelf: data.actorId == uid
	};}
	else {return {
		type: FriendEventType.UNKNOWN,
		data: JSON.stringify(data),
		threadId: "",
		isSelf: false
	};}
}
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/Group.js
var GroupTopicType;
(function(GroupTopicType) {
	GroupTopicType[GroupTopicType["Note"] = 0] = "Note";
	GroupTopicType[GroupTopicType["Message"] = 2] = "Message";
	GroupTopicType[GroupTopicType["Poll"] = 3] = "Poll";
})(GroupTopicType || (GroupTopicType = {}));
var GroupType;
(function(GroupType) {
	GroupType[GroupType["Group"] = 1] = "Group";
	GroupType[GroupType["Community"] = 2] = "Community";
})(GroupType || (GroupType = {}));
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/GroupEvent.js
var GroupEventType;
(function(GroupEventType) {
	GroupEventType["JOIN_REQUEST"] = "join_request";
	GroupEventType["JOIN"] = "join";
	GroupEventType["LEAVE"] = "leave";
	GroupEventType["REMOVE_MEMBER"] = "remove_member";
	GroupEventType["BLOCK_MEMBER"] = "block_member";
	GroupEventType["UPDATE_SETTING"] = "update_setting";
	GroupEventType["UPDATE"] = "update";
	GroupEventType["NEW_LINK"] = "new_link";
	GroupEventType["ADD_ADMIN"] = "add_admin";
	GroupEventType["REMOVE_ADMIN"] = "remove_admin";
	GroupEventType["NEW_PIN_TOPIC"] = "new_pin_topic";
	GroupEventType["UPDATE_PIN_TOPIC"] = "update_pin_topic";
	GroupEventType["REORDER_PIN_TOPIC"] = "reorder_pin_topic";
	GroupEventType["UPDATE_BOARD"] = "update_board";
	GroupEventType["REMOVE_BOARD"] = "remove_board";
	GroupEventType["UPDATE_TOPIC"] = "update_topic";
	GroupEventType["UNPIN_TOPIC"] = "unpin_topic";
	GroupEventType["REMOVE_TOPIC"] = "remove_topic";
	GroupEventType["ACCEPT_REMIND"] = "accept_remind";
	GroupEventType["REJECT_REMIND"] = "reject_remind";
	GroupEventType["REMIND_TOPIC"] = "remind_topic";
	GroupEventType["UPDATE_AVATAR"] = "update_avatar";
	GroupEventType["UNKNOWN"] = "unknown";
})(GroupEventType || (GroupEventType = {}));
function initializeGroupEvent(uid, data, type, act) {
	var _a;
	const threadId = "group_id" in data ? data.group_id : data.groupId;
	if (type == GroupEventType.JOIN_REQUEST) {return {
		type,
		act,
		data,
		threadId,
		isSelf: false
	};}
	else if (type == GroupEventType.NEW_PIN_TOPIC || type == GroupEventType.UNPIN_TOPIC || type == GroupEventType.UPDATE_PIN_TOPIC) {return {
		type,
		act,
		data,
		threadId,
		isSelf: data.actorId == uid
	};}
	else if (type == GroupEventType.REORDER_PIN_TOPIC) {return {
		type,
		act,
		data,
		threadId,
		isSelf: data.actorId == uid
	};}
	else if (type == GroupEventType.UPDATE_BOARD || type == GroupEventType.REMOVE_BOARD) {return {
		type,
		act,
		data,
		threadId,
		isSelf: data.sourceId == uid
	};}
	else if (type == GroupEventType.ACCEPT_REMIND || type == GroupEventType.REJECT_REMIND) {return {
		type,
		act,
		data,
		threadId,
		isSelf: data.updateMembers.some((memberId) => memberId == uid)
	};}
	else if (type == GroupEventType.REMIND_TOPIC) {return {
		type,
		act,
		data,
		threadId,
		isSelf: data.creatorId == uid
	};}
	else {
		const baseData = data;
		return {
			type,
			act,
			data: baseData,
			threadId,
			isSelf: ((_a = baseData.updateMembers) === null || _a === void 0 ? void 0 : _a.some((member) => member.id == uid)) || baseData.sourceId == uid
		};
	}
}
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/Message.js
var UserMessage = class {
	constructor(uid, data) {
		this.type = ThreadType$1.User;
		this.data = data;
		this.threadId = data.uidFrom == "0" ? data.idTo : data.uidFrom;
		this.isSelf = data.uidFrom == "0";
		if (data.idTo == "0") {data.idTo = uid;}
		if (data.uidFrom == "0") {data.uidFrom = uid;}
		if (data.quote) {data.quote.ownerId = String(data.quote.ownerId);}
	}
};
var GroupMessage = class {
	constructor(uid, data) {
		this.type = ThreadType$1.Group;
		this.data = data;
		this.threadId = data.idTo;
		this.isSelf = data.uidFrom == "0";
		if (data.uidFrom == "0") {data.uidFrom = uid;}
		if (data.quote) {data.quote.ownerId = String(data.quote.ownerId);}
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/Reaction.js
var Reactions$1;
(function(Reactions) {
	Reactions["HEART"] = "/-heart";
	Reactions["LIKE"] = "/-strong";
	Reactions["HAHA"] = ":>";
	Reactions["WOW"] = ":o";
	Reactions["CRY"] = ":-((";
	Reactions["ANGRY"] = ":-h";
	Reactions["KISS"] = ":-*";
	Reactions["TEARS_OF_JOY"] = ":')";
	Reactions["SHIT"] = "/-shit";
	Reactions["ROSE"] = "/-rose";
	Reactions["BROKEN_HEART"] = "/-break";
	Reactions["DISLIKE"] = "/-weak";
	Reactions["LOVE"] = ";xx";
	Reactions["CONFUSED"] = ";-/";
	Reactions["WINK"] = ";-)";
	Reactions["FADE"] = "/-fade";
	Reactions["SUN"] = "/-li";
	Reactions["BIRTHDAY"] = "/-bd";
	Reactions["BOMB"] = "/-bome";
	Reactions["OK"] = "/-ok";
	Reactions["PEACE"] = "/-v";
	Reactions["THANKS"] = "/-thanks";
	Reactions["PUNCH"] = "/-punch";
	Reactions["SHARE"] = "/-share";
	Reactions["PRAY"] = "_()_";
	Reactions["NO"] = "/-no";
	Reactions["BAD"] = "/-bad";
	Reactions["LOVE_YOU"] = "/-loveu";
	Reactions["SAD"] = "--b";
	Reactions["VERY_SAD"] = ":((";
	Reactions["COOL"] = "x-)";
	Reactions["NERD"] = "8-)";
	Reactions["BIG_SMILE"] = ";-d";
	Reactions["SUNGLASSES"] = "b-)";
	Reactions["NEUTRAL"] = ":--|";
	Reactions["SAD_FACE"] = "p-(";
	Reactions["BYE"] = ":-bye";
	Reactions["SLEEPY"] = "|-)";
	Reactions["WIPE"] = ":wipe";
	Reactions["DIG"] = ":-dig";
	Reactions["ANGUISH"] = "&-(";
	Reactions["HANDCLAP"] = ":handclap";
	Reactions["ANGRY_FACE"] = ">-|";
	Reactions["F_CHAIR"] = ":-f";
	Reactions["L_CHAIR"] = ":-l";
	Reactions["R_CHAIR"] = ":-r";
	Reactions["SILENT"] = ";-x";
	Reactions["SURPRISE"] = ":-o";
	Reactions["EMBARRASSED"] = ";-s";
	Reactions["AFRAID"] = ";-a";
	Reactions["SAD2"] = ":-<";
	Reactions["BIG_LAUGH"] = ":))";
	Reactions["RICH"] = "$-)";
	Reactions["BEER"] = "/-beer";
	Reactions["NONE"] = "";
})(Reactions$1 || (Reactions$1 = {}));
var Reaction = class {
	constructor(uid, data, isGroup) {
		this.data = data;
		this.threadId = isGroup || data.uidFrom == "0" ? data.idTo : data.uidFrom;
		this.isSelf = data.uidFrom == "0";
		this.isGroup = isGroup;
		if (data.idTo == "0") {data.idTo = uid;}
		if (data.uidFrom == "0") {data.uidFrom = uid;}
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/Reminder.js
var ReminderRepeatMode;
(function(ReminderRepeatMode) {
	ReminderRepeatMode[ReminderRepeatMode["None"] = 0] = "None";
	ReminderRepeatMode[ReminderRepeatMode["Daily"] = 1] = "Daily";
	ReminderRepeatMode[ReminderRepeatMode["Weekly"] = 2] = "Weekly";
	ReminderRepeatMode[ReminderRepeatMode["Monthly"] = 3] = "Monthly";
})(ReminderRepeatMode || (ReminderRepeatMode = {}));
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/SeenMessage.js
var UserSeenMessage = class {
	constructor(data) {
		this.type = ThreadType$1.User;
		this.data = data;
		this.threadId = data.idTo;
		this.isSelf = false;
	}
};
var GroupSeenMessage = class {
	constructor(uid, data) {
		this.type = ThreadType$1.Group;
		this.data = data;
		this.threadId = data.groupId;
		this.isSelf = data.seenUids.includes(uid);
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/Typing.js
var UserTyping = class {
	constructor(data) {
		this.type = ThreadType$1.User;
		this.data = data;
		this.threadId = data.uid;
		this.isSelf = false;
	}
};
var GroupTyping = class {
	constructor(data) {
		this.type = ThreadType$1.Group;
		this.data = data;
		this.threadId = data.gid;
		this.isSelf = false;
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/Undo.js
var Undo = class {
	constructor(uid, data, isGroup) {
		this.data = data;
		this.threadId = isGroup || data.uidFrom == "0" ? data.idTo : data.uidFrom;
		this.isSelf = data.uidFrom == "0";
		this.isGroup = isGroup;
		if (data.idTo == "0") {data.idTo = uid;}
		if (data.uidFrom == "0") {data.uidFrom = uid;}
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/models/ZBusiness.js
var BusinessCategory;
(function(BusinessCategory) {
	BusinessCategory[BusinessCategory["Other"] = 0] = "Other";
	BusinessCategory[BusinessCategory["RealEstate"] = 1] = "RealEstate";
	BusinessCategory[BusinessCategory["TechnologyAndDevices"] = 2] = "TechnologyAndDevices";
	BusinessCategory[BusinessCategory["TravelAndHospitality"] = 3] = "TravelAndHospitality";
	BusinessCategory[BusinessCategory["EducationAndTraining"] = 4] = "EducationAndTraining";
	BusinessCategory[BusinessCategory["ShoppingAndRetail"] = 5] = "ShoppingAndRetail";
	BusinessCategory[BusinessCategory["CosmeticsAndBeauty"] = 6] = "CosmeticsAndBeauty";
	BusinessCategory[BusinessCategory["RestaurantAndCafe"] = 7] = "RestaurantAndCafe";
	BusinessCategory[BusinessCategory["AutoAndMotorbike"] = 8] = "AutoAndMotorbike";
	BusinessCategory[BusinessCategory["FashionAndApparel"] = 9] = "FashionAndApparel";
	BusinessCategory[BusinessCategory["FoodAndBeverage"] = 10] = "FoodAndBeverage";
	BusinessCategory[BusinessCategory["MediaAndEntertainment"] = 11] = "MediaAndEntertainment";
	BusinessCategory[BusinessCategory["InternalCommunications"] = 12] = "InternalCommunications";
	BusinessCategory[BusinessCategory["Transportation"] = 13] = "Transportation";
	BusinessCategory[BusinessCategory["Telecommunications"] = 14] = "Telecommunications";
})(BusinessCategory || (BusinessCategory = {}));
const BusinessCategoryName = {
	[BusinessCategory.Other]: "Dịch vụ khác (Không hiển thị)",
	[BusinessCategory.RealEstate]: "Bất động sản",
	[BusinessCategory.TechnologyAndDevices]: "Công nghệ & Thiết bị",
	[BusinessCategory.TravelAndHospitality]: "Du lịch & Lưu trú",
	[BusinessCategory.EducationAndTraining]: "Giáo dục & Đào tạo",
	[BusinessCategory.ShoppingAndRetail]: "Mua sắm & Bán lẻ",
	[BusinessCategory.CosmeticsAndBeauty]: "Mỹ phẩm & Làm đẹp",
	[BusinessCategory.RestaurantAndCafe]: "Nhà hàng & Quán",
	[BusinessCategory.AutoAndMotorbike]: "Ô tô & Xe máy",
	[BusinessCategory.FashionAndApparel]: "Thời trang & May mặc",
	[BusinessCategory.FoodAndBeverage]: "Thực phẩm & Đồ uống",
	[BusinessCategory.MediaAndEntertainment]: "Truyền thông & Giải trí",
	[BusinessCategory.InternalCommunications]: "Truyền thông nội bộ",
	[BusinessCategory.Transportation]: "Vận tải",
	[BusinessCategory.Telecommunications]: "Viễn thông"
};
//#endregion
//#region node_modules/.pnpm/punycode@2.3.1/node_modules/punycode/punycode.js
var require_punycode = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/** Highest positive signed 32-bit float value */
	const maxInt = 2147483647;
	/** Bootstring parameters */
	const base = 36;
	const tMin = 1;
	const tMax = 26;
	const skew = 38;
	const damp = 700;
	const initialBias = 72;
	const initialN = 128;
	const delimiter = "-";
	/** Regular expressions */
	const regexPunycode = /^xn--/;
	const regexNonASCII = /[^\0-\x7F]/;
	const regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g;
	/** Error messages */
	const errors = {
		"overflow": "Overflow: input needs wider integers to process",
		"not-basic": "Illegal input >= 0x80 (not a basic code point)",
		"invalid-input": "Invalid input"
	};
	/** Convenience shortcuts */
	const baseMinusTMin = base - tMin;
	const floor = Math.floor;
	const stringFromCharCode = String.fromCharCode;
	/**
	* A generic error utility function.
	* @private
	* @param {String} type The error type.
	* @returns {Error} Throws a `RangeError` with the applicable error message.
	*/
	function error(type) {
		throw new RangeError(errors[type]);
	}
	/**
	* A generic `Array#map` utility function.
	* @private
	* @param {Array} array The array to iterate over.
	* @param {Function} callback The function that gets called for every array
	* item.
	* @returns {Array} A new array of values returned by the callback function.
	*/
	function map(array, callback) {
		const result = [];
		let length = array.length;
		while (length--) {result[length] = callback(array[length]);}
		return result;
	}
	/**
	* A simple `Array#map`-like wrapper to work with domain name strings or email
	* addresses.
	* @private
	* @param {String} domain The domain name or email address.
	* @param {Function} callback The function that gets called for every
	* character.
	* @returns {String} A new string of characters returned by the callback
	* function.
	*/
	function mapDomain(domain, callback) {
		const parts = domain.split("@");
		let result = "";
		if (parts.length > 1) {
			result = parts[0] + "@";
			domain = parts[1];
		}
		domain = domain.replace(regexSeparators, ".");
		const encoded = map(domain.split("."), callback).join(".");
		return result + encoded;
	}
	/**
	* Creates an array containing the numeric code points of each Unicode
	* character in the string. While JavaScript uses UCS-2 internally,
	* this function will convert a pair of surrogate halves (each of which
	* UCS-2 exposes as separate characters) into a single code point,
	* matching UTF-16.
	* @see `punycode.ucs2.encode`
	* @see <https://mathiasbynens.be/notes/javascript-encoding>
	* @memberOf punycode.ucs2
	* @name decode
	* @param {String} string The Unicode input string (UCS-2).
	* @returns {Array} The new array of code points.
	*/
	function ucs2decode(string) {
		const output = [];
		let counter = 0;
		const length = string.length;
		while (counter < length) {
			const value = string.charCodeAt(counter++);
			if (value >= 55296 && value <= 56319 && counter < length) {
				const extra = string.charCodeAt(counter++);
				if ((extra & 64512) == 56320) {output.push(((value & 1023) << 10) + (extra & 1023) + 65536);}
				else {
					output.push(value);
					counter--;
				}
			} else {output.push(value);}
		}
		return output;
	}
	/**
	* Creates a string based on an array of numeric code points.
	* @see `punycode.ucs2.decode`
	* @memberOf punycode.ucs2
	* @name encode
	* @param {Array} codePoints The array of numeric code points.
	* @returns {String} The new Unicode string (UCS-2).
	*/
	const ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);
	/**
	* Converts a basic code point into a digit/integer.
	* @see `digitToBasic()`
	* @private
	* @param {Number} codePoint The basic numeric code point value.
	* @returns {Number} The numeric value of a basic code point (for use in
	* representing integers) in the range `0` to `base - 1`, or `base` if
	* the code point does not represent a value.
	*/
	const basicToDigit = function(codePoint) {
		if (codePoint >= 48 && codePoint < 58) {return 26 + (codePoint - 48);}
		if (codePoint >= 65 && codePoint < 91) {return codePoint - 65;}
		if (codePoint >= 97 && codePoint < 123) {return codePoint - 97;}
		return base;
	};
	/**
	* Converts a digit/integer into a basic code point.
	* @see `basicToDigit()`
	* @private
	* @param {Number} digit The numeric value of a basic code point.
	* @returns {Number} The basic code point whose value (when used for
	* representing integers) is `digit`, which needs to be in the range
	* `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	* used; else, the lowercase form is used. The behavior is undefined
	* if `flag` is non-zero and `digit` has no uppercase form.
	*/
	const digitToBasic = function(digit, flag) {
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	};
	/**
	* Bias adaptation function as per section 3.4 of RFC 3492.
	* https://tools.ietf.org/html/rfc3492#section-3.4
	* @private
	*/
	const adapt = function(delta, numPoints, firstTime) {
		let k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (; delta > baseMinusTMin * tMax >> 1; k += base) {delta = floor(delta / baseMinusTMin);}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	};
	/**
	* Converts a Punycode string of ASCII-only symbols to a string of Unicode
	* symbols.
	* @memberOf punycode
	* @param {String} input The Punycode string of ASCII-only symbols.
	* @returns {String} The resulting string of Unicode symbols.
	*/
	const decode = function(input) {
		const output = [];
		const inputLength = input.length;
		let i = 0;
		let n = initialN;
		let bias = initialBias;
		let basic = input.lastIndexOf(delimiter);
		if (basic < 0) {basic = 0;}
		for (let j = 0; j < basic; ++j) {
			if (input.charCodeAt(j) >= 128) {error("not-basic");}
			output.push(input.charCodeAt(j));
		}
		for (let index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
			const oldi = i;
			for (let w = 1, k = base;; k += base) {
				if (index >= inputLength) {error("invalid-input");}
				const digit = basicToDigit(input.charCodeAt(index++));
				if (digit >= base) {error("invalid-input");}
				if (digit > floor((maxInt - i) / w)) {error("overflow");}
				i += digit * w;
				const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
				if (digit < t) {break;}
				const baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {error("overflow");}
				w *= baseMinusT;
			}
			const out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);
			if (floor(i / out) > maxInt - n) {error("overflow");}
			n += floor(i / out);
			i %= out;
			output.splice(i++, 0, n);
		}
		return String.fromCodePoint(...output);
	};
	/**
	* Converts a string of Unicode symbols (e.g. a domain name label) to a
	* Punycode string of ASCII-only symbols.
	* @memberOf punycode
	* @param {String} input The string of Unicode symbols.
	* @returns {String} The resulting Punycode string of ASCII-only symbols.
	*/
	const encode = function(input) {
		const output = [];
		input = ucs2decode(input);
		const inputLength = input.length;
		let n = initialN;
		let delta = 0;
		let bias = initialBias;
		for (const currentValue of input) {if (currentValue < 128) output.push(stringFromCharCode(currentValue));}
		const basicLength = output.length;
		let handledCPCount = basicLength;
		if (basicLength) {output.push(delimiter);}
		while (handledCPCount < inputLength) {
			let m = maxInt;
			for (const currentValue of input) {if (currentValue >= n && currentValue < m) m = currentValue;}
			const handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {error("overflow");}
			delta += (m - n) * handledCPCountPlusOne;
			n = m;
			for (const currentValue of input) {
				if (currentValue < n && ++delta > maxInt) {error("overflow");}
				if (currentValue === n) {
					let q = delta;
					for (let k = base;; k += base) {
						const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
						if (q < t) {break;}
						const qMinusT = q - t;
						const baseMinusT = base - t;
						output.push(stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0)));
						q = floor(qMinusT / baseMinusT);
					}
					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
					delta = 0;
					++handledCPCount;
				}
			}
			++delta;
			++n;
		}
		return output.join("");
	};
	/**
	* Converts a Punycode string representing a domain name or an email address
	* to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	* it doesn't matter if you call it on a string that has already been
	* converted to Unicode.
	* @memberOf punycode
	* @param {String} input The Punycoded domain name or email address to
	* convert to Unicode.
	* @returns {String} The Unicode representation of the given Punycode
	* string.
	*/
	const toUnicode = function(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
		});
	};
	/**
	* Converts a Unicode string representing a domain name or an email address to
	* Punycode. Only the non-ASCII parts of the domain name will be converted,
	* i.e. it doesn't matter if you call it with a domain that's already in
	* ASCII.
	* @memberOf punycode
	* @param {String} input The domain name or email address to convert, as a
	* Unicode string.
	* @returns {String} The Punycode representation of the given domain name or
	* email address.
	*/
	const toASCII = function(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string) ? "xn--" + encode(string) : string;
		});
	};
	module.exports = {
		"version": "2.3.1",
		"ucs2": {
			"decode": ucs2decode,
			"encode": ucs2encode
		},
		"decode": decode,
		"encode": encode,
		"toASCII": toASCII,
		"toUnicode": toUnicode
	};
}));
//#endregion
//#region node_modules/.pnpm/requires-port@1.0.0/node_modules/requires-port/index.js
var require_requires_port = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* Check if we're required to add a port number.
	*
	* @see https://url.spec.whatwg.org/#default-port
	* @param {Number|String} port Port number we need to check
	* @param {String} protocol Protocol we need to check against.
	* @returns {Boolean} Is it a default port for the given protocol
	* @api private
	*/
	module.exports = function required(port, protocol) {
		protocol = protocol.split(":")[0];
		port = +port;
		if (!port) {return false;}
		switch (protocol) {
			case "http":
			case "ws": return port !== 80;
			case "https":
			case "wss": return port !== 443;
			case "ftp": return port !== 21;
			case "gopher": return port !== 70;
			case "file": return false;
		}
		return port !== 0;
	};
}));
//#endregion
//#region node_modules/.pnpm/querystringify@2.2.0/node_modules/querystringify/index.js
var require_querystringify = /* @__PURE__ */ __commonJSMin(((exports) => {
	var has = Object.prototype.hasOwnProperty, undef;
	/**
	* Decode a URI encoded string.
	*
	* @param {String} input The URI encoded string.
	* @returns {String|Null} The decoded string.
	* @api private
	*/
	function decode(input) {
		try {
			return decodeURIComponent(input.replace(/\+/g, " "));
		} catch (e) {
			return null;
		}
	}
	/**
	* Attempts to encode a given input.
	*
	* @param {String} input The string that needs to be encoded.
	* @returns {String|Null} The encoded string.
	* @api private
	*/
	function encode(input) {
		try {
			return encodeURIComponent(input);
		} catch (e) {
			return null;
		}
	}
	/**
	* Simple query string parser.
	*
	* @param {String} query The query string that needs to be parsed.
	* @returns {Object}
	* @api public
	*/
	function querystring(query) {
		var parser = /([^=?#&]+)=?([^&]*)/g, result = {}, part;
		while (part = parser.exec(query)) {
			var key = decode(part[1]), value = decode(part[2]);
			if (key === null || value === null || key in result) {continue;}
			result[key] = value;
		}
		return result;
	}
	/**
	* Transform a query string to an object.
	*
	* @param {Object} obj Object that should be transformed.
	* @param {String} prefix Optional prefix.
	* @returns {String}
	* @api public
	*/
	function querystringify(obj, prefix) {
		prefix = prefix || "";
		var pairs = [], value, key;
		if ("string" !== typeof prefix) {prefix = "?";}
		for (key in obj) {if (has.call(obj, key)) {
			value = obj[key];
			if (!value && (value === null || value === undef || isNaN(value))) value = "";
			key = encode(key);
			value = encode(value);
			if (key === null || value === null) continue;
			pairs.push(key + "=" + value);
		}}
		return pairs.length ? prefix + pairs.join("&") : "";
	}
	exports.stringify = querystringify;
	exports.parse = querystring;
}));
//#endregion
//#region node_modules/.pnpm/url-parse@1.5.10/node_modules/url-parse/index.js
var require_url_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var required = require_requires_port(), qs = require_querystringify(), controlOrWhitespace = /^[\x00-\x20\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/, CRHTLF = /[\n\r\t]/g, slashes = /^[A-Za-z][A-Za-z0-9+-.]*:\/\//, port = /:\d+$/, protocolre = /^([a-z][a-z0-9.+-]*:)?(\/\/)?([\\/]+)?([\S\s]*)/i, windowsDriveLetter = /^[a-zA-Z]:/;
	/**
	* Remove control characters and whitespace from the beginning of a string.
	*
	* @param {Object|String} str String to trim.
	* @returns {String} A new string representing `str` stripped of control
	*     characters and whitespace from its beginning.
	* @public
	*/
	function trimLeft(str) {
		return (str ? str : "").toString().replace(controlOrWhitespace, "");
	}
	/**
	* These are the parse rules for the URL parser, it informs the parser
	* about:
	*
	* 0. The char it Needs to parse, if it's a string it should be done using
	*    indexOf, RegExp using exec and NaN means set as current value.
	* 1. The property we should set when parsing this value.
	* 2. Indication if it's backwards or forward parsing, when set as number it's
	*    the value of extra chars that should be split off.
	* 3. Inherit from location if non existing in the parser.
	* 4. `toLowerCase` the resulting value.
	*/
	var rules = [
		["#", "hash"],
		["?", "query"],
		function sanitize(address, url) {
			return isSpecial(url.protocol) ? address.replace(/\\/g, "/") : address;
		},
		["/", "pathname"],
		[
			"@",
			"auth",
			1
		],
		[
			NaN,
			"host",
			void 0,
			1,
			1
		],
		[
			/:(\d*)$/,
			"port",
			void 0,
			1
		],
		[
			NaN,
			"hostname",
			void 0,
			1,
			1
		]
	];
	/**
	* These properties should not be copied or inherited from. This is only needed
	* for all non blob URL's as a blob URL does not include a hash, only the
	* origin.
	*
	* @type {Object}
	* @private
	*/
	var ignore = {
		hash: 1,
		query: 1
	};
	/**
	* The location object differs when your code is loaded through a normal page,
	* Worker or through a worker using a blob. And with the blobble begins the
	* trouble as the location object will contain the URL of the blob, not the
	* location of the page where our code is loaded in. The actual origin is
	* encoded in the `pathname` so we can thankfully generate a good "default"
	* location from it so we can generate proper relative URL's again.
	*
	* @param {Object|String} loc Optional default location object.
	* @returns {Object} lolcation object.
	* @public
	*/
	function lolcation(loc) {
		var globalVar;
		if (typeof window !== "undefined") {globalVar = window;}
		else if (typeof global !== "undefined") {globalVar = global;}
		else if (typeof self !== "undefined") {globalVar = self;}
		else {globalVar = {};}
		var location = globalVar.location || {};
		loc = loc || location;
		var finaldestination = {}, type = typeof loc, key;
		if ("blob:" === loc.protocol) {finaldestination = new Url(unescape(loc.pathname), {});}
		else if ("string" === type) {
			finaldestination = new Url(loc, {});
			for (key in ignore) {delete finaldestination[key];}
		} else if ("object" === type) {
			for (key in loc) {
				if (key in ignore) {continue;}
				finaldestination[key] = loc[key];
			}
			if (finaldestination.slashes === void 0) {finaldestination.slashes = slashes.test(loc.href);}
		}
		return finaldestination;
	}
	/**
	* Check whether a protocol scheme is special.
	*
	* @param {String} The protocol scheme of the URL
	* @return {Boolean} `true` if the protocol scheme is special, else `false`
	* @private
	*/
	function isSpecial(scheme) {
		return scheme === "file:" || scheme === "ftp:" || scheme === "http:" || scheme === "https:" || scheme === "ws:" || scheme === "wss:";
	}
	/**
	* @typedef ProtocolExtract
	* @type Object
	* @property {String} protocol Protocol matched in the URL, in lowercase.
	* @property {Boolean} slashes `true` if protocol is followed by "//", else `false`.
	* @property {String} rest Rest of the URL that is not part of the protocol.
	*/
	/**
	* Extract protocol information from a URL with/without double slash ("//").
	*
	* @param {String} address URL we want to extract from.
	* @param {Object} location
	* @return {ProtocolExtract} Extracted information.
	* @private
	*/
	function extractProtocol(address, location) {
		address = trimLeft(address);
		address = address.replace(CRHTLF, "");
		location = location || {};
		var match = protocolre.exec(address);
		var protocol = match[1] ? match[1].toLowerCase() : "";
		var forwardSlashes = !!match[2];
		var otherSlashes = !!match[3];
		var slashesCount = 0;
		var rest;
		if (forwardSlashes) {if (otherSlashes) {
			rest = match[2] + match[3] + match[4];
			slashesCount = match[2].length + match[3].length;
		} else {
			rest = match[2] + match[4];
			slashesCount = match[2].length;
		}}
		else if (otherSlashes) {
			rest = match[3] + match[4];
			slashesCount = match[3].length;
		} else {rest = match[4];}
		if (protocol === "file:") {
			if (slashesCount >= 2) {rest = rest.slice(2);}
		} else if (isSpecial(protocol)) {rest = match[4];}
		else if (protocol) {
			if (forwardSlashes) {rest = rest.slice(2);}
		} else if (slashesCount >= 2 && isSpecial(location.protocol)) {rest = match[4];}
		return {
			protocol,
			slashes: forwardSlashes || isSpecial(protocol),
			slashesCount,
			rest
		};
	}
	/**
	* Resolve a relative URL pathname against a base URL pathname.
	*
	* @param {String} relative Pathname of the relative URL.
	* @param {String} base Pathname of the base URL.
	* @return {String} Resolved pathname.
	* @private
	*/
	function resolve(relative, base) {
		if (relative === "") {return base;}
		var path = (base || "/").split("/").slice(0, -1).concat(relative.split("/")), i = path.length, last = path[i - 1], unshift = false, up = 0;
		while (i--) {if (path[i] === ".") path.splice(i, 1);
		else if (path[i] === "..") {
			path.splice(i, 1);
			up++;
		} else if (up) {
			if (i === 0) unshift = true;
			path.splice(i, 1);
			up--;
		}}
		if (unshift) {path.unshift("");}
		if (last === "." || last === "..") {path.push("");}
		return path.join("/");
	}
	/**
	* The actual URL instance. Instead of returning an object we've opted-in to
	* create an actual constructor as it's much more memory efficient and
	* faster and it pleases my OCD.
	*
	* It is worth noting that we should not use `URL` as class name to prevent
	* clashes with the global URL instance that got introduced in browsers.
	*
	* @constructor
	* @param {String} address URL we want to parse.
	* @param {Object|String} [location] Location defaults for relative paths.
	* @param {Boolean|Function} [parser] Parser for the query string.
	* @private
	*/
	function Url(address, location, parser) {
		address = trimLeft(address);
		address = address.replace(CRHTLF, "");
		if (!(this instanceof Url)) {return new Url(address, location, parser);}
		var relative, extracted, parse, instruction, index, key, instructions = rules.slice(), type = typeof location, url = this, i = 0;
		if ("object" !== type && "string" !== type) {
			parser = location;
			location = null;
		}
		if (parser && "function" !== typeof parser) {parser = qs.parse;}
		location = lolcation(location);
		extracted = extractProtocol(address || "", location);
		relative = !extracted.protocol && !extracted.slashes;
		url.slashes = extracted.slashes || relative && location.slashes;
		url.protocol = extracted.protocol || location.protocol || "";
		address = extracted.rest;
		if (extracted.protocol === "file:" && (extracted.slashesCount !== 2 || windowsDriveLetter.test(address)) || !extracted.slashes && (extracted.protocol || extracted.slashesCount < 2 || !isSpecial(url.protocol))) {instructions[3] = [/(.*)/, "pathname"];}
		for (; i < instructions.length; i++) {
			instruction = instructions[i];
			if (typeof instruction === "function") {
				address = instruction(address, url);
				continue;
			}
			parse = instruction[0];
			key = instruction[1];
			if (parse !== parse) {url[key] = address;}
			else if ("string" === typeof parse) {
				index = parse === "@" ? address.lastIndexOf(parse) : address.indexOf(parse);
				if (~index) {if ("number" === typeof instruction[2]) {
					url[key] = address.slice(0, index);
					address = address.slice(index + instruction[2]);
				} else {
					url[key] = address.slice(index);
					address = address.slice(0, index);
				}}
			} else if (index = parse.exec(address)) {
				url[key] = index[1];
				address = address.slice(0, index.index);
			}
			url[key] = url[key] || (relative && instruction[3] ? location[key] || "" : "");
			if (instruction[4]) {url[key] = url[key].toLowerCase();}
		}
		if (parser) {url.query = parser(url.query);}
		if (relative && location.slashes && url.pathname.charAt(0) !== "/" && (url.pathname !== "" || location.pathname !== "")) {url.pathname = resolve(url.pathname, location.pathname);}
		if (url.pathname.charAt(0) !== "/" && isSpecial(url.protocol)) {url.pathname = "/" + url.pathname;}
		if (!required(url.port, url.protocol)) {
			url.host = url.hostname;
			url.port = "";
		}
		url.username = url.password = "";
		if (url.auth) {
			index = url.auth.indexOf(":");
			if (~index) {
				url.username = url.auth.slice(0, index);
				url.username = encodeURIComponent(decodeURIComponent(url.username));
				url.password = url.auth.slice(index + 1);
				url.password = encodeURIComponent(decodeURIComponent(url.password));
			} else {url.username = encodeURIComponent(decodeURIComponent(url.auth));}
			url.auth = url.password ? url.username + ":" + url.password : url.username;
		}
		url.origin = url.protocol !== "file:" && isSpecial(url.protocol) && url.host ? url.protocol + "//" + url.host : "null";
		url.href = url.toString();
	}
	/**
	* This is convenience method for changing properties in the URL instance to
	* insure that they all propagate correctly.
	*
	* @param {String} part          Property we need to adjust.
	* @param {Mixed} value          The newly assigned value.
	* @param {Boolean|Function} fn  When setting the query, it will be the function
	*                               used to parse the query.
	*                               When setting the protocol, double slash will be
	*                               removed from the final url if it is true.
	* @returns {URL} URL instance for chaining.
	* @public
	*/
	function set(part, value, fn) {
		var url = this;
		switch (part) {
			case "query":
				if ("string" === typeof value && value.length) {value = (fn || qs.parse)(value);}
				url[part] = value;
				break;
			case "port":
				url[part] = value;
				if (!required(value, url.protocol)) {
					url.host = url.hostname;
					url[part] = "";
				} else if (value) {url.host = url.hostname + ":" + value;}
				break;
			case "hostname":
				url[part] = value;
				if (url.port) {value += ":" + url.port;}
				url.host = value;
				break;
			case "host":
				url[part] = value;
				if (port.test(value)) {
					value = value.split(":");
					url.port = value.pop();
					url.hostname = value.join(":");
				} else {
					url.hostname = value;
					url.port = "";
				}
				break;
			case "protocol":
				url.protocol = value.toLowerCase();
				url.slashes = !fn;
				break;
			case "pathname":
			case "hash":
				if (value) {
					var char = part === "pathname" ? "/" : "#";
					url[part] = value.charAt(0) !== char ? char + value : value;
				} else {url[part] = value;}
				break;
			case "username":
			case "password":
				url[part] = encodeURIComponent(value);
				break;
			case "auth":
				var index = value.indexOf(":");
				if (~index) {
					url.username = value.slice(0, index);
					url.username = encodeURIComponent(decodeURIComponent(url.username));
					url.password = value.slice(index + 1);
					url.password = encodeURIComponent(decodeURIComponent(url.password));
				} else {url.username = encodeURIComponent(decodeURIComponent(value));}
		}
		for (var i = 0; i < rules.length; i++) {
			var ins = rules[i];
			if (ins[4]) {url[ins[1]] = url[ins[1]].toLowerCase();}
		}
		url.auth = url.password ? url.username + ":" + url.password : url.username;
		url.origin = url.protocol !== "file:" && isSpecial(url.protocol) && url.host ? url.protocol + "//" + url.host : "null";
		url.href = url.toString();
		return url;
	}
	/**
	* Transform the properties back in to a valid and full URL string.
	*
	* @param {Function} stringify Optional query stringify function.
	* @returns {String} Compiled version of the URL.
	* @public
	*/
	function toString(stringify) {
		if (!stringify || "function" !== typeof stringify) {stringify = qs.stringify;}
		var query, url = this, host = url.host, protocol = url.protocol;
		if (protocol && protocol.charAt(protocol.length - 1) !== ":") {protocol += ":";}
		var result = protocol + (url.protocol && url.slashes || isSpecial(url.protocol) ? "//" : "");
		if (url.username) {
			result += url.username;
			if (url.password) {result += ":" + url.password;}
			result += "@";
		} else if (url.password) {
			result += ":" + url.password;
			result += "@";
		} else if (url.protocol !== "file:" && isSpecial(url.protocol) && !host && url.pathname !== "/") {result += "@";}
		if (host[host.length - 1] === ":" || port.test(url.hostname) && !url.port) {host += ":";}
		result += host + url.pathname;
		query = "object" === typeof url.query ? stringify(url.query) : url.query;
		if (query) {result += "?" !== query.charAt(0) ? "?" + query : query;}
		if (url.hash) {result += url.hash;}
		return result;
	}
	Url.prototype = {
		set,
		toString
	};
	Url.extractProtocol = extractProtocol;
	Url.location = lolcation;
	Url.trimLeft = trimLeft;
	Url.qs = qs;
	module.exports = Url;
}));
//#endregion
//#region node_modules/.pnpm/psl@1.15.0/node_modules/psl/dist/psl.cjs
var require_psl = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperties(exports, {
		__esModule: { value: !0 },
		[Symbol.toStringTag]: { value: "Module" }
	});
	function K(e) {
		return e && e.__esModule && Object.prototype.hasOwnProperty.call(e, "default") ? e.default : e;
	}
	var O, F;
	function Q() {
		if (F) {return O;}
		F = 1;
		const e = 2147483647, s = 36, c = 1, o = 26, t = 38, d = 700, z = 72, y = 128, g = "-", P = /^xn--/, V = /[^\0-\x7F]/, G = /[\x2E\u3002\uFF0E\uFF61]/g, W = {
			overflow: "Overflow: input needs wider integers to process",
			"not-basic": "Illegal input >= 0x80 (not a basic code point)",
			"invalid-input": "Invalid input"
		}, C = s - c, h = Math.floor, I = String.fromCharCode;
		function v(a) {
			throw new RangeError(W[a]);
		}
		function U(a, i) {
			const m = [];
			let n = a.length;
			for (; n--;) {m[n] = i(a[n]);}
			return m;
		}
		function S(a, i) {
			const m = a.split("@");
			let n = "";
			m.length > 1 && (n = m[0] + "@", a = m[1]), a = a.replace(G, ".");
			const p = U(a.split("."), i).join(".");
			return n + p;
		}
		function L(a) {
			const i = [];
			let m = 0;
			const n = a.length;
			for (; m < n;) {
				const r = a.charCodeAt(m++);
				if (r >= 55296 && r <= 56319 && m < n) {
					const p = a.charCodeAt(m++);
					(p & 64512) == 56320 ? i.push(((r & 1023) << 10) + (p & 1023) + 65536) : (i.push(r), m--);
				} else {i.push(r);}
			}
			return i;
		}
		const $ = (a) => String.fromCodePoint(...a), J = function(a) {
			return a >= 48 && a < 58 ? 26 + (a - 48) : a >= 65 && a < 91 ? a - 65 : a >= 97 && a < 123 ? a - 97 : s;
		}, D = function(a, i) {
			return a + 22 + 75 * (a < 26) - ((i != 0) << 5);
		}, T = function(a, i, m) {
			let n = 0;
			for (a = m ? h(a / d) : a >> 1, a += h(a / i); a > C * o >> 1; n += s) {a = h(a / C);}
			return h(n + (C + 1) * a / (a + t));
		}, E = function(a) {
			const i = [], m = a.length;
			let n = 0, r = y, p = z, j = a.lastIndexOf(g);
			j < 0 && (j = 0);
			for (let u = 0; u < j; ++u) {a.charCodeAt(u) >= 128 && v("not-basic"), i.push(a.charCodeAt(u));}
			for (let u = j > 0 ? j + 1 : 0; u < m;) {
				const k = n;
				for (let l = 1, b = s;; b += s) {
					u >= m && v("invalid-input");
					const w = J(a.charCodeAt(u++));
					w >= s && v("invalid-input"), w > h((e - n) / l) && v("overflow"), n += w * l;
					const x = b <= p ? c : b >= p + o ? o : b - p;
					if (w < x) {break;}
					const q = s - x;
					l > h(e / q) && v("overflow"), l *= q;
				}
				const f = i.length + 1;
				p = T(n - k, f, k == 0), h(n / f) > e - r && v("overflow"), r += h(n / f), n %= f, i.splice(n++, 0, r);
			}
			return String.fromCodePoint(...i);
		}, B = function(a) {
			const i = [];
			a = L(a);
			const m = a.length;
			let n = y, r = 0, p = z;
			for (const k of a) {k < 128 && i.push(I(k));}
			const j = i.length;
			let u = j;
			for (j && i.push(g); u < m;) {
				let k = e;
				for (const l of a) {l >= n && l < k && (k = l);}
				const f = u + 1;
				k - n > h((e - r) / f) && v("overflow"), r += (k - n) * f, n = k;
				for (const l of a) {if (l < n && ++r > e && v("overflow"), l === n) {
					let b = r;
					for (let w = s;; w += s) {
						const x = w <= p ? c : w >= p + o ? o : w - p;
						if (b < x) break;
						const q = b - x, M = s - x;
						i.push(I(D(x + q % M, 0))), b = h(q / M);
					}
					i.push(I(D(b, 0))), p = T(r, f, u === j), r = 0, ++u;
				}}
				++r, ++n;
			}
			return i.join("");
		};
		return O = {
			version: "2.3.1",
			ucs2: {
				decode: L,
				encode: $
			},
			decode: E,
			encode: B,
			toASCII: function(a) {
				return S(a, function(i) {
					return V.test(i) ? "xn--" + B(i) : i;
				});
			},
			toUnicode: function(a) {
				return S(a, function(i) {
					return P.test(i) ? E(i.slice(4).toLowerCase()) : i;
				});
			}
		}, O;
	}
	const A = K(Q()), Z = [
		"ac",
		"com.ac",
		"edu.ac",
		"gov.ac",
		"mil.ac",
		"net.ac",
		"org.ac",
		"ad",
		"ae",
		"ac.ae",
		"co.ae",
		"gov.ae",
		"mil.ae",
		"net.ae",
		"org.ae",
		"sch.ae",
		"aero",
		"airline.aero",
		"airport.aero",
		"accident-investigation.aero",
		"accident-prevention.aero",
		"aerobatic.aero",
		"aeroclub.aero",
		"aerodrome.aero",
		"agents.aero",
		"air-surveillance.aero",
		"air-traffic-control.aero",
		"aircraft.aero",
		"airtraffic.aero",
		"ambulance.aero",
		"association.aero",
		"author.aero",
		"ballooning.aero",
		"broker.aero",
		"caa.aero",
		"cargo.aero",
		"catering.aero",
		"certification.aero",
		"championship.aero",
		"charter.aero",
		"civilaviation.aero",
		"club.aero",
		"conference.aero",
		"consultant.aero",
		"consulting.aero",
		"control.aero",
		"council.aero",
		"crew.aero",
		"design.aero",
		"dgca.aero",
		"educator.aero",
		"emergency.aero",
		"engine.aero",
		"engineer.aero",
		"entertainment.aero",
		"equipment.aero",
		"exchange.aero",
		"express.aero",
		"federation.aero",
		"flight.aero",
		"freight.aero",
		"fuel.aero",
		"gliding.aero",
		"government.aero",
		"groundhandling.aero",
		"group.aero",
		"hanggliding.aero",
		"homebuilt.aero",
		"insurance.aero",
		"journal.aero",
		"journalist.aero",
		"leasing.aero",
		"logistics.aero",
		"magazine.aero",
		"maintenance.aero",
		"marketplace.aero",
		"media.aero",
		"microlight.aero",
		"modelling.aero",
		"navigation.aero",
		"parachuting.aero",
		"paragliding.aero",
		"passenger-association.aero",
		"pilot.aero",
		"press.aero",
		"production.aero",
		"recreation.aero",
		"repbody.aero",
		"res.aero",
		"research.aero",
		"rotorcraft.aero",
		"safety.aero",
		"scientist.aero",
		"services.aero",
		"show.aero",
		"skydiving.aero",
		"software.aero",
		"student.aero",
		"taxi.aero",
		"trader.aero",
		"trading.aero",
		"trainer.aero",
		"union.aero",
		"workinggroup.aero",
		"works.aero",
		"af",
		"com.af",
		"edu.af",
		"gov.af",
		"net.af",
		"org.af",
		"ag",
		"co.ag",
		"com.ag",
		"net.ag",
		"nom.ag",
		"org.ag",
		"ai",
		"com.ai",
		"net.ai",
		"off.ai",
		"org.ai",
		"al",
		"com.al",
		"edu.al",
		"gov.al",
		"mil.al",
		"net.al",
		"org.al",
		"am",
		"co.am",
		"com.am",
		"commune.am",
		"net.am",
		"org.am",
		"ao",
		"co.ao",
		"ed.ao",
		"edu.ao",
		"gov.ao",
		"gv.ao",
		"it.ao",
		"og.ao",
		"org.ao",
		"pb.ao",
		"aq",
		"ar",
		"bet.ar",
		"com.ar",
		"coop.ar",
		"edu.ar",
		"gob.ar",
		"gov.ar",
		"int.ar",
		"mil.ar",
		"musica.ar",
		"mutual.ar",
		"net.ar",
		"org.ar",
		"senasa.ar",
		"tur.ar",
		"arpa",
		"e164.arpa",
		"home.arpa",
		"in-addr.arpa",
		"ip6.arpa",
		"iris.arpa",
		"uri.arpa",
		"urn.arpa",
		"as",
		"gov.as",
		"asia",
		"at",
		"ac.at",
		"sth.ac.at",
		"co.at",
		"gv.at",
		"or.at",
		"au",
		"asn.au",
		"com.au",
		"edu.au",
		"gov.au",
		"id.au",
		"net.au",
		"org.au",
		"conf.au",
		"oz.au",
		"act.au",
		"nsw.au",
		"nt.au",
		"qld.au",
		"sa.au",
		"tas.au",
		"vic.au",
		"wa.au",
		"act.edu.au",
		"catholic.edu.au",
		"nsw.edu.au",
		"nt.edu.au",
		"qld.edu.au",
		"sa.edu.au",
		"tas.edu.au",
		"vic.edu.au",
		"wa.edu.au",
		"qld.gov.au",
		"sa.gov.au",
		"tas.gov.au",
		"vic.gov.au",
		"wa.gov.au",
		"schools.nsw.edu.au",
		"aw",
		"com.aw",
		"ax",
		"az",
		"biz.az",
		"com.az",
		"edu.az",
		"gov.az",
		"info.az",
		"int.az",
		"mil.az",
		"name.az",
		"net.az",
		"org.az",
		"pp.az",
		"pro.az",
		"ba",
		"com.ba",
		"edu.ba",
		"gov.ba",
		"mil.ba",
		"net.ba",
		"org.ba",
		"bb",
		"biz.bb",
		"co.bb",
		"com.bb",
		"edu.bb",
		"gov.bb",
		"info.bb",
		"net.bb",
		"org.bb",
		"store.bb",
		"tv.bb",
		"*.bd",
		"be",
		"ac.be",
		"bf",
		"gov.bf",
		"bg",
		"0.bg",
		"1.bg",
		"2.bg",
		"3.bg",
		"4.bg",
		"5.bg",
		"6.bg",
		"7.bg",
		"8.bg",
		"9.bg",
		"a.bg",
		"b.bg",
		"c.bg",
		"d.bg",
		"e.bg",
		"f.bg",
		"g.bg",
		"h.bg",
		"i.bg",
		"j.bg",
		"k.bg",
		"l.bg",
		"m.bg",
		"n.bg",
		"o.bg",
		"p.bg",
		"q.bg",
		"r.bg",
		"s.bg",
		"t.bg",
		"u.bg",
		"v.bg",
		"w.bg",
		"x.bg",
		"y.bg",
		"z.bg",
		"bh",
		"com.bh",
		"edu.bh",
		"gov.bh",
		"net.bh",
		"org.bh",
		"bi",
		"co.bi",
		"com.bi",
		"edu.bi",
		"or.bi",
		"org.bi",
		"biz",
		"bj",
		"africa.bj",
		"agro.bj",
		"architectes.bj",
		"assur.bj",
		"avocats.bj",
		"co.bj",
		"com.bj",
		"eco.bj",
		"econo.bj",
		"edu.bj",
		"info.bj",
		"loisirs.bj",
		"money.bj",
		"net.bj",
		"org.bj",
		"ote.bj",
		"restaurant.bj",
		"resto.bj",
		"tourism.bj",
		"univ.bj",
		"bm",
		"com.bm",
		"edu.bm",
		"gov.bm",
		"net.bm",
		"org.bm",
		"bn",
		"com.bn",
		"edu.bn",
		"gov.bn",
		"net.bn",
		"org.bn",
		"bo",
		"com.bo",
		"edu.bo",
		"gob.bo",
		"int.bo",
		"mil.bo",
		"net.bo",
		"org.bo",
		"tv.bo",
		"web.bo",
		"academia.bo",
		"agro.bo",
		"arte.bo",
		"blog.bo",
		"bolivia.bo",
		"ciencia.bo",
		"cooperativa.bo",
		"democracia.bo",
		"deporte.bo",
		"ecologia.bo",
		"economia.bo",
		"empresa.bo",
		"indigena.bo",
		"industria.bo",
		"info.bo",
		"medicina.bo",
		"movimiento.bo",
		"musica.bo",
		"natural.bo",
		"nombre.bo",
		"noticias.bo",
		"patria.bo",
		"plurinacional.bo",
		"politica.bo",
		"profesional.bo",
		"pueblo.bo",
		"revista.bo",
		"salud.bo",
		"tecnologia.bo",
		"tksat.bo",
		"transporte.bo",
		"wiki.bo",
		"br",
		"9guacu.br",
		"abc.br",
		"adm.br",
		"adv.br",
		"agr.br",
		"aju.br",
		"am.br",
		"anani.br",
		"aparecida.br",
		"app.br",
		"arq.br",
		"art.br",
		"ato.br",
		"b.br",
		"barueri.br",
		"belem.br",
		"bet.br",
		"bhz.br",
		"bib.br",
		"bio.br",
		"blog.br",
		"bmd.br",
		"boavista.br",
		"bsb.br",
		"campinagrande.br",
		"campinas.br",
		"caxias.br",
		"cim.br",
		"cng.br",
		"cnt.br",
		"com.br",
		"contagem.br",
		"coop.br",
		"coz.br",
		"cri.br",
		"cuiaba.br",
		"curitiba.br",
		"def.br",
		"des.br",
		"det.br",
		"dev.br",
		"ecn.br",
		"eco.br",
		"edu.br",
		"emp.br",
		"enf.br",
		"eng.br",
		"esp.br",
		"etc.br",
		"eti.br",
		"far.br",
		"feira.br",
		"flog.br",
		"floripa.br",
		"fm.br",
		"fnd.br",
		"fortal.br",
		"fot.br",
		"foz.br",
		"fst.br",
		"g12.br",
		"geo.br",
		"ggf.br",
		"goiania.br",
		"gov.br",
		"ac.gov.br",
		"al.gov.br",
		"am.gov.br",
		"ap.gov.br",
		"ba.gov.br",
		"ce.gov.br",
		"df.gov.br",
		"es.gov.br",
		"go.gov.br",
		"ma.gov.br",
		"mg.gov.br",
		"ms.gov.br",
		"mt.gov.br",
		"pa.gov.br",
		"pb.gov.br",
		"pe.gov.br",
		"pi.gov.br",
		"pr.gov.br",
		"rj.gov.br",
		"rn.gov.br",
		"ro.gov.br",
		"rr.gov.br",
		"rs.gov.br",
		"sc.gov.br",
		"se.gov.br",
		"sp.gov.br",
		"to.gov.br",
		"gru.br",
		"imb.br",
		"ind.br",
		"inf.br",
		"jab.br",
		"jampa.br",
		"jdf.br",
		"joinville.br",
		"jor.br",
		"jus.br",
		"leg.br",
		"leilao.br",
		"lel.br",
		"log.br",
		"londrina.br",
		"macapa.br",
		"maceio.br",
		"manaus.br",
		"maringa.br",
		"mat.br",
		"med.br",
		"mil.br",
		"morena.br",
		"mp.br",
		"mus.br",
		"natal.br",
		"net.br",
		"niteroi.br",
		"*.nom.br",
		"not.br",
		"ntr.br",
		"odo.br",
		"ong.br",
		"org.br",
		"osasco.br",
		"palmas.br",
		"poa.br",
		"ppg.br",
		"pro.br",
		"psc.br",
		"psi.br",
		"pvh.br",
		"qsl.br",
		"radio.br",
		"rec.br",
		"recife.br",
		"rep.br",
		"ribeirao.br",
		"rio.br",
		"riobranco.br",
		"riopreto.br",
		"salvador.br",
		"sampa.br",
		"santamaria.br",
		"santoandre.br",
		"saobernardo.br",
		"saogonca.br",
		"seg.br",
		"sjc.br",
		"slg.br",
		"slz.br",
		"sorocaba.br",
		"srv.br",
		"taxi.br",
		"tc.br",
		"tec.br",
		"teo.br",
		"the.br",
		"tmp.br",
		"trd.br",
		"tur.br",
		"tv.br",
		"udi.br",
		"vet.br",
		"vix.br",
		"vlog.br",
		"wiki.br",
		"zlg.br",
		"bs",
		"com.bs",
		"edu.bs",
		"gov.bs",
		"net.bs",
		"org.bs",
		"bt",
		"com.bt",
		"edu.bt",
		"gov.bt",
		"net.bt",
		"org.bt",
		"bv",
		"bw",
		"co.bw",
		"org.bw",
		"by",
		"gov.by",
		"mil.by",
		"com.by",
		"of.by",
		"bz",
		"co.bz",
		"com.bz",
		"edu.bz",
		"gov.bz",
		"net.bz",
		"org.bz",
		"ca",
		"ab.ca",
		"bc.ca",
		"mb.ca",
		"nb.ca",
		"nf.ca",
		"nl.ca",
		"ns.ca",
		"nt.ca",
		"nu.ca",
		"on.ca",
		"pe.ca",
		"qc.ca",
		"sk.ca",
		"yk.ca",
		"gc.ca",
		"cat",
		"cc",
		"cd",
		"gov.cd",
		"cf",
		"cg",
		"ch",
		"ci",
		"ac.ci",
		"aéroport.ci",
		"asso.ci",
		"co.ci",
		"com.ci",
		"ed.ci",
		"edu.ci",
		"go.ci",
		"gouv.ci",
		"int.ci",
		"net.ci",
		"or.ci",
		"org.ci",
		"*.ck",
		"!www.ck",
		"cl",
		"co.cl",
		"gob.cl",
		"gov.cl",
		"mil.cl",
		"cm",
		"co.cm",
		"com.cm",
		"gov.cm",
		"net.cm",
		"cn",
		"ac.cn",
		"com.cn",
		"edu.cn",
		"gov.cn",
		"mil.cn",
		"net.cn",
		"org.cn",
		"公司.cn",
		"網絡.cn",
		"网络.cn",
		"ah.cn",
		"bj.cn",
		"cq.cn",
		"fj.cn",
		"gd.cn",
		"gs.cn",
		"gx.cn",
		"gz.cn",
		"ha.cn",
		"hb.cn",
		"he.cn",
		"hi.cn",
		"hk.cn",
		"hl.cn",
		"hn.cn",
		"jl.cn",
		"js.cn",
		"jx.cn",
		"ln.cn",
		"mo.cn",
		"nm.cn",
		"nx.cn",
		"qh.cn",
		"sc.cn",
		"sd.cn",
		"sh.cn",
		"sn.cn",
		"sx.cn",
		"tj.cn",
		"tw.cn",
		"xj.cn",
		"xz.cn",
		"yn.cn",
		"zj.cn",
		"co",
		"com.co",
		"edu.co",
		"gov.co",
		"mil.co",
		"net.co",
		"nom.co",
		"org.co",
		"com",
		"coop",
		"cr",
		"ac.cr",
		"co.cr",
		"ed.cr",
		"fi.cr",
		"go.cr",
		"or.cr",
		"sa.cr",
		"cu",
		"com.cu",
		"edu.cu",
		"gob.cu",
		"inf.cu",
		"nat.cu",
		"net.cu",
		"org.cu",
		"cv",
		"com.cv",
		"edu.cv",
		"id.cv",
		"int.cv",
		"net.cv",
		"nome.cv",
		"org.cv",
		"publ.cv",
		"cw",
		"com.cw",
		"edu.cw",
		"net.cw",
		"org.cw",
		"cx",
		"gov.cx",
		"cy",
		"ac.cy",
		"biz.cy",
		"com.cy",
		"ekloges.cy",
		"gov.cy",
		"ltd.cy",
		"mil.cy",
		"net.cy",
		"org.cy",
		"press.cy",
		"pro.cy",
		"tm.cy",
		"cz",
		"de",
		"dj",
		"dk",
		"dm",
		"co.dm",
		"com.dm",
		"edu.dm",
		"gov.dm",
		"net.dm",
		"org.dm",
		"do",
		"art.do",
		"com.do",
		"edu.do",
		"gob.do",
		"gov.do",
		"mil.do",
		"net.do",
		"org.do",
		"sld.do",
		"web.do",
		"dz",
		"art.dz",
		"asso.dz",
		"com.dz",
		"edu.dz",
		"gov.dz",
		"net.dz",
		"org.dz",
		"pol.dz",
		"soc.dz",
		"tm.dz",
		"ec",
		"com.ec",
		"edu.ec",
		"fin.ec",
		"gob.ec",
		"gov.ec",
		"info.ec",
		"k12.ec",
		"med.ec",
		"mil.ec",
		"net.ec",
		"org.ec",
		"pro.ec",
		"edu",
		"ee",
		"aip.ee",
		"com.ee",
		"edu.ee",
		"fie.ee",
		"gov.ee",
		"lib.ee",
		"med.ee",
		"org.ee",
		"pri.ee",
		"riik.ee",
		"eg",
		"ac.eg",
		"com.eg",
		"edu.eg",
		"eun.eg",
		"gov.eg",
		"info.eg",
		"me.eg",
		"mil.eg",
		"name.eg",
		"net.eg",
		"org.eg",
		"sci.eg",
		"sport.eg",
		"tv.eg",
		"*.er",
		"es",
		"com.es",
		"edu.es",
		"gob.es",
		"nom.es",
		"org.es",
		"et",
		"biz.et",
		"com.et",
		"edu.et",
		"gov.et",
		"info.et",
		"name.et",
		"net.et",
		"org.et",
		"eu",
		"fi",
		"aland.fi",
		"fj",
		"ac.fj",
		"biz.fj",
		"com.fj",
		"gov.fj",
		"info.fj",
		"mil.fj",
		"name.fj",
		"net.fj",
		"org.fj",
		"pro.fj",
		"*.fk",
		"fm",
		"com.fm",
		"edu.fm",
		"net.fm",
		"org.fm",
		"fo",
		"fr",
		"asso.fr",
		"com.fr",
		"gouv.fr",
		"nom.fr",
		"prd.fr",
		"tm.fr",
		"avoues.fr",
		"cci.fr",
		"greta.fr",
		"huissier-justice.fr",
		"ga",
		"gb",
		"gd",
		"edu.gd",
		"gov.gd",
		"ge",
		"com.ge",
		"edu.ge",
		"gov.ge",
		"net.ge",
		"org.ge",
		"pvt.ge",
		"school.ge",
		"gf",
		"gg",
		"co.gg",
		"net.gg",
		"org.gg",
		"gh",
		"com.gh",
		"edu.gh",
		"gov.gh",
		"mil.gh",
		"org.gh",
		"gi",
		"com.gi",
		"edu.gi",
		"gov.gi",
		"ltd.gi",
		"mod.gi",
		"org.gi",
		"gl",
		"co.gl",
		"com.gl",
		"edu.gl",
		"net.gl",
		"org.gl",
		"gm",
		"gn",
		"ac.gn",
		"com.gn",
		"edu.gn",
		"gov.gn",
		"net.gn",
		"org.gn",
		"gov",
		"gp",
		"asso.gp",
		"com.gp",
		"edu.gp",
		"mobi.gp",
		"net.gp",
		"org.gp",
		"gq",
		"gr",
		"com.gr",
		"edu.gr",
		"gov.gr",
		"net.gr",
		"org.gr",
		"gs",
		"gt",
		"com.gt",
		"edu.gt",
		"gob.gt",
		"ind.gt",
		"mil.gt",
		"net.gt",
		"org.gt",
		"gu",
		"com.gu",
		"edu.gu",
		"gov.gu",
		"guam.gu",
		"info.gu",
		"net.gu",
		"org.gu",
		"web.gu",
		"gw",
		"gy",
		"co.gy",
		"com.gy",
		"edu.gy",
		"gov.gy",
		"net.gy",
		"org.gy",
		"hk",
		"com.hk",
		"edu.hk",
		"gov.hk",
		"idv.hk",
		"net.hk",
		"org.hk",
		"个人.hk",
		"個人.hk",
		"公司.hk",
		"政府.hk",
		"敎育.hk",
		"教育.hk",
		"箇人.hk",
		"組織.hk",
		"組织.hk",
		"網絡.hk",
		"網络.hk",
		"组織.hk",
		"组织.hk",
		"网絡.hk",
		"网络.hk",
		"hm",
		"hn",
		"com.hn",
		"edu.hn",
		"gob.hn",
		"mil.hn",
		"net.hn",
		"org.hn",
		"hr",
		"com.hr",
		"from.hr",
		"iz.hr",
		"name.hr",
		"ht",
		"adult.ht",
		"art.ht",
		"asso.ht",
		"com.ht",
		"coop.ht",
		"edu.ht",
		"firm.ht",
		"gouv.ht",
		"info.ht",
		"med.ht",
		"net.ht",
		"org.ht",
		"perso.ht",
		"pol.ht",
		"pro.ht",
		"rel.ht",
		"shop.ht",
		"hu",
		"2000.hu",
		"agrar.hu",
		"bolt.hu",
		"casino.hu",
		"city.hu",
		"co.hu",
		"erotica.hu",
		"erotika.hu",
		"film.hu",
		"forum.hu",
		"games.hu",
		"hotel.hu",
		"info.hu",
		"ingatlan.hu",
		"jogasz.hu",
		"konyvelo.hu",
		"lakas.hu",
		"media.hu",
		"news.hu",
		"org.hu",
		"priv.hu",
		"reklam.hu",
		"sex.hu",
		"shop.hu",
		"sport.hu",
		"suli.hu",
		"szex.hu",
		"tm.hu",
		"tozsde.hu",
		"utazas.hu",
		"video.hu",
		"id",
		"ac.id",
		"biz.id",
		"co.id",
		"desa.id",
		"go.id",
		"mil.id",
		"my.id",
		"net.id",
		"or.id",
		"ponpes.id",
		"sch.id",
		"web.id",
		"ie",
		"gov.ie",
		"il",
		"ac.il",
		"co.il",
		"gov.il",
		"idf.il",
		"k12.il",
		"muni.il",
		"net.il",
		"org.il",
		"ישראל",
		"אקדמיה.ישראל",
		"ישוב.ישראל",
		"צהל.ישראל",
		"ממשל.ישראל",
		"im",
		"ac.im",
		"co.im",
		"ltd.co.im",
		"plc.co.im",
		"com.im",
		"net.im",
		"org.im",
		"tt.im",
		"tv.im",
		"in",
		"5g.in",
		"6g.in",
		"ac.in",
		"ai.in",
		"am.in",
		"bihar.in",
		"biz.in",
		"business.in",
		"ca.in",
		"cn.in",
		"co.in",
		"com.in",
		"coop.in",
		"cs.in",
		"delhi.in",
		"dr.in",
		"edu.in",
		"er.in",
		"firm.in",
		"gen.in",
		"gov.in",
		"gujarat.in",
		"ind.in",
		"info.in",
		"int.in",
		"internet.in",
		"io.in",
		"me.in",
		"mil.in",
		"net.in",
		"nic.in",
		"org.in",
		"pg.in",
		"post.in",
		"pro.in",
		"res.in",
		"travel.in",
		"tv.in",
		"uk.in",
		"up.in",
		"us.in",
		"info",
		"int",
		"eu.int",
		"io",
		"co.io",
		"com.io",
		"edu.io",
		"gov.io",
		"mil.io",
		"net.io",
		"nom.io",
		"org.io",
		"iq",
		"com.iq",
		"edu.iq",
		"gov.iq",
		"mil.iq",
		"net.iq",
		"org.iq",
		"ir",
		"ac.ir",
		"co.ir",
		"gov.ir",
		"id.ir",
		"net.ir",
		"org.ir",
		"sch.ir",
		"ایران.ir",
		"ايران.ir",
		"is",
		"it",
		"edu.it",
		"gov.it",
		"abr.it",
		"abruzzo.it",
		"aosta-valley.it",
		"aostavalley.it",
		"bas.it",
		"basilicata.it",
		"cal.it",
		"calabria.it",
		"cam.it",
		"campania.it",
		"emilia-romagna.it",
		"emiliaromagna.it",
		"emr.it",
		"friuli-v-giulia.it",
		"friuli-ve-giulia.it",
		"friuli-vegiulia.it",
		"friuli-venezia-giulia.it",
		"friuli-veneziagiulia.it",
		"friuli-vgiulia.it",
		"friuliv-giulia.it",
		"friulive-giulia.it",
		"friulivegiulia.it",
		"friulivenezia-giulia.it",
		"friuliveneziagiulia.it",
		"friulivgiulia.it",
		"fvg.it",
		"laz.it",
		"lazio.it",
		"lig.it",
		"liguria.it",
		"lom.it",
		"lombardia.it",
		"lombardy.it",
		"lucania.it",
		"mar.it",
		"marche.it",
		"mol.it",
		"molise.it",
		"piedmont.it",
		"piemonte.it",
		"pmn.it",
		"pug.it",
		"puglia.it",
		"sar.it",
		"sardegna.it",
		"sardinia.it",
		"sic.it",
		"sicilia.it",
		"sicily.it",
		"taa.it",
		"tos.it",
		"toscana.it",
		"trentin-sud-tirol.it",
		"trentin-süd-tirol.it",
		"trentin-sudtirol.it",
		"trentin-südtirol.it",
		"trentin-sued-tirol.it",
		"trentin-suedtirol.it",
		"trentino.it",
		"trentino-a-adige.it",
		"trentino-aadige.it",
		"trentino-alto-adige.it",
		"trentino-altoadige.it",
		"trentino-s-tirol.it",
		"trentino-stirol.it",
		"trentino-sud-tirol.it",
		"trentino-süd-tirol.it",
		"trentino-sudtirol.it",
		"trentino-südtirol.it",
		"trentino-sued-tirol.it",
		"trentino-suedtirol.it",
		"trentinoa-adige.it",
		"trentinoaadige.it",
		"trentinoalto-adige.it",
		"trentinoaltoadige.it",
		"trentinos-tirol.it",
		"trentinostirol.it",
		"trentinosud-tirol.it",
		"trentinosüd-tirol.it",
		"trentinosudtirol.it",
		"trentinosüdtirol.it",
		"trentinosued-tirol.it",
		"trentinosuedtirol.it",
		"trentinsud-tirol.it",
		"trentinsüd-tirol.it",
		"trentinsudtirol.it",
		"trentinsüdtirol.it",
		"trentinsued-tirol.it",
		"trentinsuedtirol.it",
		"tuscany.it",
		"umb.it",
		"umbria.it",
		"val-d-aosta.it",
		"val-daosta.it",
		"vald-aosta.it",
		"valdaosta.it",
		"valle-aosta.it",
		"valle-d-aosta.it",
		"valle-daosta.it",
		"valleaosta.it",
		"valled-aosta.it",
		"valledaosta.it",
		"vallee-aoste.it",
		"vallée-aoste.it",
		"vallee-d-aoste.it",
		"vallée-d-aoste.it",
		"valleeaoste.it",
		"valléeaoste.it",
		"valleedaoste.it",
		"valléedaoste.it",
		"vao.it",
		"vda.it",
		"ven.it",
		"veneto.it",
		"ag.it",
		"agrigento.it",
		"al.it",
		"alessandria.it",
		"alto-adige.it",
		"altoadige.it",
		"an.it",
		"ancona.it",
		"andria-barletta-trani.it",
		"andria-trani-barletta.it",
		"andriabarlettatrani.it",
		"andriatranibarletta.it",
		"ao.it",
		"aosta.it",
		"aoste.it",
		"ap.it",
		"aq.it",
		"aquila.it",
		"ar.it",
		"arezzo.it",
		"ascoli-piceno.it",
		"ascolipiceno.it",
		"asti.it",
		"at.it",
		"av.it",
		"avellino.it",
		"ba.it",
		"balsan.it",
		"balsan-sudtirol.it",
		"balsan-südtirol.it",
		"balsan-suedtirol.it",
		"bari.it",
		"barletta-trani-andria.it",
		"barlettatraniandria.it",
		"belluno.it",
		"benevento.it",
		"bergamo.it",
		"bg.it",
		"bi.it",
		"biella.it",
		"bl.it",
		"bn.it",
		"bo.it",
		"bologna.it",
		"bolzano.it",
		"bolzano-altoadige.it",
		"bozen.it",
		"bozen-sudtirol.it",
		"bozen-südtirol.it",
		"bozen-suedtirol.it",
		"br.it",
		"brescia.it",
		"brindisi.it",
		"bs.it",
		"bt.it",
		"bulsan.it",
		"bulsan-sudtirol.it",
		"bulsan-südtirol.it",
		"bulsan-suedtirol.it",
		"bz.it",
		"ca.it",
		"cagliari.it",
		"caltanissetta.it",
		"campidano-medio.it",
		"campidanomedio.it",
		"campobasso.it",
		"carbonia-iglesias.it",
		"carboniaiglesias.it",
		"carrara-massa.it",
		"carraramassa.it",
		"caserta.it",
		"catania.it",
		"catanzaro.it",
		"cb.it",
		"ce.it",
		"cesena-forli.it",
		"cesena-forlì.it",
		"cesenaforli.it",
		"cesenaforlì.it",
		"ch.it",
		"chieti.it",
		"ci.it",
		"cl.it",
		"cn.it",
		"co.it",
		"como.it",
		"cosenza.it",
		"cr.it",
		"cremona.it",
		"crotone.it",
		"cs.it",
		"ct.it",
		"cuneo.it",
		"cz.it",
		"dell-ogliastra.it",
		"dellogliastra.it",
		"en.it",
		"enna.it",
		"fc.it",
		"fe.it",
		"fermo.it",
		"ferrara.it",
		"fg.it",
		"fi.it",
		"firenze.it",
		"florence.it",
		"fm.it",
		"foggia.it",
		"forli-cesena.it",
		"forlì-cesena.it",
		"forlicesena.it",
		"forlìcesena.it",
		"fr.it",
		"frosinone.it",
		"ge.it",
		"genoa.it",
		"genova.it",
		"go.it",
		"gorizia.it",
		"gr.it",
		"grosseto.it",
		"iglesias-carbonia.it",
		"iglesiascarbonia.it",
		"im.it",
		"imperia.it",
		"is.it",
		"isernia.it",
		"kr.it",
		"la-spezia.it",
		"laquila.it",
		"laspezia.it",
		"latina.it",
		"lc.it",
		"le.it",
		"lecce.it",
		"lecco.it",
		"li.it",
		"livorno.it",
		"lo.it",
		"lodi.it",
		"lt.it",
		"lu.it",
		"lucca.it",
		"macerata.it",
		"mantova.it",
		"massa-carrara.it",
		"massacarrara.it",
		"matera.it",
		"mb.it",
		"mc.it",
		"me.it",
		"medio-campidano.it",
		"mediocampidano.it",
		"messina.it",
		"mi.it",
		"milan.it",
		"milano.it",
		"mn.it",
		"mo.it",
		"modena.it",
		"monza.it",
		"monza-brianza.it",
		"monza-e-della-brianza.it",
		"monzabrianza.it",
		"monzaebrianza.it",
		"monzaedellabrianza.it",
		"ms.it",
		"mt.it",
		"na.it",
		"naples.it",
		"napoli.it",
		"no.it",
		"novara.it",
		"nu.it",
		"nuoro.it",
		"og.it",
		"ogliastra.it",
		"olbia-tempio.it",
		"olbiatempio.it",
		"or.it",
		"oristano.it",
		"ot.it",
		"pa.it",
		"padova.it",
		"padua.it",
		"palermo.it",
		"parma.it",
		"pavia.it",
		"pc.it",
		"pd.it",
		"pe.it",
		"perugia.it",
		"pesaro-urbino.it",
		"pesarourbino.it",
		"pescara.it",
		"pg.it",
		"pi.it",
		"piacenza.it",
		"pisa.it",
		"pistoia.it",
		"pn.it",
		"po.it",
		"pordenone.it",
		"potenza.it",
		"pr.it",
		"prato.it",
		"pt.it",
		"pu.it",
		"pv.it",
		"pz.it",
		"ra.it",
		"ragusa.it",
		"ravenna.it",
		"rc.it",
		"re.it",
		"reggio-calabria.it",
		"reggio-emilia.it",
		"reggiocalabria.it",
		"reggioemilia.it",
		"rg.it",
		"ri.it",
		"rieti.it",
		"rimini.it",
		"rm.it",
		"rn.it",
		"ro.it",
		"roma.it",
		"rome.it",
		"rovigo.it",
		"sa.it",
		"salerno.it",
		"sassari.it",
		"savona.it",
		"si.it",
		"siena.it",
		"siracusa.it",
		"so.it",
		"sondrio.it",
		"sp.it",
		"sr.it",
		"ss.it",
		"südtirol.it",
		"suedtirol.it",
		"sv.it",
		"ta.it",
		"taranto.it",
		"te.it",
		"tempio-olbia.it",
		"tempioolbia.it",
		"teramo.it",
		"terni.it",
		"tn.it",
		"to.it",
		"torino.it",
		"tp.it",
		"tr.it",
		"trani-andria-barletta.it",
		"trani-barletta-andria.it",
		"traniandriabarletta.it",
		"tranibarlettaandria.it",
		"trapani.it",
		"trento.it",
		"treviso.it",
		"trieste.it",
		"ts.it",
		"turin.it",
		"tv.it",
		"ud.it",
		"udine.it",
		"urbino-pesaro.it",
		"urbinopesaro.it",
		"va.it",
		"varese.it",
		"vb.it",
		"vc.it",
		"ve.it",
		"venezia.it",
		"venice.it",
		"verbania.it",
		"vercelli.it",
		"verona.it",
		"vi.it",
		"vibo-valentia.it",
		"vibovalentia.it",
		"vicenza.it",
		"viterbo.it",
		"vr.it",
		"vs.it",
		"vt.it",
		"vv.it",
		"je",
		"co.je",
		"net.je",
		"org.je",
		"*.jm",
		"jo",
		"agri.jo",
		"ai.jo",
		"com.jo",
		"edu.jo",
		"eng.jo",
		"fm.jo",
		"gov.jo",
		"mil.jo",
		"net.jo",
		"org.jo",
		"per.jo",
		"phd.jo",
		"sch.jo",
		"tv.jo",
		"jobs",
		"jp",
		"ac.jp",
		"ad.jp",
		"co.jp",
		"ed.jp",
		"go.jp",
		"gr.jp",
		"lg.jp",
		"ne.jp",
		"or.jp",
		"aichi.jp",
		"akita.jp",
		"aomori.jp",
		"chiba.jp",
		"ehime.jp",
		"fukui.jp",
		"fukuoka.jp",
		"fukushima.jp",
		"gifu.jp",
		"gunma.jp",
		"hiroshima.jp",
		"hokkaido.jp",
		"hyogo.jp",
		"ibaraki.jp",
		"ishikawa.jp",
		"iwate.jp",
		"kagawa.jp",
		"kagoshima.jp",
		"kanagawa.jp",
		"kochi.jp",
		"kumamoto.jp",
		"kyoto.jp",
		"mie.jp",
		"miyagi.jp",
		"miyazaki.jp",
		"nagano.jp",
		"nagasaki.jp",
		"nara.jp",
		"niigata.jp",
		"oita.jp",
		"okayama.jp",
		"okinawa.jp",
		"osaka.jp",
		"saga.jp",
		"saitama.jp",
		"shiga.jp",
		"shimane.jp",
		"shizuoka.jp",
		"tochigi.jp",
		"tokushima.jp",
		"tokyo.jp",
		"tottori.jp",
		"toyama.jp",
		"wakayama.jp",
		"yamagata.jp",
		"yamaguchi.jp",
		"yamanashi.jp",
		"三重.jp",
		"京都.jp",
		"佐賀.jp",
		"兵庫.jp",
		"北海道.jp",
		"千葉.jp",
		"和歌山.jp",
		"埼玉.jp",
		"大分.jp",
		"大阪.jp",
		"奈良.jp",
		"宮城.jp",
		"宮崎.jp",
		"富山.jp",
		"山口.jp",
		"山形.jp",
		"山梨.jp",
		"岐阜.jp",
		"岡山.jp",
		"岩手.jp",
		"島根.jp",
		"広島.jp",
		"徳島.jp",
		"愛媛.jp",
		"愛知.jp",
		"新潟.jp",
		"東京.jp",
		"栃木.jp",
		"沖縄.jp",
		"滋賀.jp",
		"熊本.jp",
		"石川.jp",
		"神奈川.jp",
		"福井.jp",
		"福岡.jp",
		"福島.jp",
		"秋田.jp",
		"群馬.jp",
		"茨城.jp",
		"長崎.jp",
		"長野.jp",
		"青森.jp",
		"静岡.jp",
		"香川.jp",
		"高知.jp",
		"鳥取.jp",
		"鹿児島.jp",
		"*.kawasaki.jp",
		"!city.kawasaki.jp",
		"*.kitakyushu.jp",
		"!city.kitakyushu.jp",
		"*.kobe.jp",
		"!city.kobe.jp",
		"*.nagoya.jp",
		"!city.nagoya.jp",
		"*.sapporo.jp",
		"!city.sapporo.jp",
		"*.sendai.jp",
		"!city.sendai.jp",
		"*.yokohama.jp",
		"!city.yokohama.jp",
		"aisai.aichi.jp",
		"ama.aichi.jp",
		"anjo.aichi.jp",
		"asuke.aichi.jp",
		"chiryu.aichi.jp",
		"chita.aichi.jp",
		"fuso.aichi.jp",
		"gamagori.aichi.jp",
		"handa.aichi.jp",
		"hazu.aichi.jp",
		"hekinan.aichi.jp",
		"higashiura.aichi.jp",
		"ichinomiya.aichi.jp",
		"inazawa.aichi.jp",
		"inuyama.aichi.jp",
		"isshiki.aichi.jp",
		"iwakura.aichi.jp",
		"kanie.aichi.jp",
		"kariya.aichi.jp",
		"kasugai.aichi.jp",
		"kira.aichi.jp",
		"kiyosu.aichi.jp",
		"komaki.aichi.jp",
		"konan.aichi.jp",
		"kota.aichi.jp",
		"mihama.aichi.jp",
		"miyoshi.aichi.jp",
		"nishio.aichi.jp",
		"nisshin.aichi.jp",
		"obu.aichi.jp",
		"oguchi.aichi.jp",
		"oharu.aichi.jp",
		"okazaki.aichi.jp",
		"owariasahi.aichi.jp",
		"seto.aichi.jp",
		"shikatsu.aichi.jp",
		"shinshiro.aichi.jp",
		"shitara.aichi.jp",
		"tahara.aichi.jp",
		"takahama.aichi.jp",
		"tobishima.aichi.jp",
		"toei.aichi.jp",
		"togo.aichi.jp",
		"tokai.aichi.jp",
		"tokoname.aichi.jp",
		"toyoake.aichi.jp",
		"toyohashi.aichi.jp",
		"toyokawa.aichi.jp",
		"toyone.aichi.jp",
		"toyota.aichi.jp",
		"tsushima.aichi.jp",
		"yatomi.aichi.jp",
		"akita.akita.jp",
		"daisen.akita.jp",
		"fujisato.akita.jp",
		"gojome.akita.jp",
		"hachirogata.akita.jp",
		"happou.akita.jp",
		"higashinaruse.akita.jp",
		"honjo.akita.jp",
		"honjyo.akita.jp",
		"ikawa.akita.jp",
		"kamikoani.akita.jp",
		"kamioka.akita.jp",
		"katagami.akita.jp",
		"kazuno.akita.jp",
		"kitaakita.akita.jp",
		"kosaka.akita.jp",
		"kyowa.akita.jp",
		"misato.akita.jp",
		"mitane.akita.jp",
		"moriyoshi.akita.jp",
		"nikaho.akita.jp",
		"noshiro.akita.jp",
		"odate.akita.jp",
		"oga.akita.jp",
		"ogata.akita.jp",
		"semboku.akita.jp",
		"yokote.akita.jp",
		"yurihonjo.akita.jp",
		"aomori.aomori.jp",
		"gonohe.aomori.jp",
		"hachinohe.aomori.jp",
		"hashikami.aomori.jp",
		"hiranai.aomori.jp",
		"hirosaki.aomori.jp",
		"itayanagi.aomori.jp",
		"kuroishi.aomori.jp",
		"misawa.aomori.jp",
		"mutsu.aomori.jp",
		"nakadomari.aomori.jp",
		"noheji.aomori.jp",
		"oirase.aomori.jp",
		"owani.aomori.jp",
		"rokunohe.aomori.jp",
		"sannohe.aomori.jp",
		"shichinohe.aomori.jp",
		"shingo.aomori.jp",
		"takko.aomori.jp",
		"towada.aomori.jp",
		"tsugaru.aomori.jp",
		"tsuruta.aomori.jp",
		"abiko.chiba.jp",
		"asahi.chiba.jp",
		"chonan.chiba.jp",
		"chosei.chiba.jp",
		"choshi.chiba.jp",
		"chuo.chiba.jp",
		"funabashi.chiba.jp",
		"futtsu.chiba.jp",
		"hanamigawa.chiba.jp",
		"ichihara.chiba.jp",
		"ichikawa.chiba.jp",
		"ichinomiya.chiba.jp",
		"inzai.chiba.jp",
		"isumi.chiba.jp",
		"kamagaya.chiba.jp",
		"kamogawa.chiba.jp",
		"kashiwa.chiba.jp",
		"katori.chiba.jp",
		"katsuura.chiba.jp",
		"kimitsu.chiba.jp",
		"kisarazu.chiba.jp",
		"kozaki.chiba.jp",
		"kujukuri.chiba.jp",
		"kyonan.chiba.jp",
		"matsudo.chiba.jp",
		"midori.chiba.jp",
		"mihama.chiba.jp",
		"minamiboso.chiba.jp",
		"mobara.chiba.jp",
		"mutsuzawa.chiba.jp",
		"nagara.chiba.jp",
		"nagareyama.chiba.jp",
		"narashino.chiba.jp",
		"narita.chiba.jp",
		"noda.chiba.jp",
		"oamishirasato.chiba.jp",
		"omigawa.chiba.jp",
		"onjuku.chiba.jp",
		"otaki.chiba.jp",
		"sakae.chiba.jp",
		"sakura.chiba.jp",
		"shimofusa.chiba.jp",
		"shirako.chiba.jp",
		"shiroi.chiba.jp",
		"shisui.chiba.jp",
		"sodegaura.chiba.jp",
		"sosa.chiba.jp",
		"tako.chiba.jp",
		"tateyama.chiba.jp",
		"togane.chiba.jp",
		"tohnosho.chiba.jp",
		"tomisato.chiba.jp",
		"urayasu.chiba.jp",
		"yachimata.chiba.jp",
		"yachiyo.chiba.jp",
		"yokaichiba.chiba.jp",
		"yokoshibahikari.chiba.jp",
		"yotsukaido.chiba.jp",
		"ainan.ehime.jp",
		"honai.ehime.jp",
		"ikata.ehime.jp",
		"imabari.ehime.jp",
		"iyo.ehime.jp",
		"kamijima.ehime.jp",
		"kihoku.ehime.jp",
		"kumakogen.ehime.jp",
		"masaki.ehime.jp",
		"matsuno.ehime.jp",
		"matsuyama.ehime.jp",
		"namikata.ehime.jp",
		"niihama.ehime.jp",
		"ozu.ehime.jp",
		"saijo.ehime.jp",
		"seiyo.ehime.jp",
		"shikokuchuo.ehime.jp",
		"tobe.ehime.jp",
		"toon.ehime.jp",
		"uchiko.ehime.jp",
		"uwajima.ehime.jp",
		"yawatahama.ehime.jp",
		"echizen.fukui.jp",
		"eiheiji.fukui.jp",
		"fukui.fukui.jp",
		"ikeda.fukui.jp",
		"katsuyama.fukui.jp",
		"mihama.fukui.jp",
		"minamiechizen.fukui.jp",
		"obama.fukui.jp",
		"ohi.fukui.jp",
		"ono.fukui.jp",
		"sabae.fukui.jp",
		"sakai.fukui.jp",
		"takahama.fukui.jp",
		"tsuruga.fukui.jp",
		"wakasa.fukui.jp",
		"ashiya.fukuoka.jp",
		"buzen.fukuoka.jp",
		"chikugo.fukuoka.jp",
		"chikuho.fukuoka.jp",
		"chikujo.fukuoka.jp",
		"chikushino.fukuoka.jp",
		"chikuzen.fukuoka.jp",
		"chuo.fukuoka.jp",
		"dazaifu.fukuoka.jp",
		"fukuchi.fukuoka.jp",
		"hakata.fukuoka.jp",
		"higashi.fukuoka.jp",
		"hirokawa.fukuoka.jp",
		"hisayama.fukuoka.jp",
		"iizuka.fukuoka.jp",
		"inatsuki.fukuoka.jp",
		"kaho.fukuoka.jp",
		"kasuga.fukuoka.jp",
		"kasuya.fukuoka.jp",
		"kawara.fukuoka.jp",
		"keisen.fukuoka.jp",
		"koga.fukuoka.jp",
		"kurate.fukuoka.jp",
		"kurogi.fukuoka.jp",
		"kurume.fukuoka.jp",
		"minami.fukuoka.jp",
		"miyako.fukuoka.jp",
		"miyama.fukuoka.jp",
		"miyawaka.fukuoka.jp",
		"mizumaki.fukuoka.jp",
		"munakata.fukuoka.jp",
		"nakagawa.fukuoka.jp",
		"nakama.fukuoka.jp",
		"nishi.fukuoka.jp",
		"nogata.fukuoka.jp",
		"ogori.fukuoka.jp",
		"okagaki.fukuoka.jp",
		"okawa.fukuoka.jp",
		"oki.fukuoka.jp",
		"omuta.fukuoka.jp",
		"onga.fukuoka.jp",
		"onojo.fukuoka.jp",
		"oto.fukuoka.jp",
		"saigawa.fukuoka.jp",
		"sasaguri.fukuoka.jp",
		"shingu.fukuoka.jp",
		"shinyoshitomi.fukuoka.jp",
		"shonai.fukuoka.jp",
		"soeda.fukuoka.jp",
		"sue.fukuoka.jp",
		"tachiarai.fukuoka.jp",
		"tagawa.fukuoka.jp",
		"takata.fukuoka.jp",
		"toho.fukuoka.jp",
		"toyotsu.fukuoka.jp",
		"tsuiki.fukuoka.jp",
		"ukiha.fukuoka.jp",
		"umi.fukuoka.jp",
		"usui.fukuoka.jp",
		"yamada.fukuoka.jp",
		"yame.fukuoka.jp",
		"yanagawa.fukuoka.jp",
		"yukuhashi.fukuoka.jp",
		"aizubange.fukushima.jp",
		"aizumisato.fukushima.jp",
		"aizuwakamatsu.fukushima.jp",
		"asakawa.fukushima.jp",
		"bandai.fukushima.jp",
		"date.fukushima.jp",
		"fukushima.fukushima.jp",
		"furudono.fukushima.jp",
		"futaba.fukushima.jp",
		"hanawa.fukushima.jp",
		"higashi.fukushima.jp",
		"hirata.fukushima.jp",
		"hirono.fukushima.jp",
		"iitate.fukushima.jp",
		"inawashiro.fukushima.jp",
		"ishikawa.fukushima.jp",
		"iwaki.fukushima.jp",
		"izumizaki.fukushima.jp",
		"kagamiishi.fukushima.jp",
		"kaneyama.fukushima.jp",
		"kawamata.fukushima.jp",
		"kitakata.fukushima.jp",
		"kitashiobara.fukushima.jp",
		"koori.fukushima.jp",
		"koriyama.fukushima.jp",
		"kunimi.fukushima.jp",
		"miharu.fukushima.jp",
		"mishima.fukushima.jp",
		"namie.fukushima.jp",
		"nango.fukushima.jp",
		"nishiaizu.fukushima.jp",
		"nishigo.fukushima.jp",
		"okuma.fukushima.jp",
		"omotego.fukushima.jp",
		"ono.fukushima.jp",
		"otama.fukushima.jp",
		"samegawa.fukushima.jp",
		"shimogo.fukushima.jp",
		"shirakawa.fukushima.jp",
		"showa.fukushima.jp",
		"soma.fukushima.jp",
		"sukagawa.fukushima.jp",
		"taishin.fukushima.jp",
		"tamakawa.fukushima.jp",
		"tanagura.fukushima.jp",
		"tenei.fukushima.jp",
		"yabuki.fukushima.jp",
		"yamato.fukushima.jp",
		"yamatsuri.fukushima.jp",
		"yanaizu.fukushima.jp",
		"yugawa.fukushima.jp",
		"anpachi.gifu.jp",
		"ena.gifu.jp",
		"gifu.gifu.jp",
		"ginan.gifu.jp",
		"godo.gifu.jp",
		"gujo.gifu.jp",
		"hashima.gifu.jp",
		"hichiso.gifu.jp",
		"hida.gifu.jp",
		"higashishirakawa.gifu.jp",
		"ibigawa.gifu.jp",
		"ikeda.gifu.jp",
		"kakamigahara.gifu.jp",
		"kani.gifu.jp",
		"kasahara.gifu.jp",
		"kasamatsu.gifu.jp",
		"kawaue.gifu.jp",
		"kitagata.gifu.jp",
		"mino.gifu.jp",
		"minokamo.gifu.jp",
		"mitake.gifu.jp",
		"mizunami.gifu.jp",
		"motosu.gifu.jp",
		"nakatsugawa.gifu.jp",
		"ogaki.gifu.jp",
		"sakahogi.gifu.jp",
		"seki.gifu.jp",
		"sekigahara.gifu.jp",
		"shirakawa.gifu.jp",
		"tajimi.gifu.jp",
		"takayama.gifu.jp",
		"tarui.gifu.jp",
		"toki.gifu.jp",
		"tomika.gifu.jp",
		"wanouchi.gifu.jp",
		"yamagata.gifu.jp",
		"yaotsu.gifu.jp",
		"yoro.gifu.jp",
		"annaka.gunma.jp",
		"chiyoda.gunma.jp",
		"fujioka.gunma.jp",
		"higashiagatsuma.gunma.jp",
		"isesaki.gunma.jp",
		"itakura.gunma.jp",
		"kanna.gunma.jp",
		"kanra.gunma.jp",
		"katashina.gunma.jp",
		"kawaba.gunma.jp",
		"kiryu.gunma.jp",
		"kusatsu.gunma.jp",
		"maebashi.gunma.jp",
		"meiwa.gunma.jp",
		"midori.gunma.jp",
		"minakami.gunma.jp",
		"naganohara.gunma.jp",
		"nakanojo.gunma.jp",
		"nanmoku.gunma.jp",
		"numata.gunma.jp",
		"oizumi.gunma.jp",
		"ora.gunma.jp",
		"ota.gunma.jp",
		"shibukawa.gunma.jp",
		"shimonita.gunma.jp",
		"shinto.gunma.jp",
		"showa.gunma.jp",
		"takasaki.gunma.jp",
		"takayama.gunma.jp",
		"tamamura.gunma.jp",
		"tatebayashi.gunma.jp",
		"tomioka.gunma.jp",
		"tsukiyono.gunma.jp",
		"tsumagoi.gunma.jp",
		"ueno.gunma.jp",
		"yoshioka.gunma.jp",
		"asaminami.hiroshima.jp",
		"daiwa.hiroshima.jp",
		"etajima.hiroshima.jp",
		"fuchu.hiroshima.jp",
		"fukuyama.hiroshima.jp",
		"hatsukaichi.hiroshima.jp",
		"higashihiroshima.hiroshima.jp",
		"hongo.hiroshima.jp",
		"jinsekikogen.hiroshima.jp",
		"kaita.hiroshima.jp",
		"kui.hiroshima.jp",
		"kumano.hiroshima.jp",
		"kure.hiroshima.jp",
		"mihara.hiroshima.jp",
		"miyoshi.hiroshima.jp",
		"naka.hiroshima.jp",
		"onomichi.hiroshima.jp",
		"osakikamijima.hiroshima.jp",
		"otake.hiroshima.jp",
		"saka.hiroshima.jp",
		"sera.hiroshima.jp",
		"seranishi.hiroshima.jp",
		"shinichi.hiroshima.jp",
		"shobara.hiroshima.jp",
		"takehara.hiroshima.jp",
		"abashiri.hokkaido.jp",
		"abira.hokkaido.jp",
		"aibetsu.hokkaido.jp",
		"akabira.hokkaido.jp",
		"akkeshi.hokkaido.jp",
		"asahikawa.hokkaido.jp",
		"ashibetsu.hokkaido.jp",
		"ashoro.hokkaido.jp",
		"assabu.hokkaido.jp",
		"atsuma.hokkaido.jp",
		"bibai.hokkaido.jp",
		"biei.hokkaido.jp",
		"bifuka.hokkaido.jp",
		"bihoro.hokkaido.jp",
		"biratori.hokkaido.jp",
		"chippubetsu.hokkaido.jp",
		"chitose.hokkaido.jp",
		"date.hokkaido.jp",
		"ebetsu.hokkaido.jp",
		"embetsu.hokkaido.jp",
		"eniwa.hokkaido.jp",
		"erimo.hokkaido.jp",
		"esan.hokkaido.jp",
		"esashi.hokkaido.jp",
		"fukagawa.hokkaido.jp",
		"fukushima.hokkaido.jp",
		"furano.hokkaido.jp",
		"furubira.hokkaido.jp",
		"haboro.hokkaido.jp",
		"hakodate.hokkaido.jp",
		"hamatonbetsu.hokkaido.jp",
		"hidaka.hokkaido.jp",
		"higashikagura.hokkaido.jp",
		"higashikawa.hokkaido.jp",
		"hiroo.hokkaido.jp",
		"hokuryu.hokkaido.jp",
		"hokuto.hokkaido.jp",
		"honbetsu.hokkaido.jp",
		"horokanai.hokkaido.jp",
		"horonobe.hokkaido.jp",
		"ikeda.hokkaido.jp",
		"imakane.hokkaido.jp",
		"ishikari.hokkaido.jp",
		"iwamizawa.hokkaido.jp",
		"iwanai.hokkaido.jp",
		"kamifurano.hokkaido.jp",
		"kamikawa.hokkaido.jp",
		"kamishihoro.hokkaido.jp",
		"kamisunagawa.hokkaido.jp",
		"kamoenai.hokkaido.jp",
		"kayabe.hokkaido.jp",
		"kembuchi.hokkaido.jp",
		"kikonai.hokkaido.jp",
		"kimobetsu.hokkaido.jp",
		"kitahiroshima.hokkaido.jp",
		"kitami.hokkaido.jp",
		"kiyosato.hokkaido.jp",
		"koshimizu.hokkaido.jp",
		"kunneppu.hokkaido.jp",
		"kuriyama.hokkaido.jp",
		"kuromatsunai.hokkaido.jp",
		"kushiro.hokkaido.jp",
		"kutchan.hokkaido.jp",
		"kyowa.hokkaido.jp",
		"mashike.hokkaido.jp",
		"matsumae.hokkaido.jp",
		"mikasa.hokkaido.jp",
		"minamifurano.hokkaido.jp",
		"mombetsu.hokkaido.jp",
		"moseushi.hokkaido.jp",
		"mukawa.hokkaido.jp",
		"muroran.hokkaido.jp",
		"naie.hokkaido.jp",
		"nakagawa.hokkaido.jp",
		"nakasatsunai.hokkaido.jp",
		"nakatombetsu.hokkaido.jp",
		"nanae.hokkaido.jp",
		"nanporo.hokkaido.jp",
		"nayoro.hokkaido.jp",
		"nemuro.hokkaido.jp",
		"niikappu.hokkaido.jp",
		"niki.hokkaido.jp",
		"nishiokoppe.hokkaido.jp",
		"noboribetsu.hokkaido.jp",
		"numata.hokkaido.jp",
		"obihiro.hokkaido.jp",
		"obira.hokkaido.jp",
		"oketo.hokkaido.jp",
		"okoppe.hokkaido.jp",
		"otaru.hokkaido.jp",
		"otobe.hokkaido.jp",
		"otofuke.hokkaido.jp",
		"otoineppu.hokkaido.jp",
		"oumu.hokkaido.jp",
		"ozora.hokkaido.jp",
		"pippu.hokkaido.jp",
		"rankoshi.hokkaido.jp",
		"rebun.hokkaido.jp",
		"rikubetsu.hokkaido.jp",
		"rishiri.hokkaido.jp",
		"rishirifuji.hokkaido.jp",
		"saroma.hokkaido.jp",
		"sarufutsu.hokkaido.jp",
		"shakotan.hokkaido.jp",
		"shari.hokkaido.jp",
		"shibecha.hokkaido.jp",
		"shibetsu.hokkaido.jp",
		"shikabe.hokkaido.jp",
		"shikaoi.hokkaido.jp",
		"shimamaki.hokkaido.jp",
		"shimizu.hokkaido.jp",
		"shimokawa.hokkaido.jp",
		"shinshinotsu.hokkaido.jp",
		"shintoku.hokkaido.jp",
		"shiranuka.hokkaido.jp",
		"shiraoi.hokkaido.jp",
		"shiriuchi.hokkaido.jp",
		"sobetsu.hokkaido.jp",
		"sunagawa.hokkaido.jp",
		"taiki.hokkaido.jp",
		"takasu.hokkaido.jp",
		"takikawa.hokkaido.jp",
		"takinoue.hokkaido.jp",
		"teshikaga.hokkaido.jp",
		"tobetsu.hokkaido.jp",
		"tohma.hokkaido.jp",
		"tomakomai.hokkaido.jp",
		"tomari.hokkaido.jp",
		"toya.hokkaido.jp",
		"toyako.hokkaido.jp",
		"toyotomi.hokkaido.jp",
		"toyoura.hokkaido.jp",
		"tsubetsu.hokkaido.jp",
		"tsukigata.hokkaido.jp",
		"urakawa.hokkaido.jp",
		"urausu.hokkaido.jp",
		"uryu.hokkaido.jp",
		"utashinai.hokkaido.jp",
		"wakkanai.hokkaido.jp",
		"wassamu.hokkaido.jp",
		"yakumo.hokkaido.jp",
		"yoichi.hokkaido.jp",
		"aioi.hyogo.jp",
		"akashi.hyogo.jp",
		"ako.hyogo.jp",
		"amagasaki.hyogo.jp",
		"aogaki.hyogo.jp",
		"asago.hyogo.jp",
		"ashiya.hyogo.jp",
		"awaji.hyogo.jp",
		"fukusaki.hyogo.jp",
		"goshiki.hyogo.jp",
		"harima.hyogo.jp",
		"himeji.hyogo.jp",
		"ichikawa.hyogo.jp",
		"inagawa.hyogo.jp",
		"itami.hyogo.jp",
		"kakogawa.hyogo.jp",
		"kamigori.hyogo.jp",
		"kamikawa.hyogo.jp",
		"kasai.hyogo.jp",
		"kasuga.hyogo.jp",
		"kawanishi.hyogo.jp",
		"miki.hyogo.jp",
		"minamiawaji.hyogo.jp",
		"nishinomiya.hyogo.jp",
		"nishiwaki.hyogo.jp",
		"ono.hyogo.jp",
		"sanda.hyogo.jp",
		"sannan.hyogo.jp",
		"sasayama.hyogo.jp",
		"sayo.hyogo.jp",
		"shingu.hyogo.jp",
		"shinonsen.hyogo.jp",
		"shiso.hyogo.jp",
		"sumoto.hyogo.jp",
		"taishi.hyogo.jp",
		"taka.hyogo.jp",
		"takarazuka.hyogo.jp",
		"takasago.hyogo.jp",
		"takino.hyogo.jp",
		"tamba.hyogo.jp",
		"tatsuno.hyogo.jp",
		"toyooka.hyogo.jp",
		"yabu.hyogo.jp",
		"yashiro.hyogo.jp",
		"yoka.hyogo.jp",
		"yokawa.hyogo.jp",
		"ami.ibaraki.jp",
		"asahi.ibaraki.jp",
		"bando.ibaraki.jp",
		"chikusei.ibaraki.jp",
		"daigo.ibaraki.jp",
		"fujishiro.ibaraki.jp",
		"hitachi.ibaraki.jp",
		"hitachinaka.ibaraki.jp",
		"hitachiomiya.ibaraki.jp",
		"hitachiota.ibaraki.jp",
		"ibaraki.ibaraki.jp",
		"ina.ibaraki.jp",
		"inashiki.ibaraki.jp",
		"itako.ibaraki.jp",
		"iwama.ibaraki.jp",
		"joso.ibaraki.jp",
		"kamisu.ibaraki.jp",
		"kasama.ibaraki.jp",
		"kashima.ibaraki.jp",
		"kasumigaura.ibaraki.jp",
		"koga.ibaraki.jp",
		"miho.ibaraki.jp",
		"mito.ibaraki.jp",
		"moriya.ibaraki.jp",
		"naka.ibaraki.jp",
		"namegata.ibaraki.jp",
		"oarai.ibaraki.jp",
		"ogawa.ibaraki.jp",
		"omitama.ibaraki.jp",
		"ryugasaki.ibaraki.jp",
		"sakai.ibaraki.jp",
		"sakuragawa.ibaraki.jp",
		"shimodate.ibaraki.jp",
		"shimotsuma.ibaraki.jp",
		"shirosato.ibaraki.jp",
		"sowa.ibaraki.jp",
		"suifu.ibaraki.jp",
		"takahagi.ibaraki.jp",
		"tamatsukuri.ibaraki.jp",
		"tokai.ibaraki.jp",
		"tomobe.ibaraki.jp",
		"tone.ibaraki.jp",
		"toride.ibaraki.jp",
		"tsuchiura.ibaraki.jp",
		"tsukuba.ibaraki.jp",
		"uchihara.ibaraki.jp",
		"ushiku.ibaraki.jp",
		"yachiyo.ibaraki.jp",
		"yamagata.ibaraki.jp",
		"yawara.ibaraki.jp",
		"yuki.ibaraki.jp",
		"anamizu.ishikawa.jp",
		"hakui.ishikawa.jp",
		"hakusan.ishikawa.jp",
		"kaga.ishikawa.jp",
		"kahoku.ishikawa.jp",
		"kanazawa.ishikawa.jp",
		"kawakita.ishikawa.jp",
		"komatsu.ishikawa.jp",
		"nakanoto.ishikawa.jp",
		"nanao.ishikawa.jp",
		"nomi.ishikawa.jp",
		"nonoichi.ishikawa.jp",
		"noto.ishikawa.jp",
		"shika.ishikawa.jp",
		"suzu.ishikawa.jp",
		"tsubata.ishikawa.jp",
		"tsurugi.ishikawa.jp",
		"uchinada.ishikawa.jp",
		"wajima.ishikawa.jp",
		"fudai.iwate.jp",
		"fujisawa.iwate.jp",
		"hanamaki.iwate.jp",
		"hiraizumi.iwate.jp",
		"hirono.iwate.jp",
		"ichinohe.iwate.jp",
		"ichinoseki.iwate.jp",
		"iwaizumi.iwate.jp",
		"iwate.iwate.jp",
		"joboji.iwate.jp",
		"kamaishi.iwate.jp",
		"kanegasaki.iwate.jp",
		"karumai.iwate.jp",
		"kawai.iwate.jp",
		"kitakami.iwate.jp",
		"kuji.iwate.jp",
		"kunohe.iwate.jp",
		"kuzumaki.iwate.jp",
		"miyako.iwate.jp",
		"mizusawa.iwate.jp",
		"morioka.iwate.jp",
		"ninohe.iwate.jp",
		"noda.iwate.jp",
		"ofunato.iwate.jp",
		"oshu.iwate.jp",
		"otsuchi.iwate.jp",
		"rikuzentakata.iwate.jp",
		"shiwa.iwate.jp",
		"shizukuishi.iwate.jp",
		"sumita.iwate.jp",
		"tanohata.iwate.jp",
		"tono.iwate.jp",
		"yahaba.iwate.jp",
		"yamada.iwate.jp",
		"ayagawa.kagawa.jp",
		"higashikagawa.kagawa.jp",
		"kanonji.kagawa.jp",
		"kotohira.kagawa.jp",
		"manno.kagawa.jp",
		"marugame.kagawa.jp",
		"mitoyo.kagawa.jp",
		"naoshima.kagawa.jp",
		"sanuki.kagawa.jp",
		"tadotsu.kagawa.jp",
		"takamatsu.kagawa.jp",
		"tonosho.kagawa.jp",
		"uchinomi.kagawa.jp",
		"utazu.kagawa.jp",
		"zentsuji.kagawa.jp",
		"akune.kagoshima.jp",
		"amami.kagoshima.jp",
		"hioki.kagoshima.jp",
		"isa.kagoshima.jp",
		"isen.kagoshima.jp",
		"izumi.kagoshima.jp",
		"kagoshima.kagoshima.jp",
		"kanoya.kagoshima.jp",
		"kawanabe.kagoshima.jp",
		"kinko.kagoshima.jp",
		"kouyama.kagoshima.jp",
		"makurazaki.kagoshima.jp",
		"matsumoto.kagoshima.jp",
		"minamitane.kagoshima.jp",
		"nakatane.kagoshima.jp",
		"nishinoomote.kagoshima.jp",
		"satsumasendai.kagoshima.jp",
		"soo.kagoshima.jp",
		"tarumizu.kagoshima.jp",
		"yusui.kagoshima.jp",
		"aikawa.kanagawa.jp",
		"atsugi.kanagawa.jp",
		"ayase.kanagawa.jp",
		"chigasaki.kanagawa.jp",
		"ebina.kanagawa.jp",
		"fujisawa.kanagawa.jp",
		"hadano.kanagawa.jp",
		"hakone.kanagawa.jp",
		"hiratsuka.kanagawa.jp",
		"isehara.kanagawa.jp",
		"kaisei.kanagawa.jp",
		"kamakura.kanagawa.jp",
		"kiyokawa.kanagawa.jp",
		"matsuda.kanagawa.jp",
		"minamiashigara.kanagawa.jp",
		"miura.kanagawa.jp",
		"nakai.kanagawa.jp",
		"ninomiya.kanagawa.jp",
		"odawara.kanagawa.jp",
		"oi.kanagawa.jp",
		"oiso.kanagawa.jp",
		"sagamihara.kanagawa.jp",
		"samukawa.kanagawa.jp",
		"tsukui.kanagawa.jp",
		"yamakita.kanagawa.jp",
		"yamato.kanagawa.jp",
		"yokosuka.kanagawa.jp",
		"yugawara.kanagawa.jp",
		"zama.kanagawa.jp",
		"zushi.kanagawa.jp",
		"aki.kochi.jp",
		"geisei.kochi.jp",
		"hidaka.kochi.jp",
		"higashitsuno.kochi.jp",
		"ino.kochi.jp",
		"kagami.kochi.jp",
		"kami.kochi.jp",
		"kitagawa.kochi.jp",
		"kochi.kochi.jp",
		"mihara.kochi.jp",
		"motoyama.kochi.jp",
		"muroto.kochi.jp",
		"nahari.kochi.jp",
		"nakamura.kochi.jp",
		"nankoku.kochi.jp",
		"nishitosa.kochi.jp",
		"niyodogawa.kochi.jp",
		"ochi.kochi.jp",
		"okawa.kochi.jp",
		"otoyo.kochi.jp",
		"otsuki.kochi.jp",
		"sakawa.kochi.jp",
		"sukumo.kochi.jp",
		"susaki.kochi.jp",
		"tosa.kochi.jp",
		"tosashimizu.kochi.jp",
		"toyo.kochi.jp",
		"tsuno.kochi.jp",
		"umaji.kochi.jp",
		"yasuda.kochi.jp",
		"yusuhara.kochi.jp",
		"amakusa.kumamoto.jp",
		"arao.kumamoto.jp",
		"aso.kumamoto.jp",
		"choyo.kumamoto.jp",
		"gyokuto.kumamoto.jp",
		"kamiamakusa.kumamoto.jp",
		"kikuchi.kumamoto.jp",
		"kumamoto.kumamoto.jp",
		"mashiki.kumamoto.jp",
		"mifune.kumamoto.jp",
		"minamata.kumamoto.jp",
		"minamioguni.kumamoto.jp",
		"nagasu.kumamoto.jp",
		"nishihara.kumamoto.jp",
		"oguni.kumamoto.jp",
		"ozu.kumamoto.jp",
		"sumoto.kumamoto.jp",
		"takamori.kumamoto.jp",
		"uki.kumamoto.jp",
		"uto.kumamoto.jp",
		"yamaga.kumamoto.jp",
		"yamato.kumamoto.jp",
		"yatsushiro.kumamoto.jp",
		"ayabe.kyoto.jp",
		"fukuchiyama.kyoto.jp",
		"higashiyama.kyoto.jp",
		"ide.kyoto.jp",
		"ine.kyoto.jp",
		"joyo.kyoto.jp",
		"kameoka.kyoto.jp",
		"kamo.kyoto.jp",
		"kita.kyoto.jp",
		"kizu.kyoto.jp",
		"kumiyama.kyoto.jp",
		"kyotamba.kyoto.jp",
		"kyotanabe.kyoto.jp",
		"kyotango.kyoto.jp",
		"maizuru.kyoto.jp",
		"minami.kyoto.jp",
		"minamiyamashiro.kyoto.jp",
		"miyazu.kyoto.jp",
		"muko.kyoto.jp",
		"nagaokakyo.kyoto.jp",
		"nakagyo.kyoto.jp",
		"nantan.kyoto.jp",
		"oyamazaki.kyoto.jp",
		"sakyo.kyoto.jp",
		"seika.kyoto.jp",
		"tanabe.kyoto.jp",
		"uji.kyoto.jp",
		"ujitawara.kyoto.jp",
		"wazuka.kyoto.jp",
		"yamashina.kyoto.jp",
		"yawata.kyoto.jp",
		"asahi.mie.jp",
		"inabe.mie.jp",
		"ise.mie.jp",
		"kameyama.mie.jp",
		"kawagoe.mie.jp",
		"kiho.mie.jp",
		"kisosaki.mie.jp",
		"kiwa.mie.jp",
		"komono.mie.jp",
		"kumano.mie.jp",
		"kuwana.mie.jp",
		"matsusaka.mie.jp",
		"meiwa.mie.jp",
		"mihama.mie.jp",
		"minamiise.mie.jp",
		"misugi.mie.jp",
		"miyama.mie.jp",
		"nabari.mie.jp",
		"shima.mie.jp",
		"suzuka.mie.jp",
		"tado.mie.jp",
		"taiki.mie.jp",
		"taki.mie.jp",
		"tamaki.mie.jp",
		"toba.mie.jp",
		"tsu.mie.jp",
		"udono.mie.jp",
		"ureshino.mie.jp",
		"watarai.mie.jp",
		"yokkaichi.mie.jp",
		"furukawa.miyagi.jp",
		"higashimatsushima.miyagi.jp",
		"ishinomaki.miyagi.jp",
		"iwanuma.miyagi.jp",
		"kakuda.miyagi.jp",
		"kami.miyagi.jp",
		"kawasaki.miyagi.jp",
		"marumori.miyagi.jp",
		"matsushima.miyagi.jp",
		"minamisanriku.miyagi.jp",
		"misato.miyagi.jp",
		"murata.miyagi.jp",
		"natori.miyagi.jp",
		"ogawara.miyagi.jp",
		"ohira.miyagi.jp",
		"onagawa.miyagi.jp",
		"osaki.miyagi.jp",
		"rifu.miyagi.jp",
		"semine.miyagi.jp",
		"shibata.miyagi.jp",
		"shichikashuku.miyagi.jp",
		"shikama.miyagi.jp",
		"shiogama.miyagi.jp",
		"shiroishi.miyagi.jp",
		"tagajo.miyagi.jp",
		"taiwa.miyagi.jp",
		"tome.miyagi.jp",
		"tomiya.miyagi.jp",
		"wakuya.miyagi.jp",
		"watari.miyagi.jp",
		"yamamoto.miyagi.jp",
		"zao.miyagi.jp",
		"aya.miyazaki.jp",
		"ebino.miyazaki.jp",
		"gokase.miyazaki.jp",
		"hyuga.miyazaki.jp",
		"kadogawa.miyazaki.jp",
		"kawaminami.miyazaki.jp",
		"kijo.miyazaki.jp",
		"kitagawa.miyazaki.jp",
		"kitakata.miyazaki.jp",
		"kitaura.miyazaki.jp",
		"kobayashi.miyazaki.jp",
		"kunitomi.miyazaki.jp",
		"kushima.miyazaki.jp",
		"mimata.miyazaki.jp",
		"miyakonojo.miyazaki.jp",
		"miyazaki.miyazaki.jp",
		"morotsuka.miyazaki.jp",
		"nichinan.miyazaki.jp",
		"nishimera.miyazaki.jp",
		"nobeoka.miyazaki.jp",
		"saito.miyazaki.jp",
		"shiiba.miyazaki.jp",
		"shintomi.miyazaki.jp",
		"takaharu.miyazaki.jp",
		"takanabe.miyazaki.jp",
		"takazaki.miyazaki.jp",
		"tsuno.miyazaki.jp",
		"achi.nagano.jp",
		"agematsu.nagano.jp",
		"anan.nagano.jp",
		"aoki.nagano.jp",
		"asahi.nagano.jp",
		"azumino.nagano.jp",
		"chikuhoku.nagano.jp",
		"chikuma.nagano.jp",
		"chino.nagano.jp",
		"fujimi.nagano.jp",
		"hakuba.nagano.jp",
		"hara.nagano.jp",
		"hiraya.nagano.jp",
		"iida.nagano.jp",
		"iijima.nagano.jp",
		"iiyama.nagano.jp",
		"iizuna.nagano.jp",
		"ikeda.nagano.jp",
		"ikusaka.nagano.jp",
		"ina.nagano.jp",
		"karuizawa.nagano.jp",
		"kawakami.nagano.jp",
		"kiso.nagano.jp",
		"kisofukushima.nagano.jp",
		"kitaaiki.nagano.jp",
		"komagane.nagano.jp",
		"komoro.nagano.jp",
		"matsukawa.nagano.jp",
		"matsumoto.nagano.jp",
		"miasa.nagano.jp",
		"minamiaiki.nagano.jp",
		"minamimaki.nagano.jp",
		"minamiminowa.nagano.jp",
		"minowa.nagano.jp",
		"miyada.nagano.jp",
		"miyota.nagano.jp",
		"mochizuki.nagano.jp",
		"nagano.nagano.jp",
		"nagawa.nagano.jp",
		"nagiso.nagano.jp",
		"nakagawa.nagano.jp",
		"nakano.nagano.jp",
		"nozawaonsen.nagano.jp",
		"obuse.nagano.jp",
		"ogawa.nagano.jp",
		"okaya.nagano.jp",
		"omachi.nagano.jp",
		"omi.nagano.jp",
		"ookuwa.nagano.jp",
		"ooshika.nagano.jp",
		"otaki.nagano.jp",
		"otari.nagano.jp",
		"sakae.nagano.jp",
		"sakaki.nagano.jp",
		"saku.nagano.jp",
		"sakuho.nagano.jp",
		"shimosuwa.nagano.jp",
		"shinanomachi.nagano.jp",
		"shiojiri.nagano.jp",
		"suwa.nagano.jp",
		"suzaka.nagano.jp",
		"takagi.nagano.jp",
		"takamori.nagano.jp",
		"takayama.nagano.jp",
		"tateshina.nagano.jp",
		"tatsuno.nagano.jp",
		"togakushi.nagano.jp",
		"togura.nagano.jp",
		"tomi.nagano.jp",
		"ueda.nagano.jp",
		"wada.nagano.jp",
		"yamagata.nagano.jp",
		"yamanouchi.nagano.jp",
		"yasaka.nagano.jp",
		"yasuoka.nagano.jp",
		"chijiwa.nagasaki.jp",
		"futsu.nagasaki.jp",
		"goto.nagasaki.jp",
		"hasami.nagasaki.jp",
		"hirado.nagasaki.jp",
		"iki.nagasaki.jp",
		"isahaya.nagasaki.jp",
		"kawatana.nagasaki.jp",
		"kuchinotsu.nagasaki.jp",
		"matsuura.nagasaki.jp",
		"nagasaki.nagasaki.jp",
		"obama.nagasaki.jp",
		"omura.nagasaki.jp",
		"oseto.nagasaki.jp",
		"saikai.nagasaki.jp",
		"sasebo.nagasaki.jp",
		"seihi.nagasaki.jp",
		"shimabara.nagasaki.jp",
		"shinkamigoto.nagasaki.jp",
		"togitsu.nagasaki.jp",
		"tsushima.nagasaki.jp",
		"unzen.nagasaki.jp",
		"ando.nara.jp",
		"gose.nara.jp",
		"heguri.nara.jp",
		"higashiyoshino.nara.jp",
		"ikaruga.nara.jp",
		"ikoma.nara.jp",
		"kamikitayama.nara.jp",
		"kanmaki.nara.jp",
		"kashiba.nara.jp",
		"kashihara.nara.jp",
		"katsuragi.nara.jp",
		"kawai.nara.jp",
		"kawakami.nara.jp",
		"kawanishi.nara.jp",
		"koryo.nara.jp",
		"kurotaki.nara.jp",
		"mitsue.nara.jp",
		"miyake.nara.jp",
		"nara.nara.jp",
		"nosegawa.nara.jp",
		"oji.nara.jp",
		"ouda.nara.jp",
		"oyodo.nara.jp",
		"sakurai.nara.jp",
		"sango.nara.jp",
		"shimoichi.nara.jp",
		"shimokitayama.nara.jp",
		"shinjo.nara.jp",
		"soni.nara.jp",
		"takatori.nara.jp",
		"tawaramoto.nara.jp",
		"tenkawa.nara.jp",
		"tenri.nara.jp",
		"uda.nara.jp",
		"yamatokoriyama.nara.jp",
		"yamatotakada.nara.jp",
		"yamazoe.nara.jp",
		"yoshino.nara.jp",
		"aga.niigata.jp",
		"agano.niigata.jp",
		"gosen.niigata.jp",
		"itoigawa.niigata.jp",
		"izumozaki.niigata.jp",
		"joetsu.niigata.jp",
		"kamo.niigata.jp",
		"kariwa.niigata.jp",
		"kashiwazaki.niigata.jp",
		"minamiuonuma.niigata.jp",
		"mitsuke.niigata.jp",
		"muika.niigata.jp",
		"murakami.niigata.jp",
		"myoko.niigata.jp",
		"nagaoka.niigata.jp",
		"niigata.niigata.jp",
		"ojiya.niigata.jp",
		"omi.niigata.jp",
		"sado.niigata.jp",
		"sanjo.niigata.jp",
		"seiro.niigata.jp",
		"seirou.niigata.jp",
		"sekikawa.niigata.jp",
		"shibata.niigata.jp",
		"tagami.niigata.jp",
		"tainai.niigata.jp",
		"tochio.niigata.jp",
		"tokamachi.niigata.jp",
		"tsubame.niigata.jp",
		"tsunan.niigata.jp",
		"uonuma.niigata.jp",
		"yahiko.niigata.jp",
		"yoita.niigata.jp",
		"yuzawa.niigata.jp",
		"beppu.oita.jp",
		"bungoono.oita.jp",
		"bungotakada.oita.jp",
		"hasama.oita.jp",
		"hiji.oita.jp",
		"himeshima.oita.jp",
		"hita.oita.jp",
		"kamitsue.oita.jp",
		"kokonoe.oita.jp",
		"kuju.oita.jp",
		"kunisaki.oita.jp",
		"kusu.oita.jp",
		"oita.oita.jp",
		"saiki.oita.jp",
		"taketa.oita.jp",
		"tsukumi.oita.jp",
		"usa.oita.jp",
		"usuki.oita.jp",
		"yufu.oita.jp",
		"akaiwa.okayama.jp",
		"asakuchi.okayama.jp",
		"bizen.okayama.jp",
		"hayashima.okayama.jp",
		"ibara.okayama.jp",
		"kagamino.okayama.jp",
		"kasaoka.okayama.jp",
		"kibichuo.okayama.jp",
		"kumenan.okayama.jp",
		"kurashiki.okayama.jp",
		"maniwa.okayama.jp",
		"misaki.okayama.jp",
		"nagi.okayama.jp",
		"niimi.okayama.jp",
		"nishiawakura.okayama.jp",
		"okayama.okayama.jp",
		"satosho.okayama.jp",
		"setouchi.okayama.jp",
		"shinjo.okayama.jp",
		"shoo.okayama.jp",
		"soja.okayama.jp",
		"takahashi.okayama.jp",
		"tamano.okayama.jp",
		"tsuyama.okayama.jp",
		"wake.okayama.jp",
		"yakage.okayama.jp",
		"aguni.okinawa.jp",
		"ginowan.okinawa.jp",
		"ginoza.okinawa.jp",
		"gushikami.okinawa.jp",
		"haebaru.okinawa.jp",
		"higashi.okinawa.jp",
		"hirara.okinawa.jp",
		"iheya.okinawa.jp",
		"ishigaki.okinawa.jp",
		"ishikawa.okinawa.jp",
		"itoman.okinawa.jp",
		"izena.okinawa.jp",
		"kadena.okinawa.jp",
		"kin.okinawa.jp",
		"kitadaito.okinawa.jp",
		"kitanakagusuku.okinawa.jp",
		"kumejima.okinawa.jp",
		"kunigami.okinawa.jp",
		"minamidaito.okinawa.jp",
		"motobu.okinawa.jp",
		"nago.okinawa.jp",
		"naha.okinawa.jp",
		"nakagusuku.okinawa.jp",
		"nakijin.okinawa.jp",
		"nanjo.okinawa.jp",
		"nishihara.okinawa.jp",
		"ogimi.okinawa.jp",
		"okinawa.okinawa.jp",
		"onna.okinawa.jp",
		"shimoji.okinawa.jp",
		"taketomi.okinawa.jp",
		"tarama.okinawa.jp",
		"tokashiki.okinawa.jp",
		"tomigusuku.okinawa.jp",
		"tonaki.okinawa.jp",
		"urasoe.okinawa.jp",
		"uruma.okinawa.jp",
		"yaese.okinawa.jp",
		"yomitan.okinawa.jp",
		"yonabaru.okinawa.jp",
		"yonaguni.okinawa.jp",
		"zamami.okinawa.jp",
		"abeno.osaka.jp",
		"chihayaakasaka.osaka.jp",
		"chuo.osaka.jp",
		"daito.osaka.jp",
		"fujiidera.osaka.jp",
		"habikino.osaka.jp",
		"hannan.osaka.jp",
		"higashiosaka.osaka.jp",
		"higashisumiyoshi.osaka.jp",
		"higashiyodogawa.osaka.jp",
		"hirakata.osaka.jp",
		"ibaraki.osaka.jp",
		"ikeda.osaka.jp",
		"izumi.osaka.jp",
		"izumiotsu.osaka.jp",
		"izumisano.osaka.jp",
		"kadoma.osaka.jp",
		"kaizuka.osaka.jp",
		"kanan.osaka.jp",
		"kashiwara.osaka.jp",
		"katano.osaka.jp",
		"kawachinagano.osaka.jp",
		"kishiwada.osaka.jp",
		"kita.osaka.jp",
		"kumatori.osaka.jp",
		"matsubara.osaka.jp",
		"minato.osaka.jp",
		"minoh.osaka.jp",
		"misaki.osaka.jp",
		"moriguchi.osaka.jp",
		"neyagawa.osaka.jp",
		"nishi.osaka.jp",
		"nose.osaka.jp",
		"osakasayama.osaka.jp",
		"sakai.osaka.jp",
		"sayama.osaka.jp",
		"sennan.osaka.jp",
		"settsu.osaka.jp",
		"shijonawate.osaka.jp",
		"shimamoto.osaka.jp",
		"suita.osaka.jp",
		"tadaoka.osaka.jp",
		"taishi.osaka.jp",
		"tajiri.osaka.jp",
		"takaishi.osaka.jp",
		"takatsuki.osaka.jp",
		"tondabayashi.osaka.jp",
		"toyonaka.osaka.jp",
		"toyono.osaka.jp",
		"yao.osaka.jp",
		"ariake.saga.jp",
		"arita.saga.jp",
		"fukudomi.saga.jp",
		"genkai.saga.jp",
		"hamatama.saga.jp",
		"hizen.saga.jp",
		"imari.saga.jp",
		"kamimine.saga.jp",
		"kanzaki.saga.jp",
		"karatsu.saga.jp",
		"kashima.saga.jp",
		"kitagata.saga.jp",
		"kitahata.saga.jp",
		"kiyama.saga.jp",
		"kouhoku.saga.jp",
		"kyuragi.saga.jp",
		"nishiarita.saga.jp",
		"ogi.saga.jp",
		"omachi.saga.jp",
		"ouchi.saga.jp",
		"saga.saga.jp",
		"shiroishi.saga.jp",
		"taku.saga.jp",
		"tara.saga.jp",
		"tosu.saga.jp",
		"yoshinogari.saga.jp",
		"arakawa.saitama.jp",
		"asaka.saitama.jp",
		"chichibu.saitama.jp",
		"fujimi.saitama.jp",
		"fujimino.saitama.jp",
		"fukaya.saitama.jp",
		"hanno.saitama.jp",
		"hanyu.saitama.jp",
		"hasuda.saitama.jp",
		"hatogaya.saitama.jp",
		"hatoyama.saitama.jp",
		"hidaka.saitama.jp",
		"higashichichibu.saitama.jp",
		"higashimatsuyama.saitama.jp",
		"honjo.saitama.jp",
		"ina.saitama.jp",
		"iruma.saitama.jp",
		"iwatsuki.saitama.jp",
		"kamiizumi.saitama.jp",
		"kamikawa.saitama.jp",
		"kamisato.saitama.jp",
		"kasukabe.saitama.jp",
		"kawagoe.saitama.jp",
		"kawaguchi.saitama.jp",
		"kawajima.saitama.jp",
		"kazo.saitama.jp",
		"kitamoto.saitama.jp",
		"koshigaya.saitama.jp",
		"kounosu.saitama.jp",
		"kuki.saitama.jp",
		"kumagaya.saitama.jp",
		"matsubushi.saitama.jp",
		"minano.saitama.jp",
		"misato.saitama.jp",
		"miyashiro.saitama.jp",
		"miyoshi.saitama.jp",
		"moroyama.saitama.jp",
		"nagatoro.saitama.jp",
		"namegawa.saitama.jp",
		"niiza.saitama.jp",
		"ogano.saitama.jp",
		"ogawa.saitama.jp",
		"ogose.saitama.jp",
		"okegawa.saitama.jp",
		"omiya.saitama.jp",
		"otaki.saitama.jp",
		"ranzan.saitama.jp",
		"ryokami.saitama.jp",
		"saitama.saitama.jp",
		"sakado.saitama.jp",
		"satte.saitama.jp",
		"sayama.saitama.jp",
		"shiki.saitama.jp",
		"shiraoka.saitama.jp",
		"soka.saitama.jp",
		"sugito.saitama.jp",
		"toda.saitama.jp",
		"tokigawa.saitama.jp",
		"tokorozawa.saitama.jp",
		"tsurugashima.saitama.jp",
		"urawa.saitama.jp",
		"warabi.saitama.jp",
		"yashio.saitama.jp",
		"yokoze.saitama.jp",
		"yono.saitama.jp",
		"yorii.saitama.jp",
		"yoshida.saitama.jp",
		"yoshikawa.saitama.jp",
		"yoshimi.saitama.jp",
		"aisho.shiga.jp",
		"gamo.shiga.jp",
		"higashiomi.shiga.jp",
		"hikone.shiga.jp",
		"koka.shiga.jp",
		"konan.shiga.jp",
		"kosei.shiga.jp",
		"koto.shiga.jp",
		"kusatsu.shiga.jp",
		"maibara.shiga.jp",
		"moriyama.shiga.jp",
		"nagahama.shiga.jp",
		"nishiazai.shiga.jp",
		"notogawa.shiga.jp",
		"omihachiman.shiga.jp",
		"otsu.shiga.jp",
		"ritto.shiga.jp",
		"ryuoh.shiga.jp",
		"takashima.shiga.jp",
		"takatsuki.shiga.jp",
		"torahime.shiga.jp",
		"toyosato.shiga.jp",
		"yasu.shiga.jp",
		"akagi.shimane.jp",
		"ama.shimane.jp",
		"gotsu.shimane.jp",
		"hamada.shimane.jp",
		"higashiizumo.shimane.jp",
		"hikawa.shimane.jp",
		"hikimi.shimane.jp",
		"izumo.shimane.jp",
		"kakinoki.shimane.jp",
		"masuda.shimane.jp",
		"matsue.shimane.jp",
		"misato.shimane.jp",
		"nishinoshima.shimane.jp",
		"ohda.shimane.jp",
		"okinoshima.shimane.jp",
		"okuizumo.shimane.jp",
		"shimane.shimane.jp",
		"tamayu.shimane.jp",
		"tsuwano.shimane.jp",
		"unnan.shimane.jp",
		"yakumo.shimane.jp",
		"yasugi.shimane.jp",
		"yatsuka.shimane.jp",
		"arai.shizuoka.jp",
		"atami.shizuoka.jp",
		"fuji.shizuoka.jp",
		"fujieda.shizuoka.jp",
		"fujikawa.shizuoka.jp",
		"fujinomiya.shizuoka.jp",
		"fukuroi.shizuoka.jp",
		"gotemba.shizuoka.jp",
		"haibara.shizuoka.jp",
		"hamamatsu.shizuoka.jp",
		"higashiizu.shizuoka.jp",
		"ito.shizuoka.jp",
		"iwata.shizuoka.jp",
		"izu.shizuoka.jp",
		"izunokuni.shizuoka.jp",
		"kakegawa.shizuoka.jp",
		"kannami.shizuoka.jp",
		"kawanehon.shizuoka.jp",
		"kawazu.shizuoka.jp",
		"kikugawa.shizuoka.jp",
		"kosai.shizuoka.jp",
		"makinohara.shizuoka.jp",
		"matsuzaki.shizuoka.jp",
		"minamiizu.shizuoka.jp",
		"mishima.shizuoka.jp",
		"morimachi.shizuoka.jp",
		"nishiizu.shizuoka.jp",
		"numazu.shizuoka.jp",
		"omaezaki.shizuoka.jp",
		"shimada.shizuoka.jp",
		"shimizu.shizuoka.jp",
		"shimoda.shizuoka.jp",
		"shizuoka.shizuoka.jp",
		"susono.shizuoka.jp",
		"yaizu.shizuoka.jp",
		"yoshida.shizuoka.jp",
		"ashikaga.tochigi.jp",
		"bato.tochigi.jp",
		"haga.tochigi.jp",
		"ichikai.tochigi.jp",
		"iwafune.tochigi.jp",
		"kaminokawa.tochigi.jp",
		"kanuma.tochigi.jp",
		"karasuyama.tochigi.jp",
		"kuroiso.tochigi.jp",
		"mashiko.tochigi.jp",
		"mibu.tochigi.jp",
		"moka.tochigi.jp",
		"motegi.tochigi.jp",
		"nasu.tochigi.jp",
		"nasushiobara.tochigi.jp",
		"nikko.tochigi.jp",
		"nishikata.tochigi.jp",
		"nogi.tochigi.jp",
		"ohira.tochigi.jp",
		"ohtawara.tochigi.jp",
		"oyama.tochigi.jp",
		"sakura.tochigi.jp",
		"sano.tochigi.jp",
		"shimotsuke.tochigi.jp",
		"shioya.tochigi.jp",
		"takanezawa.tochigi.jp",
		"tochigi.tochigi.jp",
		"tsuga.tochigi.jp",
		"ujiie.tochigi.jp",
		"utsunomiya.tochigi.jp",
		"yaita.tochigi.jp",
		"aizumi.tokushima.jp",
		"anan.tokushima.jp",
		"ichiba.tokushima.jp",
		"itano.tokushima.jp",
		"kainan.tokushima.jp",
		"komatsushima.tokushima.jp",
		"matsushige.tokushima.jp",
		"mima.tokushima.jp",
		"minami.tokushima.jp",
		"miyoshi.tokushima.jp",
		"mugi.tokushima.jp",
		"nakagawa.tokushima.jp",
		"naruto.tokushima.jp",
		"sanagochi.tokushima.jp",
		"shishikui.tokushima.jp",
		"tokushima.tokushima.jp",
		"wajiki.tokushima.jp",
		"adachi.tokyo.jp",
		"akiruno.tokyo.jp",
		"akishima.tokyo.jp",
		"aogashima.tokyo.jp",
		"arakawa.tokyo.jp",
		"bunkyo.tokyo.jp",
		"chiyoda.tokyo.jp",
		"chofu.tokyo.jp",
		"chuo.tokyo.jp",
		"edogawa.tokyo.jp",
		"fuchu.tokyo.jp",
		"fussa.tokyo.jp",
		"hachijo.tokyo.jp",
		"hachioji.tokyo.jp",
		"hamura.tokyo.jp",
		"higashikurume.tokyo.jp",
		"higashimurayama.tokyo.jp",
		"higashiyamato.tokyo.jp",
		"hino.tokyo.jp",
		"hinode.tokyo.jp",
		"hinohara.tokyo.jp",
		"inagi.tokyo.jp",
		"itabashi.tokyo.jp",
		"katsushika.tokyo.jp",
		"kita.tokyo.jp",
		"kiyose.tokyo.jp",
		"kodaira.tokyo.jp",
		"koganei.tokyo.jp",
		"kokubunji.tokyo.jp",
		"komae.tokyo.jp",
		"koto.tokyo.jp",
		"kouzushima.tokyo.jp",
		"kunitachi.tokyo.jp",
		"machida.tokyo.jp",
		"meguro.tokyo.jp",
		"minato.tokyo.jp",
		"mitaka.tokyo.jp",
		"mizuho.tokyo.jp",
		"musashimurayama.tokyo.jp",
		"musashino.tokyo.jp",
		"nakano.tokyo.jp",
		"nerima.tokyo.jp",
		"ogasawara.tokyo.jp",
		"okutama.tokyo.jp",
		"ome.tokyo.jp",
		"oshima.tokyo.jp",
		"ota.tokyo.jp",
		"setagaya.tokyo.jp",
		"shibuya.tokyo.jp",
		"shinagawa.tokyo.jp",
		"shinjuku.tokyo.jp",
		"suginami.tokyo.jp",
		"sumida.tokyo.jp",
		"tachikawa.tokyo.jp",
		"taito.tokyo.jp",
		"tama.tokyo.jp",
		"toshima.tokyo.jp",
		"chizu.tottori.jp",
		"hino.tottori.jp",
		"kawahara.tottori.jp",
		"koge.tottori.jp",
		"kotoura.tottori.jp",
		"misasa.tottori.jp",
		"nanbu.tottori.jp",
		"nichinan.tottori.jp",
		"sakaiminato.tottori.jp",
		"tottori.tottori.jp",
		"wakasa.tottori.jp",
		"yazu.tottori.jp",
		"yonago.tottori.jp",
		"asahi.toyama.jp",
		"fuchu.toyama.jp",
		"fukumitsu.toyama.jp",
		"funahashi.toyama.jp",
		"himi.toyama.jp",
		"imizu.toyama.jp",
		"inami.toyama.jp",
		"johana.toyama.jp",
		"kamiichi.toyama.jp",
		"kurobe.toyama.jp",
		"nakaniikawa.toyama.jp",
		"namerikawa.toyama.jp",
		"nanto.toyama.jp",
		"nyuzen.toyama.jp",
		"oyabe.toyama.jp",
		"taira.toyama.jp",
		"takaoka.toyama.jp",
		"tateyama.toyama.jp",
		"toga.toyama.jp",
		"tonami.toyama.jp",
		"toyama.toyama.jp",
		"unazuki.toyama.jp",
		"uozu.toyama.jp",
		"yamada.toyama.jp",
		"arida.wakayama.jp",
		"aridagawa.wakayama.jp",
		"gobo.wakayama.jp",
		"hashimoto.wakayama.jp",
		"hidaka.wakayama.jp",
		"hirogawa.wakayama.jp",
		"inami.wakayama.jp",
		"iwade.wakayama.jp",
		"kainan.wakayama.jp",
		"kamitonda.wakayama.jp",
		"katsuragi.wakayama.jp",
		"kimino.wakayama.jp",
		"kinokawa.wakayama.jp",
		"kitayama.wakayama.jp",
		"koya.wakayama.jp",
		"koza.wakayama.jp",
		"kozagawa.wakayama.jp",
		"kudoyama.wakayama.jp",
		"kushimoto.wakayama.jp",
		"mihama.wakayama.jp",
		"misato.wakayama.jp",
		"nachikatsuura.wakayama.jp",
		"shingu.wakayama.jp",
		"shirahama.wakayama.jp",
		"taiji.wakayama.jp",
		"tanabe.wakayama.jp",
		"wakayama.wakayama.jp",
		"yuasa.wakayama.jp",
		"yura.wakayama.jp",
		"asahi.yamagata.jp",
		"funagata.yamagata.jp",
		"higashine.yamagata.jp",
		"iide.yamagata.jp",
		"kahoku.yamagata.jp",
		"kaminoyama.yamagata.jp",
		"kaneyama.yamagata.jp",
		"kawanishi.yamagata.jp",
		"mamurogawa.yamagata.jp",
		"mikawa.yamagata.jp",
		"murayama.yamagata.jp",
		"nagai.yamagata.jp",
		"nakayama.yamagata.jp",
		"nanyo.yamagata.jp",
		"nishikawa.yamagata.jp",
		"obanazawa.yamagata.jp",
		"oe.yamagata.jp",
		"oguni.yamagata.jp",
		"ohkura.yamagata.jp",
		"oishida.yamagata.jp",
		"sagae.yamagata.jp",
		"sakata.yamagata.jp",
		"sakegawa.yamagata.jp",
		"shinjo.yamagata.jp",
		"shirataka.yamagata.jp",
		"shonai.yamagata.jp",
		"takahata.yamagata.jp",
		"tendo.yamagata.jp",
		"tozawa.yamagata.jp",
		"tsuruoka.yamagata.jp",
		"yamagata.yamagata.jp",
		"yamanobe.yamagata.jp",
		"yonezawa.yamagata.jp",
		"yuza.yamagata.jp",
		"abu.yamaguchi.jp",
		"hagi.yamaguchi.jp",
		"hikari.yamaguchi.jp",
		"hofu.yamaguchi.jp",
		"iwakuni.yamaguchi.jp",
		"kudamatsu.yamaguchi.jp",
		"mitou.yamaguchi.jp",
		"nagato.yamaguchi.jp",
		"oshima.yamaguchi.jp",
		"shimonoseki.yamaguchi.jp",
		"shunan.yamaguchi.jp",
		"tabuse.yamaguchi.jp",
		"tokuyama.yamaguchi.jp",
		"toyota.yamaguchi.jp",
		"ube.yamaguchi.jp",
		"yuu.yamaguchi.jp",
		"chuo.yamanashi.jp",
		"doshi.yamanashi.jp",
		"fuefuki.yamanashi.jp",
		"fujikawa.yamanashi.jp",
		"fujikawaguchiko.yamanashi.jp",
		"fujiyoshida.yamanashi.jp",
		"hayakawa.yamanashi.jp",
		"hokuto.yamanashi.jp",
		"ichikawamisato.yamanashi.jp",
		"kai.yamanashi.jp",
		"kofu.yamanashi.jp",
		"koshu.yamanashi.jp",
		"kosuge.yamanashi.jp",
		"minami-alps.yamanashi.jp",
		"minobu.yamanashi.jp",
		"nakamichi.yamanashi.jp",
		"nanbu.yamanashi.jp",
		"narusawa.yamanashi.jp",
		"nirasaki.yamanashi.jp",
		"nishikatsura.yamanashi.jp",
		"oshino.yamanashi.jp",
		"otsuki.yamanashi.jp",
		"showa.yamanashi.jp",
		"tabayama.yamanashi.jp",
		"tsuru.yamanashi.jp",
		"uenohara.yamanashi.jp",
		"yamanakako.yamanashi.jp",
		"yamanashi.yamanashi.jp",
		"ke",
		"ac.ke",
		"co.ke",
		"go.ke",
		"info.ke",
		"me.ke",
		"mobi.ke",
		"ne.ke",
		"or.ke",
		"sc.ke",
		"kg",
		"com.kg",
		"edu.kg",
		"gov.kg",
		"mil.kg",
		"net.kg",
		"org.kg",
		"*.kh",
		"ki",
		"biz.ki",
		"com.ki",
		"edu.ki",
		"gov.ki",
		"info.ki",
		"net.ki",
		"org.ki",
		"km",
		"ass.km",
		"com.km",
		"edu.km",
		"gov.km",
		"mil.km",
		"nom.km",
		"org.km",
		"prd.km",
		"tm.km",
		"asso.km",
		"coop.km",
		"gouv.km",
		"medecin.km",
		"notaires.km",
		"pharmaciens.km",
		"presse.km",
		"veterinaire.km",
		"kn",
		"edu.kn",
		"gov.kn",
		"net.kn",
		"org.kn",
		"kp",
		"com.kp",
		"edu.kp",
		"gov.kp",
		"org.kp",
		"rep.kp",
		"tra.kp",
		"kr",
		"ac.kr",
		"co.kr",
		"es.kr",
		"go.kr",
		"hs.kr",
		"kg.kr",
		"mil.kr",
		"ms.kr",
		"ne.kr",
		"or.kr",
		"pe.kr",
		"re.kr",
		"sc.kr",
		"busan.kr",
		"chungbuk.kr",
		"chungnam.kr",
		"daegu.kr",
		"daejeon.kr",
		"gangwon.kr",
		"gwangju.kr",
		"gyeongbuk.kr",
		"gyeonggi.kr",
		"gyeongnam.kr",
		"incheon.kr",
		"jeju.kr",
		"jeonbuk.kr",
		"jeonnam.kr",
		"seoul.kr",
		"ulsan.kr",
		"kw",
		"com.kw",
		"edu.kw",
		"emb.kw",
		"gov.kw",
		"ind.kw",
		"net.kw",
		"org.kw",
		"ky",
		"com.ky",
		"edu.ky",
		"net.ky",
		"org.ky",
		"kz",
		"com.kz",
		"edu.kz",
		"gov.kz",
		"mil.kz",
		"net.kz",
		"org.kz",
		"la",
		"com.la",
		"edu.la",
		"gov.la",
		"info.la",
		"int.la",
		"net.la",
		"org.la",
		"per.la",
		"lb",
		"com.lb",
		"edu.lb",
		"gov.lb",
		"net.lb",
		"org.lb",
		"lc",
		"co.lc",
		"com.lc",
		"edu.lc",
		"gov.lc",
		"net.lc",
		"org.lc",
		"li",
		"lk",
		"ac.lk",
		"assn.lk",
		"com.lk",
		"edu.lk",
		"gov.lk",
		"grp.lk",
		"hotel.lk",
		"int.lk",
		"ltd.lk",
		"net.lk",
		"ngo.lk",
		"org.lk",
		"sch.lk",
		"soc.lk",
		"web.lk",
		"lr",
		"com.lr",
		"edu.lr",
		"gov.lr",
		"net.lr",
		"org.lr",
		"ls",
		"ac.ls",
		"biz.ls",
		"co.ls",
		"edu.ls",
		"gov.ls",
		"info.ls",
		"net.ls",
		"org.ls",
		"sc.ls",
		"lt",
		"gov.lt",
		"lu",
		"lv",
		"asn.lv",
		"com.lv",
		"conf.lv",
		"edu.lv",
		"gov.lv",
		"id.lv",
		"mil.lv",
		"net.lv",
		"org.lv",
		"ly",
		"com.ly",
		"edu.ly",
		"gov.ly",
		"id.ly",
		"med.ly",
		"net.ly",
		"org.ly",
		"plc.ly",
		"sch.ly",
		"ma",
		"ac.ma",
		"co.ma",
		"gov.ma",
		"net.ma",
		"org.ma",
		"press.ma",
		"mc",
		"asso.mc",
		"tm.mc",
		"md",
		"me",
		"ac.me",
		"co.me",
		"edu.me",
		"gov.me",
		"its.me",
		"net.me",
		"org.me",
		"priv.me",
		"mg",
		"co.mg",
		"com.mg",
		"edu.mg",
		"gov.mg",
		"mil.mg",
		"nom.mg",
		"org.mg",
		"prd.mg",
		"mh",
		"mil",
		"mk",
		"com.mk",
		"edu.mk",
		"gov.mk",
		"inf.mk",
		"name.mk",
		"net.mk",
		"org.mk",
		"ml",
		"com.ml",
		"edu.ml",
		"gouv.ml",
		"gov.ml",
		"net.ml",
		"org.ml",
		"presse.ml",
		"*.mm",
		"mn",
		"edu.mn",
		"gov.mn",
		"org.mn",
		"mo",
		"com.mo",
		"edu.mo",
		"gov.mo",
		"net.mo",
		"org.mo",
		"mobi",
		"mp",
		"mq",
		"mr",
		"gov.mr",
		"ms",
		"com.ms",
		"edu.ms",
		"gov.ms",
		"net.ms",
		"org.ms",
		"mt",
		"com.mt",
		"edu.mt",
		"net.mt",
		"org.mt",
		"mu",
		"ac.mu",
		"co.mu",
		"com.mu",
		"gov.mu",
		"net.mu",
		"or.mu",
		"org.mu",
		"museum",
		"mv",
		"aero.mv",
		"biz.mv",
		"com.mv",
		"coop.mv",
		"edu.mv",
		"gov.mv",
		"info.mv",
		"int.mv",
		"mil.mv",
		"museum.mv",
		"name.mv",
		"net.mv",
		"org.mv",
		"pro.mv",
		"mw",
		"ac.mw",
		"biz.mw",
		"co.mw",
		"com.mw",
		"coop.mw",
		"edu.mw",
		"gov.mw",
		"int.mw",
		"net.mw",
		"org.mw",
		"mx",
		"com.mx",
		"edu.mx",
		"gob.mx",
		"net.mx",
		"org.mx",
		"my",
		"biz.my",
		"com.my",
		"edu.my",
		"gov.my",
		"mil.my",
		"name.my",
		"net.my",
		"org.my",
		"mz",
		"ac.mz",
		"adv.mz",
		"co.mz",
		"edu.mz",
		"gov.mz",
		"mil.mz",
		"net.mz",
		"org.mz",
		"na",
		"alt.na",
		"co.na",
		"com.na",
		"gov.na",
		"net.na",
		"org.na",
		"name",
		"nc",
		"asso.nc",
		"nom.nc",
		"ne",
		"net",
		"nf",
		"arts.nf",
		"com.nf",
		"firm.nf",
		"info.nf",
		"net.nf",
		"other.nf",
		"per.nf",
		"rec.nf",
		"store.nf",
		"web.nf",
		"ng",
		"com.ng",
		"edu.ng",
		"gov.ng",
		"i.ng",
		"mil.ng",
		"mobi.ng",
		"name.ng",
		"net.ng",
		"org.ng",
		"sch.ng",
		"ni",
		"ac.ni",
		"biz.ni",
		"co.ni",
		"com.ni",
		"edu.ni",
		"gob.ni",
		"in.ni",
		"info.ni",
		"int.ni",
		"mil.ni",
		"net.ni",
		"nom.ni",
		"org.ni",
		"web.ni",
		"nl",
		"no",
		"fhs.no",
		"folkebibl.no",
		"fylkesbibl.no",
		"idrett.no",
		"museum.no",
		"priv.no",
		"vgs.no",
		"dep.no",
		"herad.no",
		"kommune.no",
		"mil.no",
		"stat.no",
		"aa.no",
		"ah.no",
		"bu.no",
		"fm.no",
		"hl.no",
		"hm.no",
		"jan-mayen.no",
		"mr.no",
		"nl.no",
		"nt.no",
		"of.no",
		"ol.no",
		"oslo.no",
		"rl.no",
		"sf.no",
		"st.no",
		"svalbard.no",
		"tm.no",
		"tr.no",
		"va.no",
		"vf.no",
		"gs.aa.no",
		"gs.ah.no",
		"gs.bu.no",
		"gs.fm.no",
		"gs.hl.no",
		"gs.hm.no",
		"gs.jan-mayen.no",
		"gs.mr.no",
		"gs.nl.no",
		"gs.nt.no",
		"gs.of.no",
		"gs.ol.no",
		"gs.oslo.no",
		"gs.rl.no",
		"gs.sf.no",
		"gs.st.no",
		"gs.svalbard.no",
		"gs.tm.no",
		"gs.tr.no",
		"gs.va.no",
		"gs.vf.no",
		"akrehamn.no",
		"åkrehamn.no",
		"algard.no",
		"ålgård.no",
		"arna.no",
		"bronnoysund.no",
		"brønnøysund.no",
		"brumunddal.no",
		"bryne.no",
		"drobak.no",
		"drøbak.no",
		"egersund.no",
		"fetsund.no",
		"floro.no",
		"florø.no",
		"fredrikstad.no",
		"hokksund.no",
		"honefoss.no",
		"hønefoss.no",
		"jessheim.no",
		"jorpeland.no",
		"jørpeland.no",
		"kirkenes.no",
		"kopervik.no",
		"krokstadelva.no",
		"langevag.no",
		"langevåg.no",
		"leirvik.no",
		"mjondalen.no",
		"mjøndalen.no",
		"mo-i-rana.no",
		"mosjoen.no",
		"mosjøen.no",
		"nesoddtangen.no",
		"orkanger.no",
		"osoyro.no",
		"osøyro.no",
		"raholt.no",
		"råholt.no",
		"sandnessjoen.no",
		"sandnessjøen.no",
		"skedsmokorset.no",
		"slattum.no",
		"spjelkavik.no",
		"stathelle.no",
		"stavern.no",
		"stjordalshalsen.no",
		"stjørdalshalsen.no",
		"tananger.no",
		"tranby.no",
		"vossevangen.no",
		"aarborte.no",
		"aejrie.no",
		"afjord.no",
		"åfjord.no",
		"agdenes.no",
		"nes.akershus.no",
		"aknoluokta.no",
		"ákŋoluokta.no",
		"al.no",
		"ål.no",
		"alaheadju.no",
		"álaheadju.no",
		"alesund.no",
		"ålesund.no",
		"alstahaug.no",
		"alta.no",
		"áltá.no",
		"alvdal.no",
		"amli.no",
		"åmli.no",
		"amot.no",
		"åmot.no",
		"andasuolo.no",
		"andebu.no",
		"andoy.no",
		"andøy.no",
		"ardal.no",
		"årdal.no",
		"aremark.no",
		"arendal.no",
		"ås.no",
		"aseral.no",
		"åseral.no",
		"asker.no",
		"askim.no",
		"askoy.no",
		"askøy.no",
		"askvoll.no",
		"asnes.no",
		"åsnes.no",
		"audnedaln.no",
		"aukra.no",
		"aure.no",
		"aurland.no",
		"aurskog-holand.no",
		"aurskog-høland.no",
		"austevoll.no",
		"austrheim.no",
		"averoy.no",
		"averøy.no",
		"badaddja.no",
		"bådåddjå.no",
		"bærum.no",
		"bahcavuotna.no",
		"báhcavuotna.no",
		"bahccavuotna.no",
		"báhccavuotna.no",
		"baidar.no",
		"báidár.no",
		"bajddar.no",
		"bájddar.no",
		"balat.no",
		"bálát.no",
		"balestrand.no",
		"ballangen.no",
		"balsfjord.no",
		"bamble.no",
		"bardu.no",
		"barum.no",
		"batsfjord.no",
		"båtsfjord.no",
		"bearalvahki.no",
		"bearalváhki.no",
		"beardu.no",
		"beiarn.no",
		"berg.no",
		"bergen.no",
		"berlevag.no",
		"berlevåg.no",
		"bievat.no",
		"bievát.no",
		"bindal.no",
		"birkenes.no",
		"bjarkoy.no",
		"bjarkøy.no",
		"bjerkreim.no",
		"bjugn.no",
		"bodo.no",
		"bodø.no",
		"bokn.no",
		"bomlo.no",
		"bømlo.no",
		"bremanger.no",
		"bronnoy.no",
		"brønnøy.no",
		"budejju.no",
		"nes.buskerud.no",
		"bygland.no",
		"bykle.no",
		"cahcesuolo.no",
		"čáhcesuolo.no",
		"davvenjarga.no",
		"davvenjárga.no",
		"davvesiida.no",
		"deatnu.no",
		"dielddanuorri.no",
		"divtasvuodna.no",
		"divttasvuotna.no",
		"donna.no",
		"dønna.no",
		"dovre.no",
		"drammen.no",
		"drangedal.no",
		"dyroy.no",
		"dyrøy.no",
		"eid.no",
		"eidfjord.no",
		"eidsberg.no",
		"eidskog.no",
		"eidsvoll.no",
		"eigersund.no",
		"elverum.no",
		"enebakk.no",
		"engerdal.no",
		"etne.no",
		"etnedal.no",
		"evenassi.no",
		"evenášši.no",
		"evenes.no",
		"evje-og-hornnes.no",
		"farsund.no",
		"fauske.no",
		"fedje.no",
		"fet.no",
		"finnoy.no",
		"finnøy.no",
		"fitjar.no",
		"fjaler.no",
		"fjell.no",
		"fla.no",
		"flå.no",
		"flakstad.no",
		"flatanger.no",
		"flekkefjord.no",
		"flesberg.no",
		"flora.no",
		"folldal.no",
		"forde.no",
		"førde.no",
		"forsand.no",
		"fosnes.no",
		"fræna.no",
		"frana.no",
		"frei.no",
		"frogn.no",
		"froland.no",
		"frosta.no",
		"froya.no",
		"frøya.no",
		"fuoisku.no",
		"fuossko.no",
		"fusa.no",
		"fyresdal.no",
		"gaivuotna.no",
		"gáivuotna.no",
		"galsa.no",
		"gálsá.no",
		"gamvik.no",
		"gangaviika.no",
		"gáŋgaviika.no",
		"gaular.no",
		"gausdal.no",
		"giehtavuoatna.no",
		"gildeskal.no",
		"gildeskål.no",
		"giske.no",
		"gjemnes.no",
		"gjerdrum.no",
		"gjerstad.no",
		"gjesdal.no",
		"gjovik.no",
		"gjøvik.no",
		"gloppen.no",
		"gol.no",
		"gran.no",
		"grane.no",
		"granvin.no",
		"gratangen.no",
		"grimstad.no",
		"grong.no",
		"grue.no",
		"gulen.no",
		"guovdageaidnu.no",
		"ha.no",
		"hå.no",
		"habmer.no",
		"hábmer.no",
		"hadsel.no",
		"hægebostad.no",
		"hagebostad.no",
		"halden.no",
		"halsa.no",
		"hamar.no",
		"hamaroy.no",
		"hammarfeasta.no",
		"hámmárfeasta.no",
		"hammerfest.no",
		"hapmir.no",
		"hápmir.no",
		"haram.no",
		"hareid.no",
		"harstad.no",
		"hasvik.no",
		"hattfjelldal.no",
		"haugesund.no",
		"os.hedmark.no",
		"valer.hedmark.no",
		"våler.hedmark.no",
		"hemne.no",
		"hemnes.no",
		"hemsedal.no",
		"hitra.no",
		"hjartdal.no",
		"hjelmeland.no",
		"hobol.no",
		"hobøl.no",
		"hof.no",
		"hol.no",
		"hole.no",
		"holmestrand.no",
		"holtalen.no",
		"holtålen.no",
		"os.hordaland.no",
		"hornindal.no",
		"horten.no",
		"hoyanger.no",
		"høyanger.no",
		"hoylandet.no",
		"høylandet.no",
		"hurdal.no",
		"hurum.no",
		"hvaler.no",
		"hyllestad.no",
		"ibestad.no",
		"inderoy.no",
		"inderøy.no",
		"iveland.no",
		"ivgu.no",
		"jevnaker.no",
		"jolster.no",
		"jølster.no",
		"jondal.no",
		"kafjord.no",
		"kåfjord.no",
		"karasjohka.no",
		"kárášjohka.no",
		"karasjok.no",
		"karlsoy.no",
		"karmoy.no",
		"karmøy.no",
		"kautokeino.no",
		"klabu.no",
		"klæbu.no",
		"klepp.no",
		"kongsberg.no",
		"kongsvinger.no",
		"kraanghke.no",
		"kråanghke.no",
		"kragero.no",
		"kragerø.no",
		"kristiansand.no",
		"kristiansund.no",
		"krodsherad.no",
		"krødsherad.no",
		"kvæfjord.no",
		"kvænangen.no",
		"kvafjord.no",
		"kvalsund.no",
		"kvam.no",
		"kvanangen.no",
		"kvinesdal.no",
		"kvinnherad.no",
		"kviteseid.no",
		"kvitsoy.no",
		"kvitsøy.no",
		"laakesvuemie.no",
		"lærdal.no",
		"lahppi.no",
		"láhppi.no",
		"lardal.no",
		"larvik.no",
		"lavagis.no",
		"lavangen.no",
		"leangaviika.no",
		"leaŋgaviika.no",
		"lebesby.no",
		"leikanger.no",
		"leirfjord.no",
		"leka.no",
		"leksvik.no",
		"lenvik.no",
		"lerdal.no",
		"lesja.no",
		"levanger.no",
		"lier.no",
		"lierne.no",
		"lillehammer.no",
		"lillesand.no",
		"lindas.no",
		"lindås.no",
		"lindesnes.no",
		"loabat.no",
		"loabát.no",
		"lodingen.no",
		"lødingen.no",
		"lom.no",
		"loppa.no",
		"lorenskog.no",
		"lørenskog.no",
		"loten.no",
		"løten.no",
		"lund.no",
		"lunner.no",
		"luroy.no",
		"lurøy.no",
		"luster.no",
		"lyngdal.no",
		"lyngen.no",
		"malatvuopmi.no",
		"málatvuopmi.no",
		"malselv.no",
		"målselv.no",
		"malvik.no",
		"mandal.no",
		"marker.no",
		"marnardal.no",
		"masfjorden.no",
		"masoy.no",
		"måsøy.no",
		"matta-varjjat.no",
		"mátta-várjjat.no",
		"meland.no",
		"meldal.no",
		"melhus.no",
		"meloy.no",
		"meløy.no",
		"meraker.no",
		"meråker.no",
		"midsund.no",
		"midtre-gauldal.no",
		"moareke.no",
		"moåreke.no",
		"modalen.no",
		"modum.no",
		"molde.no",
		"heroy.more-og-romsdal.no",
		"sande.more-og-romsdal.no",
		"herøy.møre-og-romsdal.no",
		"sande.møre-og-romsdal.no",
		"moskenes.no",
		"moss.no",
		"mosvik.no",
		"muosat.no",
		"muosát.no",
		"naamesjevuemie.no",
		"nååmesjevuemie.no",
		"nærøy.no",
		"namdalseid.no",
		"namsos.no",
		"namsskogan.no",
		"nannestad.no",
		"naroy.no",
		"narviika.no",
		"narvik.no",
		"naustdal.no",
		"navuotna.no",
		"návuotna.no",
		"nedre-eiker.no",
		"nesna.no",
		"nesodden.no",
		"nesseby.no",
		"nesset.no",
		"nissedal.no",
		"nittedal.no",
		"nord-aurdal.no",
		"nord-fron.no",
		"nord-odal.no",
		"norddal.no",
		"nordkapp.no",
		"bo.nordland.no",
		"bø.nordland.no",
		"heroy.nordland.no",
		"herøy.nordland.no",
		"nordre-land.no",
		"nordreisa.no",
		"nore-og-uvdal.no",
		"notodden.no",
		"notteroy.no",
		"nøtterøy.no",
		"odda.no",
		"oksnes.no",
		"øksnes.no",
		"omasvuotna.no",
		"oppdal.no",
		"oppegard.no",
		"oppegård.no",
		"orkdal.no",
		"orland.no",
		"ørland.no",
		"orskog.no",
		"ørskog.no",
		"orsta.no",
		"ørsta.no",
		"osen.no",
		"osteroy.no",
		"osterøy.no",
		"valer.ostfold.no",
		"våler.østfold.no",
		"ostre-toten.no",
		"østre-toten.no",
		"overhalla.no",
		"ovre-eiker.no",
		"øvre-eiker.no",
		"oyer.no",
		"øyer.no",
		"oygarden.no",
		"øygarden.no",
		"oystre-slidre.no",
		"øystre-slidre.no",
		"porsanger.no",
		"porsangu.no",
		"porsáŋgu.no",
		"porsgrunn.no",
		"rade.no",
		"råde.no",
		"radoy.no",
		"radøy.no",
		"rælingen.no",
		"rahkkeravju.no",
		"ráhkkerávju.no",
		"raisa.no",
		"ráisa.no",
		"rakkestad.no",
		"ralingen.no",
		"rana.no",
		"randaberg.no",
		"rauma.no",
		"rendalen.no",
		"rennebu.no",
		"rennesoy.no",
		"rennesøy.no",
		"rindal.no",
		"ringebu.no",
		"ringerike.no",
		"ringsaker.no",
		"risor.no",
		"risør.no",
		"rissa.no",
		"roan.no",
		"rodoy.no",
		"rødøy.no",
		"rollag.no",
		"romsa.no",
		"romskog.no",
		"rømskog.no",
		"roros.no",
		"røros.no",
		"rost.no",
		"røst.no",
		"royken.no",
		"røyken.no",
		"royrvik.no",
		"røyrvik.no",
		"ruovat.no",
		"rygge.no",
		"salangen.no",
		"salat.no",
		"sálat.no",
		"sálát.no",
		"saltdal.no",
		"samnanger.no",
		"sandefjord.no",
		"sandnes.no",
		"sandoy.no",
		"sandøy.no",
		"sarpsborg.no",
		"sauda.no",
		"sauherad.no",
		"sel.no",
		"selbu.no",
		"selje.no",
		"seljord.no",
		"siellak.no",
		"sigdal.no",
		"siljan.no",
		"sirdal.no",
		"skanit.no",
		"skánit.no",
		"skanland.no",
		"skånland.no",
		"skaun.no",
		"skedsmo.no",
		"ski.no",
		"skien.no",
		"skierva.no",
		"skiervá.no",
		"skiptvet.no",
		"skjak.no",
		"skjåk.no",
		"skjervoy.no",
		"skjervøy.no",
		"skodje.no",
		"smola.no",
		"smøla.no",
		"snaase.no",
		"snåase.no",
		"snasa.no",
		"snåsa.no",
		"snillfjord.no",
		"snoasa.no",
		"sogndal.no",
		"sogne.no",
		"søgne.no",
		"sokndal.no",
		"sola.no",
		"solund.no",
		"somna.no",
		"sømna.no",
		"sondre-land.no",
		"søndre-land.no",
		"songdalen.no",
		"sor-aurdal.no",
		"sør-aurdal.no",
		"sor-fron.no",
		"sør-fron.no",
		"sor-odal.no",
		"sør-odal.no",
		"sor-varanger.no",
		"sør-varanger.no",
		"sorfold.no",
		"sørfold.no",
		"sorreisa.no",
		"sørreisa.no",
		"sortland.no",
		"sorum.no",
		"sørum.no",
		"spydeberg.no",
		"stange.no",
		"stavanger.no",
		"steigen.no",
		"steinkjer.no",
		"stjordal.no",
		"stjørdal.no",
		"stokke.no",
		"stor-elvdal.no",
		"stord.no",
		"stordal.no",
		"storfjord.no",
		"strand.no",
		"stranda.no",
		"stryn.no",
		"sula.no",
		"suldal.no",
		"sund.no",
		"sunndal.no",
		"surnadal.no",
		"sveio.no",
		"svelvik.no",
		"sykkylven.no",
		"tana.no",
		"bo.telemark.no",
		"bø.telemark.no",
		"time.no",
		"tingvoll.no",
		"tinn.no",
		"tjeldsund.no",
		"tjome.no",
		"tjøme.no",
		"tokke.no",
		"tolga.no",
		"tonsberg.no",
		"tønsberg.no",
		"torsken.no",
		"træna.no",
		"trana.no",
		"tranoy.no",
		"tranøy.no",
		"troandin.no",
		"trogstad.no",
		"trøgstad.no",
		"tromsa.no",
		"tromso.no",
		"tromsø.no",
		"trondheim.no",
		"trysil.no",
		"tvedestrand.no",
		"tydal.no",
		"tynset.no",
		"tysfjord.no",
		"tysnes.no",
		"tysvær.no",
		"tysvar.no",
		"ullensaker.no",
		"ullensvang.no",
		"ulvik.no",
		"unjarga.no",
		"unjárga.no",
		"utsira.no",
		"vaapste.no",
		"vadso.no",
		"vadsø.no",
		"værøy.no",
		"vaga.no",
		"vågå.no",
		"vagan.no",
		"vågan.no",
		"vagsoy.no",
		"vågsøy.no",
		"vaksdal.no",
		"valle.no",
		"vang.no",
		"vanylven.no",
		"vardo.no",
		"vardø.no",
		"varggat.no",
		"várggát.no",
		"varoy.no",
		"vefsn.no",
		"vega.no",
		"vegarshei.no",
		"vegårshei.no",
		"vennesla.no",
		"verdal.no",
		"verran.no",
		"vestby.no",
		"sande.vestfold.no",
		"vestnes.no",
		"vestre-slidre.no",
		"vestre-toten.no",
		"vestvagoy.no",
		"vestvågøy.no",
		"vevelstad.no",
		"vik.no",
		"vikna.no",
		"vindafjord.no",
		"voagat.no",
		"volda.no",
		"voss.no",
		"*.np",
		"nr",
		"biz.nr",
		"com.nr",
		"edu.nr",
		"gov.nr",
		"info.nr",
		"net.nr",
		"org.nr",
		"nu",
		"nz",
		"ac.nz",
		"co.nz",
		"cri.nz",
		"geek.nz",
		"gen.nz",
		"govt.nz",
		"health.nz",
		"iwi.nz",
		"kiwi.nz",
		"maori.nz",
		"māori.nz",
		"mil.nz",
		"net.nz",
		"org.nz",
		"parliament.nz",
		"school.nz",
		"om",
		"co.om",
		"com.om",
		"edu.om",
		"gov.om",
		"med.om",
		"museum.om",
		"net.om",
		"org.om",
		"pro.om",
		"onion",
		"org",
		"pa",
		"abo.pa",
		"ac.pa",
		"com.pa",
		"edu.pa",
		"gob.pa",
		"ing.pa",
		"med.pa",
		"net.pa",
		"nom.pa",
		"org.pa",
		"sld.pa",
		"pe",
		"com.pe",
		"edu.pe",
		"gob.pe",
		"mil.pe",
		"net.pe",
		"nom.pe",
		"org.pe",
		"pf",
		"com.pf",
		"edu.pf",
		"org.pf",
		"*.pg",
		"ph",
		"com.ph",
		"edu.ph",
		"gov.ph",
		"i.ph",
		"mil.ph",
		"net.ph",
		"ngo.ph",
		"org.ph",
		"pk",
		"ac.pk",
		"biz.pk",
		"com.pk",
		"edu.pk",
		"fam.pk",
		"gkp.pk",
		"gob.pk",
		"gog.pk",
		"gok.pk",
		"gon.pk",
		"gop.pk",
		"gos.pk",
		"gov.pk",
		"net.pk",
		"org.pk",
		"web.pk",
		"pl",
		"com.pl",
		"net.pl",
		"org.pl",
		"agro.pl",
		"aid.pl",
		"atm.pl",
		"auto.pl",
		"biz.pl",
		"edu.pl",
		"gmina.pl",
		"gsm.pl",
		"info.pl",
		"mail.pl",
		"media.pl",
		"miasta.pl",
		"mil.pl",
		"nieruchomosci.pl",
		"nom.pl",
		"pc.pl",
		"powiat.pl",
		"priv.pl",
		"realestate.pl",
		"rel.pl",
		"sex.pl",
		"shop.pl",
		"sklep.pl",
		"sos.pl",
		"szkola.pl",
		"targi.pl",
		"tm.pl",
		"tourism.pl",
		"travel.pl",
		"turystyka.pl",
		"gov.pl",
		"ap.gov.pl",
		"griw.gov.pl",
		"ic.gov.pl",
		"is.gov.pl",
		"kmpsp.gov.pl",
		"konsulat.gov.pl",
		"kppsp.gov.pl",
		"kwp.gov.pl",
		"kwpsp.gov.pl",
		"mup.gov.pl",
		"mw.gov.pl",
		"oia.gov.pl",
		"oirm.gov.pl",
		"oke.gov.pl",
		"oow.gov.pl",
		"oschr.gov.pl",
		"oum.gov.pl",
		"pa.gov.pl",
		"pinb.gov.pl",
		"piw.gov.pl",
		"po.gov.pl",
		"pr.gov.pl",
		"psp.gov.pl",
		"psse.gov.pl",
		"pup.gov.pl",
		"rzgw.gov.pl",
		"sa.gov.pl",
		"sdn.gov.pl",
		"sko.gov.pl",
		"so.gov.pl",
		"sr.gov.pl",
		"starostwo.gov.pl",
		"ug.gov.pl",
		"ugim.gov.pl",
		"um.gov.pl",
		"umig.gov.pl",
		"upow.gov.pl",
		"uppo.gov.pl",
		"us.gov.pl",
		"uw.gov.pl",
		"uzs.gov.pl",
		"wif.gov.pl",
		"wiih.gov.pl",
		"winb.gov.pl",
		"wios.gov.pl",
		"witd.gov.pl",
		"wiw.gov.pl",
		"wkz.gov.pl",
		"wsa.gov.pl",
		"wskr.gov.pl",
		"wsse.gov.pl",
		"wuoz.gov.pl",
		"wzmiuw.gov.pl",
		"zp.gov.pl",
		"zpisdn.gov.pl",
		"augustow.pl",
		"babia-gora.pl",
		"bedzin.pl",
		"beskidy.pl",
		"bialowieza.pl",
		"bialystok.pl",
		"bielawa.pl",
		"bieszczady.pl",
		"boleslawiec.pl",
		"bydgoszcz.pl",
		"bytom.pl",
		"cieszyn.pl",
		"czeladz.pl",
		"czest.pl",
		"dlugoleka.pl",
		"elblag.pl",
		"elk.pl",
		"glogow.pl",
		"gniezno.pl",
		"gorlice.pl",
		"grajewo.pl",
		"ilawa.pl",
		"jaworzno.pl",
		"jelenia-gora.pl",
		"jgora.pl",
		"kalisz.pl",
		"karpacz.pl",
		"kartuzy.pl",
		"kaszuby.pl",
		"katowice.pl",
		"kazimierz-dolny.pl",
		"kepno.pl",
		"ketrzyn.pl",
		"klodzko.pl",
		"kobierzyce.pl",
		"kolobrzeg.pl",
		"konin.pl",
		"konskowola.pl",
		"kutno.pl",
		"lapy.pl",
		"lebork.pl",
		"legnica.pl",
		"lezajsk.pl",
		"limanowa.pl",
		"lomza.pl",
		"lowicz.pl",
		"lubin.pl",
		"lukow.pl",
		"malbork.pl",
		"malopolska.pl",
		"mazowsze.pl",
		"mazury.pl",
		"mielec.pl",
		"mielno.pl",
		"mragowo.pl",
		"naklo.pl",
		"nowaruda.pl",
		"nysa.pl",
		"olawa.pl",
		"olecko.pl",
		"olkusz.pl",
		"olsztyn.pl",
		"opoczno.pl",
		"opole.pl",
		"ostroda.pl",
		"ostroleka.pl",
		"ostrowiec.pl",
		"ostrowwlkp.pl",
		"pila.pl",
		"pisz.pl",
		"podhale.pl",
		"podlasie.pl",
		"polkowice.pl",
		"pomorskie.pl",
		"pomorze.pl",
		"prochowice.pl",
		"pruszkow.pl",
		"przeworsk.pl",
		"pulawy.pl",
		"radom.pl",
		"rawa-maz.pl",
		"rybnik.pl",
		"rzeszow.pl",
		"sanok.pl",
		"sejny.pl",
		"skoczow.pl",
		"slask.pl",
		"slupsk.pl",
		"sosnowiec.pl",
		"stalowa-wola.pl",
		"starachowice.pl",
		"stargard.pl",
		"suwalki.pl",
		"swidnica.pl",
		"swiebodzin.pl",
		"swinoujscie.pl",
		"szczecin.pl",
		"szczytno.pl",
		"tarnobrzeg.pl",
		"tgory.pl",
		"turek.pl",
		"tychy.pl",
		"ustka.pl",
		"walbrzych.pl",
		"warmia.pl",
		"warszawa.pl",
		"waw.pl",
		"wegrow.pl",
		"wielun.pl",
		"wlocl.pl",
		"wloclawek.pl",
		"wodzislaw.pl",
		"wolomin.pl",
		"wroclaw.pl",
		"zachpomor.pl",
		"zagan.pl",
		"zarow.pl",
		"zgora.pl",
		"zgorzelec.pl",
		"pm",
		"pn",
		"co.pn",
		"edu.pn",
		"gov.pn",
		"net.pn",
		"org.pn",
		"post",
		"pr",
		"biz.pr",
		"com.pr",
		"edu.pr",
		"gov.pr",
		"info.pr",
		"isla.pr",
		"name.pr",
		"net.pr",
		"org.pr",
		"pro.pr",
		"ac.pr",
		"est.pr",
		"prof.pr",
		"pro",
		"aaa.pro",
		"aca.pro",
		"acct.pro",
		"avocat.pro",
		"bar.pro",
		"cpa.pro",
		"eng.pro",
		"jur.pro",
		"law.pro",
		"med.pro",
		"recht.pro",
		"ps",
		"com.ps",
		"edu.ps",
		"gov.ps",
		"net.ps",
		"org.ps",
		"plo.ps",
		"sec.ps",
		"pt",
		"com.pt",
		"edu.pt",
		"gov.pt",
		"int.pt",
		"net.pt",
		"nome.pt",
		"org.pt",
		"publ.pt",
		"pw",
		"belau.pw",
		"co.pw",
		"ed.pw",
		"go.pw",
		"or.pw",
		"py",
		"com.py",
		"coop.py",
		"edu.py",
		"gov.py",
		"mil.py",
		"net.py",
		"org.py",
		"qa",
		"com.qa",
		"edu.qa",
		"gov.qa",
		"mil.qa",
		"name.qa",
		"net.qa",
		"org.qa",
		"sch.qa",
		"re",
		"asso.re",
		"com.re",
		"ro",
		"arts.ro",
		"com.ro",
		"firm.ro",
		"info.ro",
		"nom.ro",
		"nt.ro",
		"org.ro",
		"rec.ro",
		"store.ro",
		"tm.ro",
		"www.ro",
		"rs",
		"ac.rs",
		"co.rs",
		"edu.rs",
		"gov.rs",
		"in.rs",
		"org.rs",
		"ru",
		"rw",
		"ac.rw",
		"co.rw",
		"coop.rw",
		"gov.rw",
		"mil.rw",
		"net.rw",
		"org.rw",
		"sa",
		"com.sa",
		"edu.sa",
		"gov.sa",
		"med.sa",
		"net.sa",
		"org.sa",
		"pub.sa",
		"sch.sa",
		"sb",
		"com.sb",
		"edu.sb",
		"gov.sb",
		"net.sb",
		"org.sb",
		"sc",
		"com.sc",
		"edu.sc",
		"gov.sc",
		"net.sc",
		"org.sc",
		"sd",
		"com.sd",
		"edu.sd",
		"gov.sd",
		"info.sd",
		"med.sd",
		"net.sd",
		"org.sd",
		"tv.sd",
		"se",
		"a.se",
		"ac.se",
		"b.se",
		"bd.se",
		"brand.se",
		"c.se",
		"d.se",
		"e.se",
		"f.se",
		"fh.se",
		"fhsk.se",
		"fhv.se",
		"g.se",
		"h.se",
		"i.se",
		"k.se",
		"komforb.se",
		"kommunalforbund.se",
		"komvux.se",
		"l.se",
		"lanbib.se",
		"m.se",
		"n.se",
		"naturbruksgymn.se",
		"o.se",
		"org.se",
		"p.se",
		"parti.se",
		"pp.se",
		"press.se",
		"r.se",
		"s.se",
		"t.se",
		"tm.se",
		"u.se",
		"w.se",
		"x.se",
		"y.se",
		"z.se",
		"sg",
		"com.sg",
		"edu.sg",
		"gov.sg",
		"net.sg",
		"org.sg",
		"sh",
		"com.sh",
		"gov.sh",
		"mil.sh",
		"net.sh",
		"org.sh",
		"si",
		"sj",
		"sk",
		"sl",
		"com.sl",
		"edu.sl",
		"gov.sl",
		"net.sl",
		"org.sl",
		"sm",
		"sn",
		"art.sn",
		"com.sn",
		"edu.sn",
		"gouv.sn",
		"org.sn",
		"perso.sn",
		"univ.sn",
		"so",
		"com.so",
		"edu.so",
		"gov.so",
		"me.so",
		"net.so",
		"org.so",
		"sr",
		"ss",
		"biz.ss",
		"co.ss",
		"com.ss",
		"edu.ss",
		"gov.ss",
		"me.ss",
		"net.ss",
		"org.ss",
		"sch.ss",
		"st",
		"co.st",
		"com.st",
		"consulado.st",
		"edu.st",
		"embaixada.st",
		"mil.st",
		"net.st",
		"org.st",
		"principe.st",
		"saotome.st",
		"store.st",
		"su",
		"sv",
		"com.sv",
		"edu.sv",
		"gob.sv",
		"org.sv",
		"red.sv",
		"sx",
		"gov.sx",
		"sy",
		"com.sy",
		"edu.sy",
		"gov.sy",
		"mil.sy",
		"net.sy",
		"org.sy",
		"sz",
		"ac.sz",
		"co.sz",
		"org.sz",
		"tc",
		"td",
		"tel",
		"tf",
		"tg",
		"th",
		"ac.th",
		"co.th",
		"go.th",
		"in.th",
		"mi.th",
		"net.th",
		"or.th",
		"tj",
		"ac.tj",
		"biz.tj",
		"co.tj",
		"com.tj",
		"edu.tj",
		"go.tj",
		"gov.tj",
		"int.tj",
		"mil.tj",
		"name.tj",
		"net.tj",
		"nic.tj",
		"org.tj",
		"test.tj",
		"web.tj",
		"tk",
		"tl",
		"gov.tl",
		"tm",
		"co.tm",
		"com.tm",
		"edu.tm",
		"gov.tm",
		"mil.tm",
		"net.tm",
		"nom.tm",
		"org.tm",
		"tn",
		"com.tn",
		"ens.tn",
		"fin.tn",
		"gov.tn",
		"ind.tn",
		"info.tn",
		"intl.tn",
		"mincom.tn",
		"nat.tn",
		"net.tn",
		"org.tn",
		"perso.tn",
		"tourism.tn",
		"to",
		"com.to",
		"edu.to",
		"gov.to",
		"mil.to",
		"net.to",
		"org.to",
		"tr",
		"av.tr",
		"bbs.tr",
		"bel.tr",
		"biz.tr",
		"com.tr",
		"dr.tr",
		"edu.tr",
		"gen.tr",
		"gov.tr",
		"info.tr",
		"k12.tr",
		"kep.tr",
		"mil.tr",
		"name.tr",
		"net.tr",
		"org.tr",
		"pol.tr",
		"tel.tr",
		"tsk.tr",
		"tv.tr",
		"web.tr",
		"nc.tr",
		"gov.nc.tr",
		"tt",
		"biz.tt",
		"co.tt",
		"com.tt",
		"edu.tt",
		"gov.tt",
		"info.tt",
		"mil.tt",
		"name.tt",
		"net.tt",
		"org.tt",
		"pro.tt",
		"tv",
		"tw",
		"club.tw",
		"com.tw",
		"ebiz.tw",
		"edu.tw",
		"game.tw",
		"gov.tw",
		"idv.tw",
		"mil.tw",
		"net.tw",
		"org.tw",
		"tz",
		"ac.tz",
		"co.tz",
		"go.tz",
		"hotel.tz",
		"info.tz",
		"me.tz",
		"mil.tz",
		"mobi.tz",
		"ne.tz",
		"or.tz",
		"sc.tz",
		"tv.tz",
		"ua",
		"com.ua",
		"edu.ua",
		"gov.ua",
		"in.ua",
		"net.ua",
		"org.ua",
		"cherkassy.ua",
		"cherkasy.ua",
		"chernigov.ua",
		"chernihiv.ua",
		"chernivtsi.ua",
		"chernovtsy.ua",
		"ck.ua",
		"cn.ua",
		"cr.ua",
		"crimea.ua",
		"cv.ua",
		"dn.ua",
		"dnepropetrovsk.ua",
		"dnipropetrovsk.ua",
		"donetsk.ua",
		"dp.ua",
		"if.ua",
		"ivano-frankivsk.ua",
		"kh.ua",
		"kharkiv.ua",
		"kharkov.ua",
		"kherson.ua",
		"khmelnitskiy.ua",
		"khmelnytskyi.ua",
		"kiev.ua",
		"kirovograd.ua",
		"km.ua",
		"kr.ua",
		"kropyvnytskyi.ua",
		"krym.ua",
		"ks.ua",
		"kv.ua",
		"kyiv.ua",
		"lg.ua",
		"lt.ua",
		"lugansk.ua",
		"luhansk.ua",
		"lutsk.ua",
		"lv.ua",
		"lviv.ua",
		"mk.ua",
		"mykolaiv.ua",
		"nikolaev.ua",
		"od.ua",
		"odesa.ua",
		"odessa.ua",
		"pl.ua",
		"poltava.ua",
		"rivne.ua",
		"rovno.ua",
		"rv.ua",
		"sb.ua",
		"sebastopol.ua",
		"sevastopol.ua",
		"sm.ua",
		"sumy.ua",
		"te.ua",
		"ternopil.ua",
		"uz.ua",
		"uzhgorod.ua",
		"uzhhorod.ua",
		"vinnica.ua",
		"vinnytsia.ua",
		"vn.ua",
		"volyn.ua",
		"yalta.ua",
		"zakarpattia.ua",
		"zaporizhzhe.ua",
		"zaporizhzhia.ua",
		"zhitomir.ua",
		"zhytomyr.ua",
		"zp.ua",
		"zt.ua",
		"ug",
		"ac.ug",
		"co.ug",
		"com.ug",
		"go.ug",
		"ne.ug",
		"or.ug",
		"org.ug",
		"sc.ug",
		"uk",
		"ac.uk",
		"co.uk",
		"gov.uk",
		"ltd.uk",
		"me.uk",
		"net.uk",
		"nhs.uk",
		"org.uk",
		"plc.uk",
		"police.uk",
		"*.sch.uk",
		"us",
		"dni.us",
		"fed.us",
		"isa.us",
		"kids.us",
		"nsn.us",
		"ak.us",
		"al.us",
		"ar.us",
		"as.us",
		"az.us",
		"ca.us",
		"co.us",
		"ct.us",
		"dc.us",
		"de.us",
		"fl.us",
		"ga.us",
		"gu.us",
		"hi.us",
		"ia.us",
		"id.us",
		"il.us",
		"in.us",
		"ks.us",
		"ky.us",
		"la.us",
		"ma.us",
		"md.us",
		"me.us",
		"mi.us",
		"mn.us",
		"mo.us",
		"ms.us",
		"mt.us",
		"nc.us",
		"nd.us",
		"ne.us",
		"nh.us",
		"nj.us",
		"nm.us",
		"nv.us",
		"ny.us",
		"oh.us",
		"ok.us",
		"or.us",
		"pa.us",
		"pr.us",
		"ri.us",
		"sc.us",
		"sd.us",
		"tn.us",
		"tx.us",
		"ut.us",
		"va.us",
		"vi.us",
		"vt.us",
		"wa.us",
		"wi.us",
		"wv.us",
		"wy.us",
		"k12.ak.us",
		"k12.al.us",
		"k12.ar.us",
		"k12.as.us",
		"k12.az.us",
		"k12.ca.us",
		"k12.co.us",
		"k12.ct.us",
		"k12.dc.us",
		"k12.fl.us",
		"k12.ga.us",
		"k12.gu.us",
		"k12.ia.us",
		"k12.id.us",
		"k12.il.us",
		"k12.in.us",
		"k12.ks.us",
		"k12.ky.us",
		"k12.la.us",
		"k12.ma.us",
		"k12.md.us",
		"k12.me.us",
		"k12.mi.us",
		"k12.mn.us",
		"k12.mo.us",
		"k12.ms.us",
		"k12.mt.us",
		"k12.nc.us",
		"k12.ne.us",
		"k12.nh.us",
		"k12.nj.us",
		"k12.nm.us",
		"k12.nv.us",
		"k12.ny.us",
		"k12.oh.us",
		"k12.ok.us",
		"k12.or.us",
		"k12.pa.us",
		"k12.pr.us",
		"k12.sc.us",
		"k12.tn.us",
		"k12.tx.us",
		"k12.ut.us",
		"k12.va.us",
		"k12.vi.us",
		"k12.vt.us",
		"k12.wa.us",
		"k12.wi.us",
		"cc.ak.us",
		"lib.ak.us",
		"cc.al.us",
		"lib.al.us",
		"cc.ar.us",
		"lib.ar.us",
		"cc.as.us",
		"lib.as.us",
		"cc.az.us",
		"lib.az.us",
		"cc.ca.us",
		"lib.ca.us",
		"cc.co.us",
		"lib.co.us",
		"cc.ct.us",
		"lib.ct.us",
		"cc.dc.us",
		"lib.dc.us",
		"cc.de.us",
		"cc.fl.us",
		"cc.ga.us",
		"cc.gu.us",
		"cc.hi.us",
		"cc.ia.us",
		"cc.id.us",
		"cc.il.us",
		"cc.in.us",
		"cc.ks.us",
		"cc.ky.us",
		"cc.la.us",
		"cc.ma.us",
		"cc.md.us",
		"cc.me.us",
		"cc.mi.us",
		"cc.mn.us",
		"cc.mo.us",
		"cc.ms.us",
		"cc.mt.us",
		"cc.nc.us",
		"cc.nd.us",
		"cc.ne.us",
		"cc.nh.us",
		"cc.nj.us",
		"cc.nm.us",
		"cc.nv.us",
		"cc.ny.us",
		"cc.oh.us",
		"cc.ok.us",
		"cc.or.us",
		"cc.pa.us",
		"cc.pr.us",
		"cc.ri.us",
		"cc.sc.us",
		"cc.sd.us",
		"cc.tn.us",
		"cc.tx.us",
		"cc.ut.us",
		"cc.va.us",
		"cc.vi.us",
		"cc.vt.us",
		"cc.wa.us",
		"cc.wi.us",
		"cc.wv.us",
		"cc.wy.us",
		"k12.wy.us",
		"lib.fl.us",
		"lib.ga.us",
		"lib.gu.us",
		"lib.hi.us",
		"lib.ia.us",
		"lib.id.us",
		"lib.il.us",
		"lib.in.us",
		"lib.ks.us",
		"lib.ky.us",
		"lib.la.us",
		"lib.ma.us",
		"lib.md.us",
		"lib.me.us",
		"lib.mi.us",
		"lib.mn.us",
		"lib.mo.us",
		"lib.ms.us",
		"lib.mt.us",
		"lib.nc.us",
		"lib.nd.us",
		"lib.ne.us",
		"lib.nh.us",
		"lib.nj.us",
		"lib.nm.us",
		"lib.nv.us",
		"lib.ny.us",
		"lib.oh.us",
		"lib.ok.us",
		"lib.or.us",
		"lib.pa.us",
		"lib.pr.us",
		"lib.ri.us",
		"lib.sc.us",
		"lib.sd.us",
		"lib.tn.us",
		"lib.tx.us",
		"lib.ut.us",
		"lib.va.us",
		"lib.vi.us",
		"lib.vt.us",
		"lib.wa.us",
		"lib.wi.us",
		"lib.wy.us",
		"chtr.k12.ma.us",
		"paroch.k12.ma.us",
		"pvt.k12.ma.us",
		"ann-arbor.mi.us",
		"cog.mi.us",
		"dst.mi.us",
		"eaton.mi.us",
		"gen.mi.us",
		"mus.mi.us",
		"tec.mi.us",
		"washtenaw.mi.us",
		"uy",
		"com.uy",
		"edu.uy",
		"gub.uy",
		"mil.uy",
		"net.uy",
		"org.uy",
		"uz",
		"co.uz",
		"com.uz",
		"net.uz",
		"org.uz",
		"va",
		"vc",
		"com.vc",
		"edu.vc",
		"gov.vc",
		"mil.vc",
		"net.vc",
		"org.vc",
		"ve",
		"arts.ve",
		"bib.ve",
		"co.ve",
		"com.ve",
		"e12.ve",
		"edu.ve",
		"firm.ve",
		"gob.ve",
		"gov.ve",
		"info.ve",
		"int.ve",
		"mil.ve",
		"net.ve",
		"nom.ve",
		"org.ve",
		"rar.ve",
		"rec.ve",
		"store.ve",
		"tec.ve",
		"web.ve",
		"vg",
		"vi",
		"co.vi",
		"com.vi",
		"k12.vi",
		"net.vi",
		"org.vi",
		"vn",
		"ac.vn",
		"ai.vn",
		"biz.vn",
		"com.vn",
		"edu.vn",
		"gov.vn",
		"health.vn",
		"id.vn",
		"info.vn",
		"int.vn",
		"io.vn",
		"name.vn",
		"net.vn",
		"org.vn",
		"pro.vn",
		"angiang.vn",
		"bacgiang.vn",
		"backan.vn",
		"baclieu.vn",
		"bacninh.vn",
		"baria-vungtau.vn",
		"bentre.vn",
		"binhdinh.vn",
		"binhduong.vn",
		"binhphuoc.vn",
		"binhthuan.vn",
		"camau.vn",
		"cantho.vn",
		"caobang.vn",
		"daklak.vn",
		"daknong.vn",
		"danang.vn",
		"dienbien.vn",
		"dongnai.vn",
		"dongthap.vn",
		"gialai.vn",
		"hagiang.vn",
		"haiduong.vn",
		"haiphong.vn",
		"hanam.vn",
		"hanoi.vn",
		"hatinh.vn",
		"haugiang.vn",
		"hoabinh.vn",
		"hungyen.vn",
		"khanhhoa.vn",
		"kiengiang.vn",
		"kontum.vn",
		"laichau.vn",
		"lamdong.vn",
		"langson.vn",
		"laocai.vn",
		"longan.vn",
		"namdinh.vn",
		"nghean.vn",
		"ninhbinh.vn",
		"ninhthuan.vn",
		"phutho.vn",
		"phuyen.vn",
		"quangbinh.vn",
		"quangnam.vn",
		"quangngai.vn",
		"quangninh.vn",
		"quangtri.vn",
		"soctrang.vn",
		"sonla.vn",
		"tayninh.vn",
		"thaibinh.vn",
		"thainguyen.vn",
		"thanhhoa.vn",
		"thanhphohochiminh.vn",
		"thuathienhue.vn",
		"tiengiang.vn",
		"travinh.vn",
		"tuyenquang.vn",
		"vinhlong.vn",
		"vinhphuc.vn",
		"yenbai.vn",
		"vu",
		"com.vu",
		"edu.vu",
		"net.vu",
		"org.vu",
		"wf",
		"ws",
		"com.ws",
		"edu.ws",
		"gov.ws",
		"net.ws",
		"org.ws",
		"yt",
		"امارات",
		"հայ",
		"বাংলা",
		"бг",
		"البحرين",
		"бел",
		"中国",
		"中國",
		"الجزائر",
		"مصر",
		"ею",
		"ευ",
		"موريتانيا",
		"გე",
		"ελ",
		"香港",
		"個人.香港",
		"公司.香港",
		"政府.香港",
		"教育.香港",
		"組織.香港",
		"網絡.香港",
		"ಭಾರತ",
		"ଭାରତ",
		"ভাৰত",
		"भारतम्",
		"भारोत",
		"ڀارت",
		"ഭാരതം",
		"भारत",
		"بارت",
		"بھارت",
		"భారత్",
		"ભારત",
		"ਭਾਰਤ",
		"ভারত",
		"இந்தியா",
		"ایران",
		"ايران",
		"عراق",
		"الاردن",
		"한국",
		"қаз",
		"ລາວ",
		"ලංකා",
		"இலங்கை",
		"المغرب",
		"мкд",
		"мон",
		"澳門",
		"澳门",
		"مليسيا",
		"عمان",
		"پاکستان",
		"پاكستان",
		"فلسطين",
		"срб",
		"ак.срб",
		"обр.срб",
		"од.срб",
		"орг.срб",
		"пр.срб",
		"упр.срб",
		"рф",
		"قطر",
		"السعودية",
		"السعودیة",
		"السعودیۃ",
		"السعوديه",
		"سودان",
		"新加坡",
		"சிங்கப்பூர்",
		"سورية",
		"سوريا",
		"ไทย",
		"ทหาร.ไทย",
		"ธุรกิจ.ไทย",
		"เน็ต.ไทย",
		"รัฐบาล.ไทย",
		"ศึกษา.ไทย",
		"องค์กร.ไทย",
		"تونس",
		"台灣",
		"台湾",
		"臺灣",
		"укр",
		"اليمن",
		"xxx",
		"ye",
		"com.ye",
		"edu.ye",
		"gov.ye",
		"mil.ye",
		"net.ye",
		"org.ye",
		"ac.za",
		"agric.za",
		"alt.za",
		"co.za",
		"edu.za",
		"gov.za",
		"grondar.za",
		"law.za",
		"mil.za",
		"net.za",
		"ngo.za",
		"nic.za",
		"nis.za",
		"nom.za",
		"org.za",
		"school.za",
		"tm.za",
		"web.za",
		"zm",
		"ac.zm",
		"biz.zm",
		"co.zm",
		"com.zm",
		"edu.zm",
		"gov.zm",
		"info.zm",
		"mil.zm",
		"net.zm",
		"org.zm",
		"sch.zm",
		"zw",
		"ac.zw",
		"co.zw",
		"gov.zw",
		"mil.zw",
		"org.zw",
		"aaa",
		"aarp",
		"abb",
		"abbott",
		"abbvie",
		"abc",
		"able",
		"abogado",
		"abudhabi",
		"academy",
		"accenture",
		"accountant",
		"accountants",
		"aco",
		"actor",
		"ads",
		"adult",
		"aeg",
		"aetna",
		"afl",
		"africa",
		"agakhan",
		"agency",
		"aig",
		"airbus",
		"airforce",
		"airtel",
		"akdn",
		"alibaba",
		"alipay",
		"allfinanz",
		"allstate",
		"ally",
		"alsace",
		"alstom",
		"amazon",
		"americanexpress",
		"americanfamily",
		"amex",
		"amfam",
		"amica",
		"amsterdam",
		"analytics",
		"android",
		"anquan",
		"anz",
		"aol",
		"apartments",
		"app",
		"apple",
		"aquarelle",
		"arab",
		"aramco",
		"archi",
		"army",
		"art",
		"arte",
		"asda",
		"associates",
		"athleta",
		"attorney",
		"auction",
		"audi",
		"audible",
		"audio",
		"auspost",
		"author",
		"auto",
		"autos",
		"aws",
		"axa",
		"azure",
		"baby",
		"baidu",
		"banamex",
		"band",
		"bank",
		"bar",
		"barcelona",
		"barclaycard",
		"barclays",
		"barefoot",
		"bargains",
		"baseball",
		"basketball",
		"bauhaus",
		"bayern",
		"bbc",
		"bbt",
		"bbva",
		"bcg",
		"bcn",
		"beats",
		"beauty",
		"beer",
		"bentley",
		"berlin",
		"best",
		"bestbuy",
		"bet",
		"bharti",
		"bible",
		"bid",
		"bike",
		"bing",
		"bingo",
		"bio",
		"black",
		"blackfriday",
		"blockbuster",
		"blog",
		"bloomberg",
		"blue",
		"bms",
		"bmw",
		"bnpparibas",
		"boats",
		"boehringer",
		"bofa",
		"bom",
		"bond",
		"boo",
		"book",
		"booking",
		"bosch",
		"bostik",
		"boston",
		"bot",
		"boutique",
		"box",
		"bradesco",
		"bridgestone",
		"broadway",
		"broker",
		"brother",
		"brussels",
		"build",
		"builders",
		"business",
		"buy",
		"buzz",
		"bzh",
		"cab",
		"cafe",
		"cal",
		"call",
		"calvinklein",
		"cam",
		"camera",
		"camp",
		"canon",
		"capetown",
		"capital",
		"capitalone",
		"car",
		"caravan",
		"cards",
		"care",
		"career",
		"careers",
		"cars",
		"casa",
		"case",
		"cash",
		"casino",
		"catering",
		"catholic",
		"cba",
		"cbn",
		"cbre",
		"center",
		"ceo",
		"cern",
		"cfa",
		"cfd",
		"chanel",
		"channel",
		"charity",
		"chase",
		"chat",
		"cheap",
		"chintai",
		"christmas",
		"chrome",
		"church",
		"cipriani",
		"circle",
		"cisco",
		"citadel",
		"citi",
		"citic",
		"city",
		"claims",
		"cleaning",
		"click",
		"clinic",
		"clinique",
		"clothing",
		"cloud",
		"club",
		"clubmed",
		"coach",
		"codes",
		"coffee",
		"college",
		"cologne",
		"commbank",
		"community",
		"company",
		"compare",
		"computer",
		"comsec",
		"condos",
		"construction",
		"consulting",
		"contact",
		"contractors",
		"cooking",
		"cool",
		"corsica",
		"country",
		"coupon",
		"coupons",
		"courses",
		"cpa",
		"credit",
		"creditcard",
		"creditunion",
		"cricket",
		"crown",
		"crs",
		"cruise",
		"cruises",
		"cuisinella",
		"cymru",
		"cyou",
		"dad",
		"dance",
		"data",
		"date",
		"dating",
		"datsun",
		"day",
		"dclk",
		"dds",
		"deal",
		"dealer",
		"deals",
		"degree",
		"delivery",
		"dell",
		"deloitte",
		"delta",
		"democrat",
		"dental",
		"dentist",
		"desi",
		"design",
		"dev",
		"dhl",
		"diamonds",
		"diet",
		"digital",
		"direct",
		"directory",
		"discount",
		"discover",
		"dish",
		"diy",
		"dnp",
		"docs",
		"doctor",
		"dog",
		"domains",
		"dot",
		"download",
		"drive",
		"dtv",
		"dubai",
		"dunlop",
		"dupont",
		"durban",
		"dvag",
		"dvr",
		"earth",
		"eat",
		"eco",
		"edeka",
		"education",
		"email",
		"emerck",
		"energy",
		"engineer",
		"engineering",
		"enterprises",
		"epson",
		"equipment",
		"ericsson",
		"erni",
		"esq",
		"estate",
		"eurovision",
		"eus",
		"events",
		"exchange",
		"expert",
		"exposed",
		"express",
		"extraspace",
		"fage",
		"fail",
		"fairwinds",
		"faith",
		"family",
		"fan",
		"fans",
		"farm",
		"farmers",
		"fashion",
		"fast",
		"fedex",
		"feedback",
		"ferrari",
		"ferrero",
		"fidelity",
		"fido",
		"film",
		"final",
		"finance",
		"financial",
		"fire",
		"firestone",
		"firmdale",
		"fish",
		"fishing",
		"fit",
		"fitness",
		"flickr",
		"flights",
		"flir",
		"florist",
		"flowers",
		"fly",
		"foo",
		"food",
		"football",
		"ford",
		"forex",
		"forsale",
		"forum",
		"foundation",
		"fox",
		"free",
		"fresenius",
		"frl",
		"frogans",
		"frontier",
		"ftr",
		"fujitsu",
		"fun",
		"fund",
		"furniture",
		"futbol",
		"fyi",
		"gal",
		"gallery",
		"gallo",
		"gallup",
		"game",
		"games",
		"gap",
		"garden",
		"gay",
		"gbiz",
		"gdn",
		"gea",
		"gent",
		"genting",
		"george",
		"ggee",
		"gift",
		"gifts",
		"gives",
		"giving",
		"glass",
		"gle",
		"global",
		"globo",
		"gmail",
		"gmbh",
		"gmo",
		"gmx",
		"godaddy",
		"gold",
		"goldpoint",
		"golf",
		"goo",
		"goodyear",
		"goog",
		"google",
		"gop",
		"got",
		"grainger",
		"graphics",
		"gratis",
		"green",
		"gripe",
		"grocery",
		"group",
		"gucci",
		"guge",
		"guide",
		"guitars",
		"guru",
		"hair",
		"hamburg",
		"hangout",
		"haus",
		"hbo",
		"hdfc",
		"hdfcbank",
		"health",
		"healthcare",
		"help",
		"helsinki",
		"here",
		"hermes",
		"hiphop",
		"hisamitsu",
		"hitachi",
		"hiv",
		"hkt",
		"hockey",
		"holdings",
		"holiday",
		"homedepot",
		"homegoods",
		"homes",
		"homesense",
		"honda",
		"horse",
		"hospital",
		"host",
		"hosting",
		"hot",
		"hotels",
		"hotmail",
		"house",
		"how",
		"hsbc",
		"hughes",
		"hyatt",
		"hyundai",
		"ibm",
		"icbc",
		"ice",
		"icu",
		"ieee",
		"ifm",
		"ikano",
		"imamat",
		"imdb",
		"immo",
		"immobilien",
		"inc",
		"industries",
		"infiniti",
		"ing",
		"ink",
		"institute",
		"insurance",
		"insure",
		"international",
		"intuit",
		"investments",
		"ipiranga",
		"irish",
		"ismaili",
		"ist",
		"istanbul",
		"itau",
		"itv",
		"jaguar",
		"java",
		"jcb",
		"jeep",
		"jetzt",
		"jewelry",
		"jio",
		"jll",
		"jmp",
		"jnj",
		"joburg",
		"jot",
		"joy",
		"jpmorgan",
		"jprs",
		"juegos",
		"juniper",
		"kaufen",
		"kddi",
		"kerryhotels",
		"kerrylogistics",
		"kerryproperties",
		"kfh",
		"kia",
		"kids",
		"kim",
		"kindle",
		"kitchen",
		"kiwi",
		"koeln",
		"komatsu",
		"kosher",
		"kpmg",
		"kpn",
		"krd",
		"kred",
		"kuokgroup",
		"kyoto",
		"lacaixa",
		"lamborghini",
		"lamer",
		"lancaster",
		"land",
		"landrover",
		"lanxess",
		"lasalle",
		"lat",
		"latino",
		"latrobe",
		"law",
		"lawyer",
		"lds",
		"lease",
		"leclerc",
		"lefrak",
		"legal",
		"lego",
		"lexus",
		"lgbt",
		"lidl",
		"life",
		"lifeinsurance",
		"lifestyle",
		"lighting",
		"like",
		"lilly",
		"limited",
		"limo",
		"lincoln",
		"link",
		"lipsy",
		"live",
		"living",
		"llc",
		"llp",
		"loan",
		"loans",
		"locker",
		"locus",
		"lol",
		"london",
		"lotte",
		"lotto",
		"love",
		"lpl",
		"lplfinancial",
		"ltd",
		"ltda",
		"lundbeck",
		"luxe",
		"luxury",
		"madrid",
		"maif",
		"maison",
		"makeup",
		"man",
		"management",
		"mango",
		"map",
		"market",
		"marketing",
		"markets",
		"marriott",
		"marshalls",
		"mattel",
		"mba",
		"mckinsey",
		"med",
		"media",
		"meet",
		"melbourne",
		"meme",
		"memorial",
		"men",
		"menu",
		"merck",
		"merckmsd",
		"miami",
		"microsoft",
		"mini",
		"mint",
		"mit",
		"mitsubishi",
		"mlb",
		"mls",
		"mma",
		"mobile",
		"moda",
		"moe",
		"moi",
		"mom",
		"monash",
		"money",
		"monster",
		"mormon",
		"mortgage",
		"moscow",
		"moto",
		"motorcycles",
		"mov",
		"movie",
		"msd",
		"mtn",
		"mtr",
		"music",
		"nab",
		"nagoya",
		"navy",
		"nba",
		"nec",
		"netbank",
		"netflix",
		"network",
		"neustar",
		"new",
		"news",
		"next",
		"nextdirect",
		"nexus",
		"nfl",
		"ngo",
		"nhk",
		"nico",
		"nike",
		"nikon",
		"ninja",
		"nissan",
		"nissay",
		"nokia",
		"norton",
		"now",
		"nowruz",
		"nowtv",
		"nra",
		"nrw",
		"ntt",
		"nyc",
		"obi",
		"observer",
		"office",
		"okinawa",
		"olayan",
		"olayangroup",
		"ollo",
		"omega",
		"one",
		"ong",
		"onl",
		"online",
		"ooo",
		"open",
		"oracle",
		"orange",
		"organic",
		"origins",
		"osaka",
		"otsuka",
		"ott",
		"ovh",
		"page",
		"panasonic",
		"paris",
		"pars",
		"partners",
		"parts",
		"party",
		"pay",
		"pccw",
		"pet",
		"pfizer",
		"pharmacy",
		"phd",
		"philips",
		"phone",
		"photo",
		"photography",
		"photos",
		"physio",
		"pics",
		"pictet",
		"pictures",
		"pid",
		"pin",
		"ping",
		"pink",
		"pioneer",
		"pizza",
		"place",
		"play",
		"playstation",
		"plumbing",
		"plus",
		"pnc",
		"pohl",
		"poker",
		"politie",
		"porn",
		"pramerica",
		"praxi",
		"press",
		"prime",
		"prod",
		"productions",
		"prof",
		"progressive",
		"promo",
		"properties",
		"property",
		"protection",
		"pru",
		"prudential",
		"pub",
		"pwc",
		"qpon",
		"quebec",
		"quest",
		"racing",
		"radio",
		"read",
		"realestate",
		"realtor",
		"realty",
		"recipes",
		"red",
		"redstone",
		"redumbrella",
		"rehab",
		"reise",
		"reisen",
		"reit",
		"reliance",
		"ren",
		"rent",
		"rentals",
		"repair",
		"report",
		"republican",
		"rest",
		"restaurant",
		"review",
		"reviews",
		"rexroth",
		"rich",
		"richardli",
		"ricoh",
		"ril",
		"rio",
		"rip",
		"rocks",
		"rodeo",
		"rogers",
		"room",
		"rsvp",
		"rugby",
		"ruhr",
		"run",
		"rwe",
		"ryukyu",
		"saarland",
		"safe",
		"safety",
		"sakura",
		"sale",
		"salon",
		"samsclub",
		"samsung",
		"sandvik",
		"sandvikcoromant",
		"sanofi",
		"sap",
		"sarl",
		"sas",
		"save",
		"saxo",
		"sbi",
		"sbs",
		"scb",
		"schaeffler",
		"schmidt",
		"scholarships",
		"school",
		"schule",
		"schwarz",
		"science",
		"scot",
		"search",
		"seat",
		"secure",
		"security",
		"seek",
		"select",
		"sener",
		"services",
		"seven",
		"sew",
		"sex",
		"sexy",
		"sfr",
		"shangrila",
		"sharp",
		"shell",
		"shia",
		"shiksha",
		"shoes",
		"shop",
		"shopping",
		"shouji",
		"show",
		"silk",
		"sina",
		"singles",
		"site",
		"ski",
		"skin",
		"sky",
		"skype",
		"sling",
		"smart",
		"smile",
		"sncf",
		"soccer",
		"social",
		"softbank",
		"software",
		"sohu",
		"solar",
		"solutions",
		"song",
		"sony",
		"soy",
		"spa",
		"space",
		"sport",
		"spot",
		"srl",
		"stada",
		"staples",
		"star",
		"statebank",
		"statefarm",
		"stc",
		"stcgroup",
		"stockholm",
		"storage",
		"store",
		"stream",
		"studio",
		"study",
		"style",
		"sucks",
		"supplies",
		"supply",
		"support",
		"surf",
		"surgery",
		"suzuki",
		"swatch",
		"swiss",
		"sydney",
		"systems",
		"tab",
		"taipei",
		"talk",
		"taobao",
		"target",
		"tatamotors",
		"tatar",
		"tattoo",
		"tax",
		"taxi",
		"tci",
		"tdk",
		"team",
		"tech",
		"technology",
		"temasek",
		"tennis",
		"teva",
		"thd",
		"theater",
		"theatre",
		"tiaa",
		"tickets",
		"tienda",
		"tips",
		"tires",
		"tirol",
		"tjmaxx",
		"tjx",
		"tkmaxx",
		"tmall",
		"today",
		"tokyo",
		"tools",
		"top",
		"toray",
		"toshiba",
		"total",
		"tours",
		"town",
		"toyota",
		"toys",
		"trade",
		"trading",
		"training",
		"travel",
		"travelers",
		"travelersinsurance",
		"trust",
		"trv",
		"tube",
		"tui",
		"tunes",
		"tushu",
		"tvs",
		"ubank",
		"ubs",
		"unicom",
		"university",
		"uno",
		"uol",
		"ups",
		"vacations",
		"vana",
		"vanguard",
		"vegas",
		"ventures",
		"verisign",
		"versicherung",
		"vet",
		"viajes",
		"video",
		"vig",
		"viking",
		"villas",
		"vin",
		"vip",
		"virgin",
		"visa",
		"vision",
		"viva",
		"vivo",
		"vlaanderen",
		"vodka",
		"volvo",
		"vote",
		"voting",
		"voto",
		"voyage",
		"wales",
		"walmart",
		"walter",
		"wang",
		"wanggou",
		"watch",
		"watches",
		"weather",
		"weatherchannel",
		"webcam",
		"weber",
		"website",
		"wed",
		"wedding",
		"weibo",
		"weir",
		"whoswho",
		"wien",
		"wiki",
		"williamhill",
		"win",
		"windows",
		"wine",
		"winners",
		"wme",
		"wolterskluwer",
		"woodside",
		"work",
		"works",
		"world",
		"wow",
		"wtc",
		"wtf",
		"xbox",
		"xerox",
		"xihuan",
		"xin",
		"कॉम",
		"セール",
		"佛山",
		"慈善",
		"集团",
		"在线",
		"点看",
		"คอม",
		"八卦",
		"موقع",
		"公益",
		"公司",
		"香格里拉",
		"网站",
		"移动",
		"我爱你",
		"москва",
		"католик",
		"онлайн",
		"сайт",
		"联通",
		"קום",
		"时尚",
		"微博",
		"淡马锡",
		"ファッション",
		"орг",
		"नेट",
		"ストア",
		"アマゾン",
		"삼성",
		"商标",
		"商店",
		"商城",
		"дети",
		"ポイント",
		"新闻",
		"家電",
		"كوم",
		"中文网",
		"中信",
		"娱乐",
		"谷歌",
		"電訊盈科",
		"购物",
		"クラウド",
		"通販",
		"网店",
		"संगठन",
		"餐厅",
		"网络",
		"ком",
		"亚马逊",
		"食品",
		"飞利浦",
		"手机",
		"ارامكو",
		"العليان",
		"بازار",
		"ابوظبي",
		"كاثوليك",
		"همراه",
		"닷컴",
		"政府",
		"شبكة",
		"بيتك",
		"عرب",
		"机构",
		"组织机构",
		"健康",
		"招聘",
		"рус",
		"大拿",
		"みんな",
		"グーグル",
		"世界",
		"書籍",
		"网址",
		"닷넷",
		"コム",
		"天主教",
		"游戏",
		"vermögensberater",
		"vermögensberatung",
		"企业",
		"信息",
		"嘉里大酒店",
		"嘉里",
		"广东",
		"政务",
		"xyz",
		"yachts",
		"yahoo",
		"yamaxun",
		"yandex",
		"yodobashi",
		"yoga",
		"yokohama",
		"you",
		"youtube",
		"yun",
		"zappos",
		"zara",
		"zero",
		"zip",
		"zone",
		"zuerich",
		"co.krd",
		"edu.krd",
		"art.pl",
		"gliwice.pl",
		"krakow.pl",
		"poznan.pl",
		"wroc.pl",
		"zakopane.pl",
		"lib.de.us",
		"12chars.dev",
		"12chars.it",
		"12chars.pro",
		"cc.ua",
		"inf.ua",
		"ltd.ua",
		"611.to",
		"a2hosted.com",
		"cpserver.com",
		"aaa.vodka",
		"*.on-acorn.io",
		"activetrail.biz",
		"adaptable.app",
		"adobeaemcloud.com",
		"*.dev.adobeaemcloud.com",
		"aem.live",
		"hlx.live",
		"adobeaemcloud.net",
		"aem.page",
		"hlx.page",
		"hlx3.page",
		"adobeio-static.net",
		"adobeioruntime.net",
		"africa.com",
		"beep.pl",
		"airkitapps.com",
		"airkitapps-au.com",
		"airkitapps.eu",
		"aivencloud.com",
		"akadns.net",
		"akamai.net",
		"akamai-staging.net",
		"akamaiedge.net",
		"akamaiedge-staging.net",
		"akamaihd.net",
		"akamaihd-staging.net",
		"akamaiorigin.net",
		"akamaiorigin-staging.net",
		"akamaized.net",
		"akamaized-staging.net",
		"edgekey.net",
		"edgekey-staging.net",
		"edgesuite.net",
		"edgesuite-staging.net",
		"barsy.ca",
		"*.compute.estate",
		"*.alces.network",
		"kasserver.com",
		"altervista.org",
		"alwaysdata.net",
		"myamaze.net",
		"execute-api.cn-north-1.amazonaws.com.cn",
		"execute-api.cn-northwest-1.amazonaws.com.cn",
		"execute-api.af-south-1.amazonaws.com",
		"execute-api.ap-east-1.amazonaws.com",
		"execute-api.ap-northeast-1.amazonaws.com",
		"execute-api.ap-northeast-2.amazonaws.com",
		"execute-api.ap-northeast-3.amazonaws.com",
		"execute-api.ap-south-1.amazonaws.com",
		"execute-api.ap-south-2.amazonaws.com",
		"execute-api.ap-southeast-1.amazonaws.com",
		"execute-api.ap-southeast-2.amazonaws.com",
		"execute-api.ap-southeast-3.amazonaws.com",
		"execute-api.ap-southeast-4.amazonaws.com",
		"execute-api.ap-southeast-5.amazonaws.com",
		"execute-api.ca-central-1.amazonaws.com",
		"execute-api.ca-west-1.amazonaws.com",
		"execute-api.eu-central-1.amazonaws.com",
		"execute-api.eu-central-2.amazonaws.com",
		"execute-api.eu-north-1.amazonaws.com",
		"execute-api.eu-south-1.amazonaws.com",
		"execute-api.eu-south-2.amazonaws.com",
		"execute-api.eu-west-1.amazonaws.com",
		"execute-api.eu-west-2.amazonaws.com",
		"execute-api.eu-west-3.amazonaws.com",
		"execute-api.il-central-1.amazonaws.com",
		"execute-api.me-central-1.amazonaws.com",
		"execute-api.me-south-1.amazonaws.com",
		"execute-api.sa-east-1.amazonaws.com",
		"execute-api.us-east-1.amazonaws.com",
		"execute-api.us-east-2.amazonaws.com",
		"execute-api.us-gov-east-1.amazonaws.com",
		"execute-api.us-gov-west-1.amazonaws.com",
		"execute-api.us-west-1.amazonaws.com",
		"execute-api.us-west-2.amazonaws.com",
		"cloudfront.net",
		"auth.af-south-1.amazoncognito.com",
		"auth.ap-east-1.amazoncognito.com",
		"auth.ap-northeast-1.amazoncognito.com",
		"auth.ap-northeast-2.amazoncognito.com",
		"auth.ap-northeast-3.amazoncognito.com",
		"auth.ap-south-1.amazoncognito.com",
		"auth.ap-south-2.amazoncognito.com",
		"auth.ap-southeast-1.amazoncognito.com",
		"auth.ap-southeast-2.amazoncognito.com",
		"auth.ap-southeast-3.amazoncognito.com",
		"auth.ap-southeast-4.amazoncognito.com",
		"auth.ca-central-1.amazoncognito.com",
		"auth.ca-west-1.amazoncognito.com",
		"auth.eu-central-1.amazoncognito.com",
		"auth.eu-central-2.amazoncognito.com",
		"auth.eu-north-1.amazoncognito.com",
		"auth.eu-south-1.amazoncognito.com",
		"auth.eu-south-2.amazoncognito.com",
		"auth.eu-west-1.amazoncognito.com",
		"auth.eu-west-2.amazoncognito.com",
		"auth.eu-west-3.amazoncognito.com",
		"auth.il-central-1.amazoncognito.com",
		"auth.me-central-1.amazoncognito.com",
		"auth.me-south-1.amazoncognito.com",
		"auth.sa-east-1.amazoncognito.com",
		"auth.us-east-1.amazoncognito.com",
		"auth-fips.us-east-1.amazoncognito.com",
		"auth.us-east-2.amazoncognito.com",
		"auth-fips.us-east-2.amazoncognito.com",
		"auth-fips.us-gov-west-1.amazoncognito.com",
		"auth.us-west-1.amazoncognito.com",
		"auth-fips.us-west-1.amazoncognito.com",
		"auth.us-west-2.amazoncognito.com",
		"auth-fips.us-west-2.amazoncognito.com",
		"*.compute.amazonaws.com.cn",
		"*.compute.amazonaws.com",
		"*.compute-1.amazonaws.com",
		"us-east-1.amazonaws.com",
		"emrappui-prod.cn-north-1.amazonaws.com.cn",
		"emrnotebooks-prod.cn-north-1.amazonaws.com.cn",
		"emrstudio-prod.cn-north-1.amazonaws.com.cn",
		"emrappui-prod.cn-northwest-1.amazonaws.com.cn",
		"emrnotebooks-prod.cn-northwest-1.amazonaws.com.cn",
		"emrstudio-prod.cn-northwest-1.amazonaws.com.cn",
		"emrappui-prod.af-south-1.amazonaws.com",
		"emrnotebooks-prod.af-south-1.amazonaws.com",
		"emrstudio-prod.af-south-1.amazonaws.com",
		"emrappui-prod.ap-east-1.amazonaws.com",
		"emrnotebooks-prod.ap-east-1.amazonaws.com",
		"emrstudio-prod.ap-east-1.amazonaws.com",
		"emrappui-prod.ap-northeast-1.amazonaws.com",
		"emrnotebooks-prod.ap-northeast-1.amazonaws.com",
		"emrstudio-prod.ap-northeast-1.amazonaws.com",
		"emrappui-prod.ap-northeast-2.amazonaws.com",
		"emrnotebooks-prod.ap-northeast-2.amazonaws.com",
		"emrstudio-prod.ap-northeast-2.amazonaws.com",
		"emrappui-prod.ap-northeast-3.amazonaws.com",
		"emrnotebooks-prod.ap-northeast-3.amazonaws.com",
		"emrstudio-prod.ap-northeast-3.amazonaws.com",
		"emrappui-prod.ap-south-1.amazonaws.com",
		"emrnotebooks-prod.ap-south-1.amazonaws.com",
		"emrstudio-prod.ap-south-1.amazonaws.com",
		"emrappui-prod.ap-south-2.amazonaws.com",
		"emrnotebooks-prod.ap-south-2.amazonaws.com",
		"emrstudio-prod.ap-south-2.amazonaws.com",
		"emrappui-prod.ap-southeast-1.amazonaws.com",
		"emrnotebooks-prod.ap-southeast-1.amazonaws.com",
		"emrstudio-prod.ap-southeast-1.amazonaws.com",
		"emrappui-prod.ap-southeast-2.amazonaws.com",
		"emrnotebooks-prod.ap-southeast-2.amazonaws.com",
		"emrstudio-prod.ap-southeast-2.amazonaws.com",
		"emrappui-prod.ap-southeast-3.amazonaws.com",
		"emrnotebooks-prod.ap-southeast-3.amazonaws.com",
		"emrstudio-prod.ap-southeast-3.amazonaws.com",
		"emrappui-prod.ap-southeast-4.amazonaws.com",
		"emrnotebooks-prod.ap-southeast-4.amazonaws.com",
		"emrstudio-prod.ap-southeast-4.amazonaws.com",
		"emrappui-prod.ca-central-1.amazonaws.com",
		"emrnotebooks-prod.ca-central-1.amazonaws.com",
		"emrstudio-prod.ca-central-1.amazonaws.com",
		"emrappui-prod.ca-west-1.amazonaws.com",
		"emrnotebooks-prod.ca-west-1.amazonaws.com",
		"emrstudio-prod.ca-west-1.amazonaws.com",
		"emrappui-prod.eu-central-1.amazonaws.com",
		"emrnotebooks-prod.eu-central-1.amazonaws.com",
		"emrstudio-prod.eu-central-1.amazonaws.com",
		"emrappui-prod.eu-central-2.amazonaws.com",
		"emrnotebooks-prod.eu-central-2.amazonaws.com",
		"emrstudio-prod.eu-central-2.amazonaws.com",
		"emrappui-prod.eu-north-1.amazonaws.com",
		"emrnotebooks-prod.eu-north-1.amazonaws.com",
		"emrstudio-prod.eu-north-1.amazonaws.com",
		"emrappui-prod.eu-south-1.amazonaws.com",
		"emrnotebooks-prod.eu-south-1.amazonaws.com",
		"emrstudio-prod.eu-south-1.amazonaws.com",
		"emrappui-prod.eu-south-2.amazonaws.com",
		"emrnotebooks-prod.eu-south-2.amazonaws.com",
		"emrstudio-prod.eu-south-2.amazonaws.com",
		"emrappui-prod.eu-west-1.amazonaws.com",
		"emrnotebooks-prod.eu-west-1.amazonaws.com",
		"emrstudio-prod.eu-west-1.amazonaws.com",
		"emrappui-prod.eu-west-2.amazonaws.com",
		"emrnotebooks-prod.eu-west-2.amazonaws.com",
		"emrstudio-prod.eu-west-2.amazonaws.com",
		"emrappui-prod.eu-west-3.amazonaws.com",
		"emrnotebooks-prod.eu-west-3.amazonaws.com",
		"emrstudio-prod.eu-west-3.amazonaws.com",
		"emrappui-prod.il-central-1.amazonaws.com",
		"emrnotebooks-prod.il-central-1.amazonaws.com",
		"emrstudio-prod.il-central-1.amazonaws.com",
		"emrappui-prod.me-central-1.amazonaws.com",
		"emrnotebooks-prod.me-central-1.amazonaws.com",
		"emrstudio-prod.me-central-1.amazonaws.com",
		"emrappui-prod.me-south-1.amazonaws.com",
		"emrnotebooks-prod.me-south-1.amazonaws.com",
		"emrstudio-prod.me-south-1.amazonaws.com",
		"emrappui-prod.sa-east-1.amazonaws.com",
		"emrnotebooks-prod.sa-east-1.amazonaws.com",
		"emrstudio-prod.sa-east-1.amazonaws.com",
		"emrappui-prod.us-east-1.amazonaws.com",
		"emrnotebooks-prod.us-east-1.amazonaws.com",
		"emrstudio-prod.us-east-1.amazonaws.com",
		"emrappui-prod.us-east-2.amazonaws.com",
		"emrnotebooks-prod.us-east-2.amazonaws.com",
		"emrstudio-prod.us-east-2.amazonaws.com",
		"emrappui-prod.us-gov-east-1.amazonaws.com",
		"emrnotebooks-prod.us-gov-east-1.amazonaws.com",
		"emrstudio-prod.us-gov-east-1.amazonaws.com",
		"emrappui-prod.us-gov-west-1.amazonaws.com",
		"emrnotebooks-prod.us-gov-west-1.amazonaws.com",
		"emrstudio-prod.us-gov-west-1.amazonaws.com",
		"emrappui-prod.us-west-1.amazonaws.com",
		"emrnotebooks-prod.us-west-1.amazonaws.com",
		"emrstudio-prod.us-west-1.amazonaws.com",
		"emrappui-prod.us-west-2.amazonaws.com",
		"emrnotebooks-prod.us-west-2.amazonaws.com",
		"emrstudio-prod.us-west-2.amazonaws.com",
		"*.cn-north-1.airflow.amazonaws.com.cn",
		"*.cn-northwest-1.airflow.amazonaws.com.cn",
		"*.af-south-1.airflow.amazonaws.com",
		"*.ap-east-1.airflow.amazonaws.com",
		"*.ap-northeast-1.airflow.amazonaws.com",
		"*.ap-northeast-2.airflow.amazonaws.com",
		"*.ap-northeast-3.airflow.amazonaws.com",
		"*.ap-south-1.airflow.amazonaws.com",
		"*.ap-south-2.airflow.amazonaws.com",
		"*.ap-southeast-1.airflow.amazonaws.com",
		"*.ap-southeast-2.airflow.amazonaws.com",
		"*.ap-southeast-3.airflow.amazonaws.com",
		"*.ap-southeast-4.airflow.amazonaws.com",
		"*.ca-central-1.airflow.amazonaws.com",
		"*.ca-west-1.airflow.amazonaws.com",
		"*.eu-central-1.airflow.amazonaws.com",
		"*.eu-central-2.airflow.amazonaws.com",
		"*.eu-north-1.airflow.amazonaws.com",
		"*.eu-south-1.airflow.amazonaws.com",
		"*.eu-south-2.airflow.amazonaws.com",
		"*.eu-west-1.airflow.amazonaws.com",
		"*.eu-west-2.airflow.amazonaws.com",
		"*.eu-west-3.airflow.amazonaws.com",
		"*.il-central-1.airflow.amazonaws.com",
		"*.me-central-1.airflow.amazonaws.com",
		"*.me-south-1.airflow.amazonaws.com",
		"*.sa-east-1.airflow.amazonaws.com",
		"*.us-east-1.airflow.amazonaws.com",
		"*.us-east-2.airflow.amazonaws.com",
		"*.us-west-1.airflow.amazonaws.com",
		"*.us-west-2.airflow.amazonaws.com",
		"s3.dualstack.cn-north-1.amazonaws.com.cn",
		"s3-accesspoint.dualstack.cn-north-1.amazonaws.com.cn",
		"s3-website.dualstack.cn-north-1.amazonaws.com.cn",
		"s3.cn-north-1.amazonaws.com.cn",
		"s3-accesspoint.cn-north-1.amazonaws.com.cn",
		"s3-deprecated.cn-north-1.amazonaws.com.cn",
		"s3-object-lambda.cn-north-1.amazonaws.com.cn",
		"s3-website.cn-north-1.amazonaws.com.cn",
		"s3.dualstack.cn-northwest-1.amazonaws.com.cn",
		"s3-accesspoint.dualstack.cn-northwest-1.amazonaws.com.cn",
		"s3.cn-northwest-1.amazonaws.com.cn",
		"s3-accesspoint.cn-northwest-1.amazonaws.com.cn",
		"s3-object-lambda.cn-northwest-1.amazonaws.com.cn",
		"s3-website.cn-northwest-1.amazonaws.com.cn",
		"s3.dualstack.af-south-1.amazonaws.com",
		"s3-accesspoint.dualstack.af-south-1.amazonaws.com",
		"s3-website.dualstack.af-south-1.amazonaws.com",
		"s3.af-south-1.amazonaws.com",
		"s3-accesspoint.af-south-1.amazonaws.com",
		"s3-object-lambda.af-south-1.amazonaws.com",
		"s3-website.af-south-1.amazonaws.com",
		"s3.dualstack.ap-east-1.amazonaws.com",
		"s3-accesspoint.dualstack.ap-east-1.amazonaws.com",
		"s3.ap-east-1.amazonaws.com",
		"s3-accesspoint.ap-east-1.amazonaws.com",
		"s3-object-lambda.ap-east-1.amazonaws.com",
		"s3-website.ap-east-1.amazonaws.com",
		"s3.dualstack.ap-northeast-1.amazonaws.com",
		"s3-accesspoint.dualstack.ap-northeast-1.amazonaws.com",
		"s3-website.dualstack.ap-northeast-1.amazonaws.com",
		"s3.ap-northeast-1.amazonaws.com",
		"s3-accesspoint.ap-northeast-1.amazonaws.com",
		"s3-object-lambda.ap-northeast-1.amazonaws.com",
		"s3-website.ap-northeast-1.amazonaws.com",
		"s3.dualstack.ap-northeast-2.amazonaws.com",
		"s3-accesspoint.dualstack.ap-northeast-2.amazonaws.com",
		"s3-website.dualstack.ap-northeast-2.amazonaws.com",
		"s3.ap-northeast-2.amazonaws.com",
		"s3-accesspoint.ap-northeast-2.amazonaws.com",
		"s3-object-lambda.ap-northeast-2.amazonaws.com",
		"s3-website.ap-northeast-2.amazonaws.com",
		"s3.dualstack.ap-northeast-3.amazonaws.com",
		"s3-accesspoint.dualstack.ap-northeast-3.amazonaws.com",
		"s3-website.dualstack.ap-northeast-3.amazonaws.com",
		"s3.ap-northeast-3.amazonaws.com",
		"s3-accesspoint.ap-northeast-3.amazonaws.com",
		"s3-object-lambda.ap-northeast-3.amazonaws.com",
		"s3-website.ap-northeast-3.amazonaws.com",
		"s3.dualstack.ap-south-1.amazonaws.com",
		"s3-accesspoint.dualstack.ap-south-1.amazonaws.com",
		"s3-website.dualstack.ap-south-1.amazonaws.com",
		"s3.ap-south-1.amazonaws.com",
		"s3-accesspoint.ap-south-1.amazonaws.com",
		"s3-object-lambda.ap-south-1.amazonaws.com",
		"s3-website.ap-south-1.amazonaws.com",
		"s3.dualstack.ap-south-2.amazonaws.com",
		"s3-accesspoint.dualstack.ap-south-2.amazonaws.com",
		"s3-website.dualstack.ap-south-2.amazonaws.com",
		"s3.ap-south-2.amazonaws.com",
		"s3-accesspoint.ap-south-2.amazonaws.com",
		"s3-object-lambda.ap-south-2.amazonaws.com",
		"s3-website.ap-south-2.amazonaws.com",
		"s3.dualstack.ap-southeast-1.amazonaws.com",
		"s3-accesspoint.dualstack.ap-southeast-1.amazonaws.com",
		"s3-website.dualstack.ap-southeast-1.amazonaws.com",
		"s3.ap-southeast-1.amazonaws.com",
		"s3-accesspoint.ap-southeast-1.amazonaws.com",
		"s3-object-lambda.ap-southeast-1.amazonaws.com",
		"s3-website.ap-southeast-1.amazonaws.com",
		"s3.dualstack.ap-southeast-2.amazonaws.com",
		"s3-accesspoint.dualstack.ap-southeast-2.amazonaws.com",
		"s3-website.dualstack.ap-southeast-2.amazonaws.com",
		"s3.ap-southeast-2.amazonaws.com",
		"s3-accesspoint.ap-southeast-2.amazonaws.com",
		"s3-object-lambda.ap-southeast-2.amazonaws.com",
		"s3-website.ap-southeast-2.amazonaws.com",
		"s3.dualstack.ap-southeast-3.amazonaws.com",
		"s3-accesspoint.dualstack.ap-southeast-3.amazonaws.com",
		"s3-website.dualstack.ap-southeast-3.amazonaws.com",
		"s3.ap-southeast-3.amazonaws.com",
		"s3-accesspoint.ap-southeast-3.amazonaws.com",
		"s3-object-lambda.ap-southeast-3.amazonaws.com",
		"s3-website.ap-southeast-3.amazonaws.com",
		"s3.dualstack.ap-southeast-4.amazonaws.com",
		"s3-accesspoint.dualstack.ap-southeast-4.amazonaws.com",
		"s3-website.dualstack.ap-southeast-4.amazonaws.com",
		"s3.ap-southeast-4.amazonaws.com",
		"s3-accesspoint.ap-southeast-4.amazonaws.com",
		"s3-object-lambda.ap-southeast-4.amazonaws.com",
		"s3-website.ap-southeast-4.amazonaws.com",
		"s3.dualstack.ap-southeast-5.amazonaws.com",
		"s3-accesspoint.dualstack.ap-southeast-5.amazonaws.com",
		"s3-website.dualstack.ap-southeast-5.amazonaws.com",
		"s3.ap-southeast-5.amazonaws.com",
		"s3-accesspoint.ap-southeast-5.amazonaws.com",
		"s3-deprecated.ap-southeast-5.amazonaws.com",
		"s3-object-lambda.ap-southeast-5.amazonaws.com",
		"s3-website.ap-southeast-5.amazonaws.com",
		"s3.dualstack.ca-central-1.amazonaws.com",
		"s3-accesspoint.dualstack.ca-central-1.amazonaws.com",
		"s3-accesspoint-fips.dualstack.ca-central-1.amazonaws.com",
		"s3-fips.dualstack.ca-central-1.amazonaws.com",
		"s3-website.dualstack.ca-central-1.amazonaws.com",
		"s3.ca-central-1.amazonaws.com",
		"s3-accesspoint.ca-central-1.amazonaws.com",
		"s3-accesspoint-fips.ca-central-1.amazonaws.com",
		"s3-fips.ca-central-1.amazonaws.com",
		"s3-object-lambda.ca-central-1.amazonaws.com",
		"s3-website.ca-central-1.amazonaws.com",
		"s3.dualstack.ca-west-1.amazonaws.com",
		"s3-accesspoint.dualstack.ca-west-1.amazonaws.com",
		"s3-accesspoint-fips.dualstack.ca-west-1.amazonaws.com",
		"s3-fips.dualstack.ca-west-1.amazonaws.com",
		"s3-website.dualstack.ca-west-1.amazonaws.com",
		"s3.ca-west-1.amazonaws.com",
		"s3-accesspoint.ca-west-1.amazonaws.com",
		"s3-accesspoint-fips.ca-west-1.amazonaws.com",
		"s3-fips.ca-west-1.amazonaws.com",
		"s3-object-lambda.ca-west-1.amazonaws.com",
		"s3-website.ca-west-1.amazonaws.com",
		"s3.dualstack.eu-central-1.amazonaws.com",
		"s3-accesspoint.dualstack.eu-central-1.amazonaws.com",
		"s3-website.dualstack.eu-central-1.amazonaws.com",
		"s3.eu-central-1.amazonaws.com",
		"s3-accesspoint.eu-central-1.amazonaws.com",
		"s3-object-lambda.eu-central-1.amazonaws.com",
		"s3-website.eu-central-1.amazonaws.com",
		"s3.dualstack.eu-central-2.amazonaws.com",
		"s3-accesspoint.dualstack.eu-central-2.amazonaws.com",
		"s3-website.dualstack.eu-central-2.amazonaws.com",
		"s3.eu-central-2.amazonaws.com",
		"s3-accesspoint.eu-central-2.amazonaws.com",
		"s3-object-lambda.eu-central-2.amazonaws.com",
		"s3-website.eu-central-2.amazonaws.com",
		"s3.dualstack.eu-north-1.amazonaws.com",
		"s3-accesspoint.dualstack.eu-north-1.amazonaws.com",
		"s3.eu-north-1.amazonaws.com",
		"s3-accesspoint.eu-north-1.amazonaws.com",
		"s3-object-lambda.eu-north-1.amazonaws.com",
		"s3-website.eu-north-1.amazonaws.com",
		"s3.dualstack.eu-south-1.amazonaws.com",
		"s3-accesspoint.dualstack.eu-south-1.amazonaws.com",
		"s3-website.dualstack.eu-south-1.amazonaws.com",
		"s3.eu-south-1.amazonaws.com",
		"s3-accesspoint.eu-south-1.amazonaws.com",
		"s3-object-lambda.eu-south-1.amazonaws.com",
		"s3-website.eu-south-1.amazonaws.com",
		"s3.dualstack.eu-south-2.amazonaws.com",
		"s3-accesspoint.dualstack.eu-south-2.amazonaws.com",
		"s3-website.dualstack.eu-south-2.amazonaws.com",
		"s3.eu-south-2.amazonaws.com",
		"s3-accesspoint.eu-south-2.amazonaws.com",
		"s3-object-lambda.eu-south-2.amazonaws.com",
		"s3-website.eu-south-2.amazonaws.com",
		"s3.dualstack.eu-west-1.amazonaws.com",
		"s3-accesspoint.dualstack.eu-west-1.amazonaws.com",
		"s3-website.dualstack.eu-west-1.amazonaws.com",
		"s3.eu-west-1.amazonaws.com",
		"s3-accesspoint.eu-west-1.amazonaws.com",
		"s3-deprecated.eu-west-1.amazonaws.com",
		"s3-object-lambda.eu-west-1.amazonaws.com",
		"s3-website.eu-west-1.amazonaws.com",
		"s3.dualstack.eu-west-2.amazonaws.com",
		"s3-accesspoint.dualstack.eu-west-2.amazonaws.com",
		"s3.eu-west-2.amazonaws.com",
		"s3-accesspoint.eu-west-2.amazonaws.com",
		"s3-object-lambda.eu-west-2.amazonaws.com",
		"s3-website.eu-west-2.amazonaws.com",
		"s3.dualstack.eu-west-3.amazonaws.com",
		"s3-accesspoint.dualstack.eu-west-3.amazonaws.com",
		"s3-website.dualstack.eu-west-3.amazonaws.com",
		"s3.eu-west-3.amazonaws.com",
		"s3-accesspoint.eu-west-3.amazonaws.com",
		"s3-object-lambda.eu-west-3.amazonaws.com",
		"s3-website.eu-west-3.amazonaws.com",
		"s3.dualstack.il-central-1.amazonaws.com",
		"s3-accesspoint.dualstack.il-central-1.amazonaws.com",
		"s3-website.dualstack.il-central-1.amazonaws.com",
		"s3.il-central-1.amazonaws.com",
		"s3-accesspoint.il-central-1.amazonaws.com",
		"s3-object-lambda.il-central-1.amazonaws.com",
		"s3-website.il-central-1.amazonaws.com",
		"s3.dualstack.me-central-1.amazonaws.com",
		"s3-accesspoint.dualstack.me-central-1.amazonaws.com",
		"s3-website.dualstack.me-central-1.amazonaws.com",
		"s3.me-central-1.amazonaws.com",
		"s3-accesspoint.me-central-1.amazonaws.com",
		"s3-object-lambda.me-central-1.amazonaws.com",
		"s3-website.me-central-1.amazonaws.com",
		"s3.dualstack.me-south-1.amazonaws.com",
		"s3-accesspoint.dualstack.me-south-1.amazonaws.com",
		"s3.me-south-1.amazonaws.com",
		"s3-accesspoint.me-south-1.amazonaws.com",
		"s3-object-lambda.me-south-1.amazonaws.com",
		"s3-website.me-south-1.amazonaws.com",
		"s3.amazonaws.com",
		"s3-1.amazonaws.com",
		"s3-ap-east-1.amazonaws.com",
		"s3-ap-northeast-1.amazonaws.com",
		"s3-ap-northeast-2.amazonaws.com",
		"s3-ap-northeast-3.amazonaws.com",
		"s3-ap-south-1.amazonaws.com",
		"s3-ap-southeast-1.amazonaws.com",
		"s3-ap-southeast-2.amazonaws.com",
		"s3-ca-central-1.amazonaws.com",
		"s3-eu-central-1.amazonaws.com",
		"s3-eu-north-1.amazonaws.com",
		"s3-eu-west-1.amazonaws.com",
		"s3-eu-west-2.amazonaws.com",
		"s3-eu-west-3.amazonaws.com",
		"s3-external-1.amazonaws.com",
		"s3-fips-us-gov-east-1.amazonaws.com",
		"s3-fips-us-gov-west-1.amazonaws.com",
		"mrap.accesspoint.s3-global.amazonaws.com",
		"s3-me-south-1.amazonaws.com",
		"s3-sa-east-1.amazonaws.com",
		"s3-us-east-2.amazonaws.com",
		"s3-us-gov-east-1.amazonaws.com",
		"s3-us-gov-west-1.amazonaws.com",
		"s3-us-west-1.amazonaws.com",
		"s3-us-west-2.amazonaws.com",
		"s3-website-ap-northeast-1.amazonaws.com",
		"s3-website-ap-southeast-1.amazonaws.com",
		"s3-website-ap-southeast-2.amazonaws.com",
		"s3-website-eu-west-1.amazonaws.com",
		"s3-website-sa-east-1.amazonaws.com",
		"s3-website-us-east-1.amazonaws.com",
		"s3-website-us-gov-west-1.amazonaws.com",
		"s3-website-us-west-1.amazonaws.com",
		"s3-website-us-west-2.amazonaws.com",
		"s3.dualstack.sa-east-1.amazonaws.com",
		"s3-accesspoint.dualstack.sa-east-1.amazonaws.com",
		"s3-website.dualstack.sa-east-1.amazonaws.com",
		"s3.sa-east-1.amazonaws.com",
		"s3-accesspoint.sa-east-1.amazonaws.com",
		"s3-object-lambda.sa-east-1.amazonaws.com",
		"s3-website.sa-east-1.amazonaws.com",
		"s3.dualstack.us-east-1.amazonaws.com",
		"s3-accesspoint.dualstack.us-east-1.amazonaws.com",
		"s3-accesspoint-fips.dualstack.us-east-1.amazonaws.com",
		"s3-fips.dualstack.us-east-1.amazonaws.com",
		"s3-website.dualstack.us-east-1.amazonaws.com",
		"s3.us-east-1.amazonaws.com",
		"s3-accesspoint.us-east-1.amazonaws.com",
		"s3-accesspoint-fips.us-east-1.amazonaws.com",
		"s3-deprecated.us-east-1.amazonaws.com",
		"s3-fips.us-east-1.amazonaws.com",
		"s3-object-lambda.us-east-1.amazonaws.com",
		"s3-website.us-east-1.amazonaws.com",
		"s3.dualstack.us-east-2.amazonaws.com",
		"s3-accesspoint.dualstack.us-east-2.amazonaws.com",
		"s3-accesspoint-fips.dualstack.us-east-2.amazonaws.com",
		"s3-fips.dualstack.us-east-2.amazonaws.com",
		"s3-website.dualstack.us-east-2.amazonaws.com",
		"s3.us-east-2.amazonaws.com",
		"s3-accesspoint.us-east-2.amazonaws.com",
		"s3-accesspoint-fips.us-east-2.amazonaws.com",
		"s3-deprecated.us-east-2.amazonaws.com",
		"s3-fips.us-east-2.amazonaws.com",
		"s3-object-lambda.us-east-2.amazonaws.com",
		"s3-website.us-east-2.amazonaws.com",
		"s3.dualstack.us-gov-east-1.amazonaws.com",
		"s3-accesspoint.dualstack.us-gov-east-1.amazonaws.com",
		"s3-accesspoint-fips.dualstack.us-gov-east-1.amazonaws.com",
		"s3-fips.dualstack.us-gov-east-1.amazonaws.com",
		"s3.us-gov-east-1.amazonaws.com",
		"s3-accesspoint.us-gov-east-1.amazonaws.com",
		"s3-accesspoint-fips.us-gov-east-1.amazonaws.com",
		"s3-fips.us-gov-east-1.amazonaws.com",
		"s3-object-lambda.us-gov-east-1.amazonaws.com",
		"s3-website.us-gov-east-1.amazonaws.com",
		"s3.dualstack.us-gov-west-1.amazonaws.com",
		"s3-accesspoint.dualstack.us-gov-west-1.amazonaws.com",
		"s3-accesspoint-fips.dualstack.us-gov-west-1.amazonaws.com",
		"s3-fips.dualstack.us-gov-west-1.amazonaws.com",
		"s3.us-gov-west-1.amazonaws.com",
		"s3-accesspoint.us-gov-west-1.amazonaws.com",
		"s3-accesspoint-fips.us-gov-west-1.amazonaws.com",
		"s3-fips.us-gov-west-1.amazonaws.com",
		"s3-object-lambda.us-gov-west-1.amazonaws.com",
		"s3-website.us-gov-west-1.amazonaws.com",
		"s3.dualstack.us-west-1.amazonaws.com",
		"s3-accesspoint.dualstack.us-west-1.amazonaws.com",
		"s3-accesspoint-fips.dualstack.us-west-1.amazonaws.com",
		"s3-fips.dualstack.us-west-1.amazonaws.com",
		"s3-website.dualstack.us-west-1.amazonaws.com",
		"s3.us-west-1.amazonaws.com",
		"s3-accesspoint.us-west-1.amazonaws.com",
		"s3-accesspoint-fips.us-west-1.amazonaws.com",
		"s3-fips.us-west-1.amazonaws.com",
		"s3-object-lambda.us-west-1.amazonaws.com",
		"s3-website.us-west-1.amazonaws.com",
		"s3.dualstack.us-west-2.amazonaws.com",
		"s3-accesspoint.dualstack.us-west-2.amazonaws.com",
		"s3-accesspoint-fips.dualstack.us-west-2.amazonaws.com",
		"s3-fips.dualstack.us-west-2.amazonaws.com",
		"s3-website.dualstack.us-west-2.amazonaws.com",
		"s3.us-west-2.amazonaws.com",
		"s3-accesspoint.us-west-2.amazonaws.com",
		"s3-accesspoint-fips.us-west-2.amazonaws.com",
		"s3-deprecated.us-west-2.amazonaws.com",
		"s3-fips.us-west-2.amazonaws.com",
		"s3-object-lambda.us-west-2.amazonaws.com",
		"s3-website.us-west-2.amazonaws.com",
		"labeling.ap-northeast-1.sagemaker.aws",
		"labeling.ap-northeast-2.sagemaker.aws",
		"labeling.ap-south-1.sagemaker.aws",
		"labeling.ap-southeast-1.sagemaker.aws",
		"labeling.ap-southeast-2.sagemaker.aws",
		"labeling.ca-central-1.sagemaker.aws",
		"labeling.eu-central-1.sagemaker.aws",
		"labeling.eu-west-1.sagemaker.aws",
		"labeling.eu-west-2.sagemaker.aws",
		"labeling.us-east-1.sagemaker.aws",
		"labeling.us-east-2.sagemaker.aws",
		"labeling.us-west-2.sagemaker.aws",
		"notebook.af-south-1.sagemaker.aws",
		"notebook.ap-east-1.sagemaker.aws",
		"notebook.ap-northeast-1.sagemaker.aws",
		"notebook.ap-northeast-2.sagemaker.aws",
		"notebook.ap-northeast-3.sagemaker.aws",
		"notebook.ap-south-1.sagemaker.aws",
		"notebook.ap-south-2.sagemaker.aws",
		"notebook.ap-southeast-1.sagemaker.aws",
		"notebook.ap-southeast-2.sagemaker.aws",
		"notebook.ap-southeast-3.sagemaker.aws",
		"notebook.ap-southeast-4.sagemaker.aws",
		"notebook.ca-central-1.sagemaker.aws",
		"notebook-fips.ca-central-1.sagemaker.aws",
		"notebook.ca-west-1.sagemaker.aws",
		"notebook-fips.ca-west-1.sagemaker.aws",
		"notebook.eu-central-1.sagemaker.aws",
		"notebook.eu-central-2.sagemaker.aws",
		"notebook.eu-north-1.sagemaker.aws",
		"notebook.eu-south-1.sagemaker.aws",
		"notebook.eu-south-2.sagemaker.aws",
		"notebook.eu-west-1.sagemaker.aws",
		"notebook.eu-west-2.sagemaker.aws",
		"notebook.eu-west-3.sagemaker.aws",
		"notebook.il-central-1.sagemaker.aws",
		"notebook.me-central-1.sagemaker.aws",
		"notebook.me-south-1.sagemaker.aws",
		"notebook.sa-east-1.sagemaker.aws",
		"notebook.us-east-1.sagemaker.aws",
		"notebook-fips.us-east-1.sagemaker.aws",
		"notebook.us-east-2.sagemaker.aws",
		"notebook-fips.us-east-2.sagemaker.aws",
		"notebook.us-gov-east-1.sagemaker.aws",
		"notebook-fips.us-gov-east-1.sagemaker.aws",
		"notebook.us-gov-west-1.sagemaker.aws",
		"notebook-fips.us-gov-west-1.sagemaker.aws",
		"notebook.us-west-1.sagemaker.aws",
		"notebook-fips.us-west-1.sagemaker.aws",
		"notebook.us-west-2.sagemaker.aws",
		"notebook-fips.us-west-2.sagemaker.aws",
		"notebook.cn-north-1.sagemaker.com.cn",
		"notebook.cn-northwest-1.sagemaker.com.cn",
		"studio.af-south-1.sagemaker.aws",
		"studio.ap-east-1.sagemaker.aws",
		"studio.ap-northeast-1.sagemaker.aws",
		"studio.ap-northeast-2.sagemaker.aws",
		"studio.ap-northeast-3.sagemaker.aws",
		"studio.ap-south-1.sagemaker.aws",
		"studio.ap-southeast-1.sagemaker.aws",
		"studio.ap-southeast-2.sagemaker.aws",
		"studio.ap-southeast-3.sagemaker.aws",
		"studio.ca-central-1.sagemaker.aws",
		"studio.eu-central-1.sagemaker.aws",
		"studio.eu-north-1.sagemaker.aws",
		"studio.eu-south-1.sagemaker.aws",
		"studio.eu-south-2.sagemaker.aws",
		"studio.eu-west-1.sagemaker.aws",
		"studio.eu-west-2.sagemaker.aws",
		"studio.eu-west-3.sagemaker.aws",
		"studio.il-central-1.sagemaker.aws",
		"studio.me-central-1.sagemaker.aws",
		"studio.me-south-1.sagemaker.aws",
		"studio.sa-east-1.sagemaker.aws",
		"studio.us-east-1.sagemaker.aws",
		"studio.us-east-2.sagemaker.aws",
		"studio.us-gov-east-1.sagemaker.aws",
		"studio-fips.us-gov-east-1.sagemaker.aws",
		"studio.us-gov-west-1.sagemaker.aws",
		"studio-fips.us-gov-west-1.sagemaker.aws",
		"studio.us-west-1.sagemaker.aws",
		"studio.us-west-2.sagemaker.aws",
		"studio.cn-north-1.sagemaker.com.cn",
		"studio.cn-northwest-1.sagemaker.com.cn",
		"*.experiments.sagemaker.aws",
		"analytics-gateway.ap-northeast-1.amazonaws.com",
		"analytics-gateway.ap-northeast-2.amazonaws.com",
		"analytics-gateway.ap-south-1.amazonaws.com",
		"analytics-gateway.ap-southeast-1.amazonaws.com",
		"analytics-gateway.ap-southeast-2.amazonaws.com",
		"analytics-gateway.eu-central-1.amazonaws.com",
		"analytics-gateway.eu-west-1.amazonaws.com",
		"analytics-gateway.us-east-1.amazonaws.com",
		"analytics-gateway.us-east-2.amazonaws.com",
		"analytics-gateway.us-west-2.amazonaws.com",
		"amplifyapp.com",
		"*.awsapprunner.com",
		"webview-assets.aws-cloud9.af-south-1.amazonaws.com",
		"vfs.cloud9.af-south-1.amazonaws.com",
		"webview-assets.cloud9.af-south-1.amazonaws.com",
		"webview-assets.aws-cloud9.ap-east-1.amazonaws.com",
		"vfs.cloud9.ap-east-1.amazonaws.com",
		"webview-assets.cloud9.ap-east-1.amazonaws.com",
		"webview-assets.aws-cloud9.ap-northeast-1.amazonaws.com",
		"vfs.cloud9.ap-northeast-1.amazonaws.com",
		"webview-assets.cloud9.ap-northeast-1.amazonaws.com",
		"webview-assets.aws-cloud9.ap-northeast-2.amazonaws.com",
		"vfs.cloud9.ap-northeast-2.amazonaws.com",
		"webview-assets.cloud9.ap-northeast-2.amazonaws.com",
		"webview-assets.aws-cloud9.ap-northeast-3.amazonaws.com",
		"vfs.cloud9.ap-northeast-3.amazonaws.com",
		"webview-assets.cloud9.ap-northeast-3.amazonaws.com",
		"webview-assets.aws-cloud9.ap-south-1.amazonaws.com",
		"vfs.cloud9.ap-south-1.amazonaws.com",
		"webview-assets.cloud9.ap-south-1.amazonaws.com",
		"webview-assets.aws-cloud9.ap-southeast-1.amazonaws.com",
		"vfs.cloud9.ap-southeast-1.amazonaws.com",
		"webview-assets.cloud9.ap-southeast-1.amazonaws.com",
		"webview-assets.aws-cloud9.ap-southeast-2.amazonaws.com",
		"vfs.cloud9.ap-southeast-2.amazonaws.com",
		"webview-assets.cloud9.ap-southeast-2.amazonaws.com",
		"webview-assets.aws-cloud9.ca-central-1.amazonaws.com",
		"vfs.cloud9.ca-central-1.amazonaws.com",
		"webview-assets.cloud9.ca-central-1.amazonaws.com",
		"webview-assets.aws-cloud9.eu-central-1.amazonaws.com",
		"vfs.cloud9.eu-central-1.amazonaws.com",
		"webview-assets.cloud9.eu-central-1.amazonaws.com",
		"webview-assets.aws-cloud9.eu-north-1.amazonaws.com",
		"vfs.cloud9.eu-north-1.amazonaws.com",
		"webview-assets.cloud9.eu-north-1.amazonaws.com",
		"webview-assets.aws-cloud9.eu-south-1.amazonaws.com",
		"vfs.cloud9.eu-south-1.amazonaws.com",
		"webview-assets.cloud9.eu-south-1.amazonaws.com",
		"webview-assets.aws-cloud9.eu-west-1.amazonaws.com",
		"vfs.cloud9.eu-west-1.amazonaws.com",
		"webview-assets.cloud9.eu-west-1.amazonaws.com",
		"webview-assets.aws-cloud9.eu-west-2.amazonaws.com",
		"vfs.cloud9.eu-west-2.amazonaws.com",
		"webview-assets.cloud9.eu-west-2.amazonaws.com",
		"webview-assets.aws-cloud9.eu-west-3.amazonaws.com",
		"vfs.cloud9.eu-west-3.amazonaws.com",
		"webview-assets.cloud9.eu-west-3.amazonaws.com",
		"webview-assets.aws-cloud9.il-central-1.amazonaws.com",
		"vfs.cloud9.il-central-1.amazonaws.com",
		"webview-assets.aws-cloud9.me-south-1.amazonaws.com",
		"vfs.cloud9.me-south-1.amazonaws.com",
		"webview-assets.cloud9.me-south-1.amazonaws.com",
		"webview-assets.aws-cloud9.sa-east-1.amazonaws.com",
		"vfs.cloud9.sa-east-1.amazonaws.com",
		"webview-assets.cloud9.sa-east-1.amazonaws.com",
		"webview-assets.aws-cloud9.us-east-1.amazonaws.com",
		"vfs.cloud9.us-east-1.amazonaws.com",
		"webview-assets.cloud9.us-east-1.amazonaws.com",
		"webview-assets.aws-cloud9.us-east-2.amazonaws.com",
		"vfs.cloud9.us-east-2.amazonaws.com",
		"webview-assets.cloud9.us-east-2.amazonaws.com",
		"webview-assets.aws-cloud9.us-west-1.amazonaws.com",
		"vfs.cloud9.us-west-1.amazonaws.com",
		"webview-assets.cloud9.us-west-1.amazonaws.com",
		"webview-assets.aws-cloud9.us-west-2.amazonaws.com",
		"vfs.cloud9.us-west-2.amazonaws.com",
		"webview-assets.cloud9.us-west-2.amazonaws.com",
		"awsapps.com",
		"cn-north-1.eb.amazonaws.com.cn",
		"cn-northwest-1.eb.amazonaws.com.cn",
		"elasticbeanstalk.com",
		"af-south-1.elasticbeanstalk.com",
		"ap-east-1.elasticbeanstalk.com",
		"ap-northeast-1.elasticbeanstalk.com",
		"ap-northeast-2.elasticbeanstalk.com",
		"ap-northeast-3.elasticbeanstalk.com",
		"ap-south-1.elasticbeanstalk.com",
		"ap-southeast-1.elasticbeanstalk.com",
		"ap-southeast-2.elasticbeanstalk.com",
		"ap-southeast-3.elasticbeanstalk.com",
		"ca-central-1.elasticbeanstalk.com",
		"eu-central-1.elasticbeanstalk.com",
		"eu-north-1.elasticbeanstalk.com",
		"eu-south-1.elasticbeanstalk.com",
		"eu-west-1.elasticbeanstalk.com",
		"eu-west-2.elasticbeanstalk.com",
		"eu-west-3.elasticbeanstalk.com",
		"il-central-1.elasticbeanstalk.com",
		"me-south-1.elasticbeanstalk.com",
		"sa-east-1.elasticbeanstalk.com",
		"us-east-1.elasticbeanstalk.com",
		"us-east-2.elasticbeanstalk.com",
		"us-gov-east-1.elasticbeanstalk.com",
		"us-gov-west-1.elasticbeanstalk.com",
		"us-west-1.elasticbeanstalk.com",
		"us-west-2.elasticbeanstalk.com",
		"*.elb.amazonaws.com.cn",
		"*.elb.amazonaws.com",
		"awsglobalaccelerator.com",
		"*.private.repost.aws",
		"eero.online",
		"eero-stage.online",
		"apigee.io",
		"panel.dev",
		"siiites.com",
		"appspacehosted.com",
		"appspaceusercontent.com",
		"appudo.net",
		"on-aptible.com",
		"f5.si",
		"arvanedge.ir",
		"user.aseinet.ne.jp",
		"gv.vc",
		"d.gv.vc",
		"user.party.eus",
		"pimienta.org",
		"poivron.org",
		"potager.org",
		"sweetpepper.org",
		"myasustor.com",
		"cdn.prod.atlassian-dev.net",
		"translated.page",
		"myfritz.link",
		"myfritz.net",
		"onavstack.net",
		"*.awdev.ca",
		"*.advisor.ws",
		"ecommerce-shop.pl",
		"b-data.io",
		"balena-devices.com",
		"base.ec",
		"official.ec",
		"buyshop.jp",
		"fashionstore.jp",
		"handcrafted.jp",
		"kawaiishop.jp",
		"supersale.jp",
		"theshop.jp",
		"shopselect.net",
		"base.shop",
		"beagleboard.io",
		"*.beget.app",
		"pages.gay",
		"bnr.la",
		"bitbucket.io",
		"blackbaudcdn.net",
		"of.je",
		"bluebite.io",
		"boomla.net",
		"boutir.com",
		"boxfuse.io",
		"square7.ch",
		"bplaced.com",
		"bplaced.de",
		"square7.de",
		"bplaced.net",
		"square7.net",
		"*.s.brave.io",
		"shop.brendly.hr",
		"shop.brendly.rs",
		"browsersafetymark.io",
		"radio.am",
		"radio.fm",
		"uk0.bigv.io",
		"dh.bytemark.co.uk",
		"vm.bytemark.co.uk",
		"cafjs.com",
		"canva-apps.cn",
		"*.my.canvasite.cn",
		"canva-apps.com",
		"*.my.canva.site",
		"drr.ac",
		"uwu.ai",
		"carrd.co",
		"crd.co",
		"ju.mp",
		"api.gov.uk",
		"cdn77-storage.com",
		"rsc.contentproxy9.cz",
		"r.cdn77.net",
		"cdn77-ssl.net",
		"c.cdn77.org",
		"rsc.cdn77.org",
		"ssl.origin.cdn77-secure.org",
		"za.bz",
		"br.com",
		"cn.com",
		"de.com",
		"eu.com",
		"jpn.com",
		"mex.com",
		"ru.com",
		"sa.com",
		"uk.com",
		"us.com",
		"za.com",
		"com.de",
		"gb.net",
		"hu.net",
		"jp.net",
		"se.net",
		"uk.net",
		"ae.org",
		"com.se",
		"cx.ua",
		"discourse.group",
		"discourse.team",
		"clerk.app",
		"clerkstage.app",
		"*.lcl.dev",
		"*.lclstage.dev",
		"*.stg.dev",
		"*.stgstage.dev",
		"cleverapps.cc",
		"*.services.clever-cloud.com",
		"cleverapps.io",
		"cleverapps.tech",
		"clickrising.net",
		"cloudns.asia",
		"cloudns.be",
		"cloud-ip.biz",
		"cloudns.biz",
		"cloudns.cc",
		"cloudns.ch",
		"cloudns.cl",
		"cloudns.club",
		"dnsabr.com",
		"ip-ddns.com",
		"cloudns.cx",
		"cloudns.eu",
		"cloudns.in",
		"cloudns.info",
		"ddns-ip.net",
		"dns-cloud.net",
		"dns-dynamic.net",
		"cloudns.nz",
		"cloudns.org",
		"ip-dynamic.org",
		"cloudns.ph",
		"cloudns.pro",
		"cloudns.pw",
		"cloudns.us",
		"c66.me",
		"cloud66.ws",
		"cloud66.zone",
		"jdevcloud.com",
		"wpdevcloud.com",
		"cloudaccess.host",
		"freesite.host",
		"cloudaccess.net",
		"*.cloudera.site",
		"cf-ipfs.com",
		"cloudflare-ipfs.com",
		"trycloudflare.com",
		"pages.dev",
		"r2.dev",
		"workers.dev",
		"cloudflare.net",
		"cdn.cloudflare.net",
		"cdn.cloudflareanycast.net",
		"cdn.cloudflarecn.net",
		"cdn.cloudflareglobal.net",
		"cust.cloudscale.ch",
		"objects.lpg.cloudscale.ch",
		"objects.rma.cloudscale.ch",
		"wnext.app",
		"cnpy.gdn",
		"*.otap.co",
		"co.ca",
		"co.com",
		"codeberg.page",
		"csb.app",
		"preview.csb.app",
		"co.nl",
		"co.no",
		"webhosting.be",
		"hosting-cluster.nl",
		"ctfcloud.net",
		"convex.site",
		"ac.ru",
		"edu.ru",
		"gov.ru",
		"int.ru",
		"mil.ru",
		"test.ru",
		"dyn.cosidns.de",
		"dnsupdater.de",
		"dynamisches-dns.de",
		"internet-dns.de",
		"l-o-g-i-n.de",
		"dynamic-dns.info",
		"feste-ip.net",
		"knx-server.net",
		"static-access.net",
		"craft.me",
		"realm.cz",
		"on.crisp.email",
		"*.cryptonomic.net",
		"curv.dev",
		"cfolks.pl",
		"cyon.link",
		"cyon.site",
		"platform0.app",
		"fnwk.site",
		"folionetwork.site",
		"biz.dk",
		"co.dk",
		"firm.dk",
		"reg.dk",
		"store.dk",
		"dyndns.dappnode.io",
		"builtwithdark.com",
		"darklang.io",
		"demo.datadetect.com",
		"instance.datadetect.com",
		"edgestack.me",
		"dattolocal.com",
		"dattorelay.com",
		"dattoweb.com",
		"mydatto.com",
		"dattolocal.net",
		"mydatto.net",
		"ddnss.de",
		"dyn.ddnss.de",
		"dyndns.ddnss.de",
		"dyn-ip24.de",
		"dyndns1.de",
		"home-webserver.de",
		"dyn.home-webserver.de",
		"myhome-server.de",
		"ddnss.org",
		"debian.net",
		"definima.io",
		"definima.net",
		"deno.dev",
		"deno-staging.dev",
		"dedyn.io",
		"deta.app",
		"deta.dev",
		"dfirma.pl",
		"dkonto.pl",
		"you2.pl",
		"ondigitalocean.app",
		"*.digitaloceanspaces.com",
		"us.kg",
		"rss.my.id",
		"diher.solutions",
		"discordsays.com",
		"discordsez.com",
		"jozi.biz",
		"dnshome.de",
		"online.th",
		"shop.th",
		"drayddns.com",
		"shoparena.pl",
		"dreamhosters.com",
		"durumis.com",
		"mydrobo.com",
		"drud.io",
		"drud.us",
		"duckdns.org",
		"dy.fi",
		"tunk.org",
		"dyndns.biz",
		"for-better.biz",
		"for-more.biz",
		"for-some.biz",
		"for-the.biz",
		"selfip.biz",
		"webhop.biz",
		"ftpaccess.cc",
		"game-server.cc",
		"myphotos.cc",
		"scrapping.cc",
		"blogdns.com",
		"cechire.com",
		"dnsalias.com",
		"dnsdojo.com",
		"doesntexist.com",
		"dontexist.com",
		"doomdns.com",
		"dyn-o-saur.com",
		"dynalias.com",
		"dyndns-at-home.com",
		"dyndns-at-work.com",
		"dyndns-blog.com",
		"dyndns-free.com",
		"dyndns-home.com",
		"dyndns-ip.com",
		"dyndns-mail.com",
		"dyndns-office.com",
		"dyndns-pics.com",
		"dyndns-remote.com",
		"dyndns-server.com",
		"dyndns-web.com",
		"dyndns-wiki.com",
		"dyndns-work.com",
		"est-a-la-maison.com",
		"est-a-la-masion.com",
		"est-le-patron.com",
		"est-mon-blogueur.com",
		"from-ak.com",
		"from-al.com",
		"from-ar.com",
		"from-ca.com",
		"from-ct.com",
		"from-dc.com",
		"from-de.com",
		"from-fl.com",
		"from-ga.com",
		"from-hi.com",
		"from-ia.com",
		"from-id.com",
		"from-il.com",
		"from-in.com",
		"from-ks.com",
		"from-ky.com",
		"from-ma.com",
		"from-md.com",
		"from-mi.com",
		"from-mn.com",
		"from-mo.com",
		"from-ms.com",
		"from-mt.com",
		"from-nc.com",
		"from-nd.com",
		"from-ne.com",
		"from-nh.com",
		"from-nj.com",
		"from-nm.com",
		"from-nv.com",
		"from-oh.com",
		"from-ok.com",
		"from-or.com",
		"from-pa.com",
		"from-pr.com",
		"from-ri.com",
		"from-sc.com",
		"from-sd.com",
		"from-tn.com",
		"from-tx.com",
		"from-ut.com",
		"from-va.com",
		"from-vt.com",
		"from-wa.com",
		"from-wi.com",
		"from-wv.com",
		"from-wy.com",
		"getmyip.com",
		"gotdns.com",
		"hobby-site.com",
		"homelinux.com",
		"homeunix.com",
		"iamallama.com",
		"is-a-anarchist.com",
		"is-a-blogger.com",
		"is-a-bookkeeper.com",
		"is-a-bulls-fan.com",
		"is-a-caterer.com",
		"is-a-chef.com",
		"is-a-conservative.com",
		"is-a-cpa.com",
		"is-a-cubicle-slave.com",
		"is-a-democrat.com",
		"is-a-designer.com",
		"is-a-doctor.com",
		"is-a-financialadvisor.com",
		"is-a-geek.com",
		"is-a-green.com",
		"is-a-guru.com",
		"is-a-hard-worker.com",
		"is-a-hunter.com",
		"is-a-landscaper.com",
		"is-a-lawyer.com",
		"is-a-liberal.com",
		"is-a-libertarian.com",
		"is-a-llama.com",
		"is-a-musician.com",
		"is-a-nascarfan.com",
		"is-a-nurse.com",
		"is-a-painter.com",
		"is-a-personaltrainer.com",
		"is-a-photographer.com",
		"is-a-player.com",
		"is-a-republican.com",
		"is-a-rockstar.com",
		"is-a-socialist.com",
		"is-a-student.com",
		"is-a-teacher.com",
		"is-a-techie.com",
		"is-a-therapist.com",
		"is-an-accountant.com",
		"is-an-actor.com",
		"is-an-actress.com",
		"is-an-anarchist.com",
		"is-an-artist.com",
		"is-an-engineer.com",
		"is-an-entertainer.com",
		"is-certified.com",
		"is-gone.com",
		"is-into-anime.com",
		"is-into-cars.com",
		"is-into-cartoons.com",
		"is-into-games.com",
		"is-leet.com",
		"is-not-certified.com",
		"is-slick.com",
		"is-uberleet.com",
		"is-with-theband.com",
		"isa-geek.com",
		"isa-hockeynut.com",
		"issmarterthanyou.com",
		"likes-pie.com",
		"likescandy.com",
		"neat-url.com",
		"saves-the-whales.com",
		"selfip.com",
		"sells-for-less.com",
		"sells-for-u.com",
		"servebbs.com",
		"simple-url.com",
		"space-to-rent.com",
		"teaches-yoga.com",
		"writesthisblog.com",
		"ath.cx",
		"fuettertdasnetz.de",
		"isteingeek.de",
		"istmein.de",
		"lebtimnetz.de",
		"leitungsen.de",
		"traeumtgerade.de",
		"barrel-of-knowledge.info",
		"barrell-of-knowledge.info",
		"dyndns.info",
		"for-our.info",
		"groks-the.info",
		"groks-this.info",
		"here-for-more.info",
		"knowsitall.info",
		"selfip.info",
		"webhop.info",
		"forgot.her.name",
		"forgot.his.name",
		"at-band-camp.net",
		"blogdns.net",
		"broke-it.net",
		"buyshouses.net",
		"dnsalias.net",
		"dnsdojo.net",
		"does-it.net",
		"dontexist.net",
		"dynalias.net",
		"dynathome.net",
		"endofinternet.net",
		"from-az.net",
		"from-co.net",
		"from-la.net",
		"from-ny.net",
		"gets-it.net",
		"ham-radio-op.net",
		"homeftp.net",
		"homeip.net",
		"homelinux.net",
		"homeunix.net",
		"in-the-band.net",
		"is-a-chef.net",
		"is-a-geek.net",
		"isa-geek.net",
		"kicks-ass.net",
		"office-on-the.net",
		"podzone.net",
		"scrapper-site.net",
		"selfip.net",
		"sells-it.net",
		"servebbs.net",
		"serveftp.net",
		"thruhere.net",
		"webhop.net",
		"merseine.nu",
		"mine.nu",
		"shacknet.nu",
		"blogdns.org",
		"blogsite.org",
		"boldlygoingnowhere.org",
		"dnsalias.org",
		"dnsdojo.org",
		"doesntexist.org",
		"dontexist.org",
		"doomdns.org",
		"dvrdns.org",
		"dynalias.org",
		"dyndns.org",
		"go.dyndns.org",
		"home.dyndns.org",
		"endofinternet.org",
		"endoftheinternet.org",
		"from-me.org",
		"game-host.org",
		"gotdns.org",
		"hobby-site.org",
		"homedns.org",
		"homeftp.org",
		"homelinux.org",
		"homeunix.org",
		"is-a-bruinsfan.org",
		"is-a-candidate.org",
		"is-a-celticsfan.org",
		"is-a-chef.org",
		"is-a-geek.org",
		"is-a-knight.org",
		"is-a-linux-user.org",
		"is-a-patsfan.org",
		"is-a-soxfan.org",
		"is-found.org",
		"is-lost.org",
		"is-saved.org",
		"is-very-bad.org",
		"is-very-evil.org",
		"is-very-good.org",
		"is-very-nice.org",
		"is-very-sweet.org",
		"isa-geek.org",
		"kicks-ass.org",
		"misconfused.org",
		"podzone.org",
		"readmyblog.org",
		"selfip.org",
		"sellsyourhome.org",
		"servebbs.org",
		"serveftp.org",
		"servegame.org",
		"stuff-4-sale.org",
		"webhop.org",
		"better-than.tv",
		"dyndns.tv",
		"on-the-web.tv",
		"worse-than.tv",
		"is-by.us",
		"land-4-sale.us",
		"stuff-4-sale.us",
		"dyndns.ws",
		"mypets.ws",
		"ddnsfree.com",
		"ddnsgeek.com",
		"giize.com",
		"gleeze.com",
		"kozow.com",
		"loseyourip.com",
		"ooguy.com",
		"theworkpc.com",
		"casacam.net",
		"dynu.net",
		"accesscam.org",
		"camdvr.org",
		"freeddns.org",
		"mywire.org",
		"webredirect.org",
		"myddns.rocks",
		"dynv6.net",
		"e4.cz",
		"easypanel.app",
		"easypanel.host",
		"*.ewp.live",
		"twmail.cc",
		"twmail.net",
		"twmail.org",
		"mymailer.com.tw",
		"url.tw",
		"at.emf.camp",
		"rt.ht",
		"elementor.cloud",
		"elementor.cool",
		"en-root.fr",
		"mytuleap.com",
		"tuleap-partners.com",
		"encr.app",
		"encoreapi.com",
		"eu.encoway.cloud",
		"eu.org",
		"al.eu.org",
		"asso.eu.org",
		"at.eu.org",
		"au.eu.org",
		"be.eu.org",
		"bg.eu.org",
		"ca.eu.org",
		"cd.eu.org",
		"ch.eu.org",
		"cn.eu.org",
		"cy.eu.org",
		"cz.eu.org",
		"de.eu.org",
		"dk.eu.org",
		"edu.eu.org",
		"ee.eu.org",
		"es.eu.org",
		"fi.eu.org",
		"fr.eu.org",
		"gr.eu.org",
		"hr.eu.org",
		"hu.eu.org",
		"ie.eu.org",
		"il.eu.org",
		"in.eu.org",
		"int.eu.org",
		"is.eu.org",
		"it.eu.org",
		"jp.eu.org",
		"kr.eu.org",
		"lt.eu.org",
		"lu.eu.org",
		"lv.eu.org",
		"me.eu.org",
		"mk.eu.org",
		"mt.eu.org",
		"my.eu.org",
		"net.eu.org",
		"ng.eu.org",
		"nl.eu.org",
		"no.eu.org",
		"nz.eu.org",
		"pl.eu.org",
		"pt.eu.org",
		"ro.eu.org",
		"ru.eu.org",
		"se.eu.org",
		"si.eu.org",
		"sk.eu.org",
		"tr.eu.org",
		"uk.eu.org",
		"us.eu.org",
		"eurodir.ru",
		"eu-1.evennode.com",
		"eu-2.evennode.com",
		"eu-3.evennode.com",
		"eu-4.evennode.com",
		"us-1.evennode.com",
		"us-2.evennode.com",
		"us-3.evennode.com",
		"us-4.evennode.com",
		"relay.evervault.app",
		"relay.evervault.dev",
		"expo.app",
		"staging.expo.app",
		"onfabrica.com",
		"ru.net",
		"adygeya.ru",
		"bashkiria.ru",
		"bir.ru",
		"cbg.ru",
		"com.ru",
		"dagestan.ru",
		"grozny.ru",
		"kalmykia.ru",
		"kustanai.ru",
		"marine.ru",
		"mordovia.ru",
		"msk.ru",
		"mytis.ru",
		"nalchik.ru",
		"nov.ru",
		"pyatigorsk.ru",
		"spb.ru",
		"vladikavkaz.ru",
		"vladimir.ru",
		"abkhazia.su",
		"adygeya.su",
		"aktyubinsk.su",
		"arkhangelsk.su",
		"armenia.su",
		"ashgabad.su",
		"azerbaijan.su",
		"balashov.su",
		"bashkiria.su",
		"bryansk.su",
		"bukhara.su",
		"chimkent.su",
		"dagestan.su",
		"east-kazakhstan.su",
		"exnet.su",
		"georgia.su",
		"grozny.su",
		"ivanovo.su",
		"jambyl.su",
		"kalmykia.su",
		"kaluga.su",
		"karacol.su",
		"karaganda.su",
		"karelia.su",
		"khakassia.su",
		"krasnodar.su",
		"kurgan.su",
		"kustanai.su",
		"lenug.su",
		"mangyshlak.su",
		"mordovia.su",
		"msk.su",
		"murmansk.su",
		"nalchik.su",
		"navoi.su",
		"north-kazakhstan.su",
		"nov.su",
		"obninsk.su",
		"penza.su",
		"pokrovsk.su",
		"sochi.su",
		"spb.su",
		"tashkent.su",
		"termez.su",
		"togliatti.su",
		"troitsk.su",
		"tselinograd.su",
		"tula.su",
		"tuva.su",
		"vladikavkaz.su",
		"vladimir.su",
		"vologda.su",
		"channelsdvr.net",
		"u.channelsdvr.net",
		"edgecompute.app",
		"fastly-edge.com",
		"fastly-terrarium.com",
		"freetls.fastly.net",
		"map.fastly.net",
		"a.prod.fastly.net",
		"global.prod.fastly.net",
		"a.ssl.fastly.net",
		"b.ssl.fastly.net",
		"global.ssl.fastly.net",
		"fastlylb.net",
		"map.fastlylb.net",
		"*.user.fm",
		"fastvps-server.com",
		"fastvps.host",
		"myfast.host",
		"fastvps.site",
		"myfast.space",
		"conn.uk",
		"copro.uk",
		"hosp.uk",
		"fedorainfracloud.org",
		"fedorapeople.org",
		"cloud.fedoraproject.org",
		"app.os.fedoraproject.org",
		"app.os.stg.fedoraproject.org",
		"mydobiss.com",
		"fh-muenster.io",
		"filegear.me",
		"firebaseapp.com",
		"fldrv.com",
		"flutterflow.app",
		"fly.dev",
		"shw.io",
		"edgeapp.net",
		"forgeblocks.com",
		"id.forgerock.io",
		"framer.ai",
		"framer.app",
		"framercanvas.com",
		"framer.media",
		"framer.photos",
		"framer.website",
		"framer.wiki",
		"0e.vc",
		"freebox-os.com",
		"freeboxos.com",
		"fbx-os.fr",
		"fbxos.fr",
		"freebox-os.fr",
		"freeboxos.fr",
		"freedesktop.org",
		"freemyip.com",
		"*.frusky.de",
		"wien.funkfeuer.at",
		"daemon.asia",
		"dix.asia",
		"mydns.bz",
		"0am.jp",
		"0g0.jp",
		"0j0.jp",
		"0t0.jp",
		"mydns.jp",
		"pgw.jp",
		"wjg.jp",
		"keyword-on.net",
		"live-on.net",
		"server-on.net",
		"mydns.tw",
		"mydns.vc",
		"*.futurecms.at",
		"*.ex.futurecms.at",
		"*.in.futurecms.at",
		"futurehosting.at",
		"futuremailing.at",
		"*.ex.ortsinfo.at",
		"*.kunden.ortsinfo.at",
		"*.statics.cloud",
		"aliases121.com",
		"campaign.gov.uk",
		"service.gov.uk",
		"independent-commission.uk",
		"independent-inquest.uk",
		"independent-inquiry.uk",
		"independent-panel.uk",
		"independent-review.uk",
		"public-inquiry.uk",
		"royal-commission.uk",
		"gehirn.ne.jp",
		"usercontent.jp",
		"gentapps.com",
		"gentlentapis.com",
		"lab.ms",
		"cdn-edges.net",
		"localcert.net",
		"localhostcert.net",
		"gsj.bz",
		"githubusercontent.com",
		"githubpreview.dev",
		"github.io",
		"gitlab.io",
		"gitapp.si",
		"gitpage.si",
		"glitch.me",
		"nog.community",
		"co.ro",
		"shop.ro",
		"lolipop.io",
		"angry.jp",
		"babyblue.jp",
		"babymilk.jp",
		"backdrop.jp",
		"bambina.jp",
		"bitter.jp",
		"blush.jp",
		"boo.jp",
		"boy.jp",
		"boyfriend.jp",
		"but.jp",
		"candypop.jp",
		"capoo.jp",
		"catfood.jp",
		"cheap.jp",
		"chicappa.jp",
		"chillout.jp",
		"chips.jp",
		"chowder.jp",
		"chu.jp",
		"ciao.jp",
		"cocotte.jp",
		"coolblog.jp",
		"cranky.jp",
		"cutegirl.jp",
		"daa.jp",
		"deca.jp",
		"deci.jp",
		"digick.jp",
		"egoism.jp",
		"fakefur.jp",
		"fem.jp",
		"flier.jp",
		"floppy.jp",
		"fool.jp",
		"frenchkiss.jp",
		"girlfriend.jp",
		"girly.jp",
		"gloomy.jp",
		"gonna.jp",
		"greater.jp",
		"hacca.jp",
		"heavy.jp",
		"her.jp",
		"hiho.jp",
		"hippy.jp",
		"holy.jp",
		"hungry.jp",
		"icurus.jp",
		"itigo.jp",
		"jellybean.jp",
		"kikirara.jp",
		"kill.jp",
		"kilo.jp",
		"kuron.jp",
		"littlestar.jp",
		"lolipopmc.jp",
		"lolitapunk.jp",
		"lomo.jp",
		"lovepop.jp",
		"lovesick.jp",
		"main.jp",
		"mods.jp",
		"mond.jp",
		"mongolian.jp",
		"moo.jp",
		"namaste.jp",
		"nikita.jp",
		"nobushi.jp",
		"noor.jp",
		"oops.jp",
		"parallel.jp",
		"parasite.jp",
		"pecori.jp",
		"peewee.jp",
		"penne.jp",
		"pepper.jp",
		"perma.jp",
		"pigboat.jp",
		"pinoko.jp",
		"punyu.jp",
		"pupu.jp",
		"pussycat.jp",
		"pya.jp",
		"raindrop.jp",
		"readymade.jp",
		"sadist.jp",
		"schoolbus.jp",
		"secret.jp",
		"staba.jp",
		"stripper.jp",
		"sub.jp",
		"sunnyday.jp",
		"thick.jp",
		"tonkotsu.jp",
		"under.jp",
		"upper.jp",
		"velvet.jp",
		"verse.jp",
		"versus.jp",
		"vivian.jp",
		"watson.jp",
		"weblike.jp",
		"whitesnow.jp",
		"zombie.jp",
		"heteml.net",
		"graphic.design",
		"goip.de",
		"blogspot.ae",
		"blogspot.al",
		"blogspot.am",
		"*.hosted.app",
		"*.run.app",
		"web.app",
		"blogspot.com.ar",
		"blogspot.co.at",
		"blogspot.com.au",
		"blogspot.ba",
		"blogspot.be",
		"blogspot.bg",
		"blogspot.bj",
		"blogspot.com.br",
		"blogspot.com.by",
		"blogspot.ca",
		"blogspot.cf",
		"blogspot.ch",
		"blogspot.cl",
		"blogspot.com.co",
		"*.0emm.com",
		"appspot.com",
		"*.r.appspot.com",
		"blogspot.com",
		"codespot.com",
		"googleapis.com",
		"googlecode.com",
		"pagespeedmobilizer.com",
		"withgoogle.com",
		"withyoutube.com",
		"blogspot.cv",
		"blogspot.com.cy",
		"blogspot.cz",
		"blogspot.de",
		"*.gateway.dev",
		"blogspot.dk",
		"blogspot.com.ee",
		"blogspot.com.eg",
		"blogspot.com.es",
		"blogspot.fi",
		"blogspot.fr",
		"cloud.goog",
		"translate.goog",
		"*.usercontent.goog",
		"blogspot.gr",
		"blogspot.hk",
		"blogspot.hr",
		"blogspot.hu",
		"blogspot.co.id",
		"blogspot.ie",
		"blogspot.co.il",
		"blogspot.in",
		"blogspot.is",
		"blogspot.it",
		"blogspot.jp",
		"blogspot.co.ke",
		"blogspot.kr",
		"blogspot.li",
		"blogspot.lt",
		"blogspot.lu",
		"blogspot.md",
		"blogspot.mk",
		"blogspot.com.mt",
		"blogspot.mx",
		"blogspot.my",
		"cloudfunctions.net",
		"blogspot.com.ng",
		"blogspot.nl",
		"blogspot.no",
		"blogspot.co.nz",
		"blogspot.pe",
		"blogspot.pt",
		"blogspot.qa",
		"blogspot.re",
		"blogspot.ro",
		"blogspot.rs",
		"blogspot.ru",
		"blogspot.se",
		"blogspot.sg",
		"blogspot.si",
		"blogspot.sk",
		"blogspot.sn",
		"blogspot.td",
		"blogspot.com.tr",
		"blogspot.tw",
		"blogspot.ug",
		"blogspot.co.uk",
		"blogspot.com.uy",
		"blogspot.vn",
		"blogspot.co.za",
		"goupile.fr",
		"pymnt.uk",
		"cloudapps.digital",
		"london.cloudapps.digital",
		"gov.nl",
		"grafana-dev.net",
		"grayjayleagues.com",
		"günstigbestellen.de",
		"günstigliefern.de",
		"fin.ci",
		"free.hr",
		"caa.li",
		"ua.rs",
		"conf.se",
		"häkkinen.fi",
		"hrsn.dev",
		"hashbang.sh",
		"hasura.app",
		"hasura-app.io",
		"hatenablog.com",
		"hatenadiary.com",
		"hateblo.jp",
		"hatenablog.jp",
		"hatenadiary.jp",
		"hatenadiary.org",
		"pages.it.hs-heilbronn.de",
		"pages-research.it.hs-heilbronn.de",
		"heiyu.space",
		"helioho.st",
		"heliohost.us",
		"hepforge.org",
		"herokuapp.com",
		"herokussl.com",
		"heyflow.page",
		"heyflow.site",
		"ravendb.cloud",
		"ravendb.community",
		"development.run",
		"ravendb.run",
		"homesklep.pl",
		"*.kin.one",
		"*.id.pub",
		"*.kin.pub",
		"secaas.hk",
		"hoplix.shop",
		"orx.biz",
		"biz.gl",
		"biz.ng",
		"co.biz.ng",
		"dl.biz.ng",
		"go.biz.ng",
		"lg.biz.ng",
		"on.biz.ng",
		"col.ng",
		"firm.ng",
		"gen.ng",
		"ltd.ng",
		"ngo.ng",
		"plc.ng",
		"ie.ua",
		"hostyhosting.io",
		"hf.space",
		"static.hf.space",
		"hypernode.io",
		"iobb.net",
		"co.cz",
		"*.moonscale.io",
		"moonscale.net",
		"gr.com",
		"iki.fi",
		"ibxos.it",
		"iliadboxos.it",
		"smushcdn.com",
		"wphostedmail.com",
		"wpmucdn.com",
		"tempurl.host",
		"wpmudev.host",
		"dyn-berlin.de",
		"in-berlin.de",
		"in-brb.de",
		"in-butter.de",
		"in-dsl.de",
		"in-vpn.de",
		"in-dsl.net",
		"in-vpn.net",
		"in-dsl.org",
		"in-vpn.org",
		"biz.at",
		"info.at",
		"info.cx",
		"ac.leg.br",
		"al.leg.br",
		"am.leg.br",
		"ap.leg.br",
		"ba.leg.br",
		"ce.leg.br",
		"df.leg.br",
		"es.leg.br",
		"go.leg.br",
		"ma.leg.br",
		"mg.leg.br",
		"ms.leg.br",
		"mt.leg.br",
		"pa.leg.br",
		"pb.leg.br",
		"pe.leg.br",
		"pi.leg.br",
		"pr.leg.br",
		"rj.leg.br",
		"rn.leg.br",
		"ro.leg.br",
		"rr.leg.br",
		"rs.leg.br",
		"sc.leg.br",
		"se.leg.br",
		"sp.leg.br",
		"to.leg.br",
		"pixolino.com",
		"na4u.ru",
		"apps-1and1.com",
		"live-website.com",
		"apps-1and1.net",
		"websitebuilder.online",
		"app-ionos.space",
		"iopsys.se",
		"*.dweb.link",
		"ipifony.net",
		"ir.md",
		"is-a-good.dev",
		"is-a.dev",
		"iservschule.de",
		"mein-iserv.de",
		"schulplattform.de",
		"schulserver.de",
		"test-iserv.de",
		"iserv.dev",
		"mel.cloudlets.com.au",
		"cloud.interhostsolutions.be",
		"alp1.ae.flow.ch",
		"appengine.flow.ch",
		"es-1.axarnet.cloud",
		"diadem.cloud",
		"vip.jelastic.cloud",
		"jele.cloud",
		"it1.eur.aruba.jenv-aruba.cloud",
		"it1.jenv-aruba.cloud",
		"keliweb.cloud",
		"cs.keliweb.cloud",
		"oxa.cloud",
		"tn.oxa.cloud",
		"uk.oxa.cloud",
		"primetel.cloud",
		"uk.primetel.cloud",
		"ca.reclaim.cloud",
		"uk.reclaim.cloud",
		"us.reclaim.cloud",
		"ch.trendhosting.cloud",
		"de.trendhosting.cloud",
		"jele.club",
		"dopaas.com",
		"paas.hosted-by-previder.com",
		"rag-cloud.hosteur.com",
		"rag-cloud-ch.hosteur.com",
		"jcloud.ik-server.com",
		"jcloud-ver-jpc.ik-server.com",
		"demo.jelastic.com",
		"paas.massivegrid.com",
		"jed.wafaicloud.com",
		"ryd.wafaicloud.com",
		"j.scaleforce.com.cy",
		"jelastic.dogado.eu",
		"fi.cloudplatform.fi",
		"demo.datacenter.fi",
		"paas.datacenter.fi",
		"jele.host",
		"mircloud.host",
		"paas.beebyte.io",
		"sekd1.beebyteapp.io",
		"jele.io",
		"jc.neen.it",
		"jcloud.kz",
		"cloudjiffy.net",
		"fra1-de.cloudjiffy.net",
		"west1-us.cloudjiffy.net",
		"jls-sto1.elastx.net",
		"jls-sto2.elastx.net",
		"jls-sto3.elastx.net",
		"fr-1.paas.massivegrid.net",
		"lon-1.paas.massivegrid.net",
		"lon-2.paas.massivegrid.net",
		"ny-1.paas.massivegrid.net",
		"ny-2.paas.massivegrid.net",
		"sg-1.paas.massivegrid.net",
		"jelastic.saveincloud.net",
		"nordeste-idc.saveincloud.net",
		"j.scaleforce.net",
		"sdscloud.pl",
		"unicloud.pl",
		"mircloud.ru",
		"enscaled.sg",
		"jele.site",
		"jelastic.team",
		"orangecloud.tn",
		"j.layershift.co.uk",
		"phx.enscaled.us",
		"mircloud.us",
		"myjino.ru",
		"*.hosting.myjino.ru",
		"*.landing.myjino.ru",
		"*.spectrum.myjino.ru",
		"*.vps.myjino.ru",
		"jotelulu.cloud",
		"webadorsite.com",
		"jouwweb.site",
		"*.cns.joyent.com",
		"*.triton.zone",
		"js.org",
		"kaas.gg",
		"khplay.nl",
		"kapsi.fi",
		"ezproxy.kuleuven.be",
		"kuleuven.cloud",
		"keymachine.de",
		"kinghost.net",
		"uni5.net",
		"knightpoint.systems",
		"koobin.events",
		"webthings.io",
		"krellian.net",
		"oya.to",
		"git-repos.de",
		"lcube-server.de",
		"svn-repos.de",
		"leadpages.co",
		"lpages.co",
		"lpusercontent.com",
		"lelux.site",
		"libp2p.direct",
		"runcontainers.dev",
		"co.business",
		"co.education",
		"co.events",
		"co.financial",
		"co.network",
		"co.place",
		"co.technology",
		"linkyard-cloud.ch",
		"linkyard.cloud",
		"members.linode.com",
		"*.nodebalancer.linode.com",
		"*.linodeobjects.com",
		"ip.linodeusercontent.com",
		"we.bs",
		"filegear-sg.me",
		"ggff.net",
		"*.user.localcert.dev",
		"lodz.pl",
		"pabianice.pl",
		"plock.pl",
		"sieradz.pl",
		"skierniewice.pl",
		"zgierz.pl",
		"loginline.app",
		"loginline.dev",
		"loginline.io",
		"loginline.services",
		"loginline.site",
		"lohmus.me",
		"servers.run",
		"krasnik.pl",
		"leczna.pl",
		"lubartow.pl",
		"lublin.pl",
		"poniatowa.pl",
		"swidnik.pl",
		"glug.org.uk",
		"lug.org.uk",
		"lugs.org.uk",
		"barsy.bg",
		"barsy.club",
		"barsycenter.com",
		"barsyonline.com",
		"barsy.de",
		"barsy.dev",
		"barsy.eu",
		"barsy.gr",
		"barsy.in",
		"barsy.info",
		"barsy.io",
		"barsy.me",
		"barsy.menu",
		"barsyonline.menu",
		"barsy.mobi",
		"barsy.net",
		"barsy.online",
		"barsy.org",
		"barsy.pro",
		"barsy.pub",
		"barsy.ro",
		"barsy.rs",
		"barsy.shop",
		"barsyonline.shop",
		"barsy.site",
		"barsy.store",
		"barsy.support",
		"barsy.uk",
		"barsy.co.uk",
		"barsyonline.co.uk",
		"*.magentosite.cloud",
		"hb.cldmail.ru",
		"matlab.cloud",
		"modelscape.com",
		"mwcloudnonprod.com",
		"polyspace.com",
		"mayfirst.info",
		"mayfirst.org",
		"mazeplay.com",
		"mcdir.me",
		"mcdir.ru",
		"vps.mcdir.ru",
		"mcpre.ru",
		"mediatech.by",
		"mediatech.dev",
		"hra.health",
		"medusajs.app",
		"miniserver.com",
		"memset.net",
		"messerli.app",
		"atmeta.com",
		"apps.fbsbx.com",
		"*.cloud.metacentrum.cz",
		"custom.metacentrum.cz",
		"flt.cloud.muni.cz",
		"usr.cloud.muni.cz",
		"meteorapp.com",
		"eu.meteorapp.com",
		"co.pl",
		"*.azurecontainer.io",
		"azure-api.net",
		"azure-mobile.net",
		"azureedge.net",
		"azurefd.net",
		"azurestaticapps.net",
		"1.azurestaticapps.net",
		"2.azurestaticapps.net",
		"3.azurestaticapps.net",
		"4.azurestaticapps.net",
		"5.azurestaticapps.net",
		"6.azurestaticapps.net",
		"7.azurestaticapps.net",
		"centralus.azurestaticapps.net",
		"eastasia.azurestaticapps.net",
		"eastus2.azurestaticapps.net",
		"westeurope.azurestaticapps.net",
		"westus2.azurestaticapps.net",
		"azurewebsites.net",
		"cloudapp.net",
		"trafficmanager.net",
		"blob.core.windows.net",
		"servicebus.windows.net",
		"routingthecloud.com",
		"sn.mynetname.net",
		"routingthecloud.net",
		"routingthecloud.org",
		"csx.cc",
		"mydbserver.com",
		"webspaceconfig.de",
		"mittwald.info",
		"mittwaldserver.info",
		"typo3server.info",
		"project.space",
		"modx.dev",
		"bmoattachments.org",
		"net.ru",
		"org.ru",
		"pp.ru",
		"hostedpi.com",
		"caracal.mythic-beasts.com",
		"customer.mythic-beasts.com",
		"fentiger.mythic-beasts.com",
		"lynx.mythic-beasts.com",
		"ocelot.mythic-beasts.com",
		"oncilla.mythic-beasts.com",
		"onza.mythic-beasts.com",
		"sphinx.mythic-beasts.com",
		"vs.mythic-beasts.com",
		"x.mythic-beasts.com",
		"yali.mythic-beasts.com",
		"cust.retrosnub.co.uk",
		"ui.nabu.casa",
		"cloud.nospamproxy.com",
		"netfy.app",
		"netlify.app",
		"4u.com",
		"nfshost.com",
		"ipfs.nftstorage.link",
		"ngo.us",
		"ngrok.app",
		"ngrok-free.app",
		"ngrok.dev",
		"ngrok-free.dev",
		"ngrok.io",
		"ap.ngrok.io",
		"au.ngrok.io",
		"eu.ngrok.io",
		"in.ngrok.io",
		"jp.ngrok.io",
		"sa.ngrok.io",
		"us.ngrok.io",
		"ngrok.pizza",
		"ngrok.pro",
		"torun.pl",
		"nh-serv.co.uk",
		"nimsite.uk",
		"mmafan.biz",
		"myftp.biz",
		"no-ip.biz",
		"no-ip.ca",
		"fantasyleague.cc",
		"gotdns.ch",
		"3utilities.com",
		"blogsyte.com",
		"ciscofreak.com",
		"damnserver.com",
		"ddnsking.com",
		"ditchyourip.com",
		"dnsiskinky.com",
		"dynns.com",
		"geekgalaxy.com",
		"health-carereform.com",
		"homesecuritymac.com",
		"homesecuritypc.com",
		"myactivedirectory.com",
		"mysecuritycamera.com",
		"myvnc.com",
		"net-freaks.com",
		"onthewifi.com",
		"point2this.com",
		"quicksytes.com",
		"securitytactics.com",
		"servebeer.com",
		"servecounterstrike.com",
		"serveexchange.com",
		"serveftp.com",
		"servegame.com",
		"servehalflife.com",
		"servehttp.com",
		"servehumour.com",
		"serveirc.com",
		"servemp3.com",
		"servep2p.com",
		"servepics.com",
		"servequake.com",
		"servesarcasm.com",
		"stufftoread.com",
		"unusualperson.com",
		"workisboring.com",
		"dvrcam.info",
		"ilovecollege.info",
		"no-ip.info",
		"brasilia.me",
		"ddns.me",
		"dnsfor.me",
		"hopto.me",
		"loginto.me",
		"noip.me",
		"webhop.me",
		"bounceme.net",
		"ddns.net",
		"eating-organic.net",
		"mydissent.net",
		"myeffect.net",
		"mymediapc.net",
		"mypsx.net",
		"mysecuritycamera.net",
		"nhlfan.net",
		"no-ip.net",
		"pgafan.net",
		"privatizehealthinsurance.net",
		"redirectme.net",
		"serveblog.net",
		"serveminecraft.net",
		"sytes.net",
		"cable-modem.org",
		"collegefan.org",
		"couchpotatofries.org",
		"hopto.org",
		"mlbfan.org",
		"myftp.org",
		"mysecuritycamera.org",
		"nflfan.org",
		"no-ip.org",
		"read-books.org",
		"ufcfan.org",
		"zapto.org",
		"no-ip.co.uk",
		"golffan.us",
		"noip.us",
		"pointto.us",
		"stage.nodeart.io",
		"*.developer.app",
		"noop.app",
		"*.northflank.app",
		"*.build.run",
		"*.code.run",
		"*.database.run",
		"*.migration.run",
		"noticeable.news",
		"notion.site",
		"dnsking.ch",
		"mypi.co",
		"n4t.co",
		"001www.com",
		"myiphost.com",
		"forumz.info",
		"soundcast.me",
		"tcp4.me",
		"dnsup.net",
		"hicam.net",
		"now-dns.net",
		"ownip.net",
		"vpndns.net",
		"dynserv.org",
		"now-dns.org",
		"x443.pw",
		"now-dns.top",
		"ntdll.top",
		"freeddns.us",
		"nsupdate.info",
		"nerdpol.ovh",
		"nyc.mn",
		"prvcy.page",
		"obl.ong",
		"observablehq.cloud",
		"static.observableusercontent.com",
		"omg.lol",
		"cloudycluster.net",
		"omniwe.site",
		"123webseite.at",
		"123website.be",
		"simplesite.com.br",
		"123website.ch",
		"simplesite.com",
		"123webseite.de",
		"123hjemmeside.dk",
		"123miweb.es",
		"123kotisivu.fi",
		"123siteweb.fr",
		"simplesite.gr",
		"123homepage.it",
		"123website.lu",
		"123website.nl",
		"123hjemmeside.no",
		"service.one",
		"simplesite.pl",
		"123paginaweb.pt",
		"123minsida.se",
		"is-a-fullstack.dev",
		"is-cool.dev",
		"is-not-a.dev",
		"localplayer.dev",
		"is-local.org",
		"opensocial.site",
		"opencraft.hosting",
		"16-b.it",
		"32-b.it",
		"64-b.it",
		"orsites.com",
		"operaunite.com",
		"*.customer-oci.com",
		"*.oci.customer-oci.com",
		"*.ocp.customer-oci.com",
		"*.ocs.customer-oci.com",
		"*.oraclecloudapps.com",
		"*.oraclegovcloudapps.com",
		"*.oraclegovcloudapps.uk",
		"tech.orange",
		"can.re",
		"authgear-staging.com",
		"authgearapps.com",
		"skygearapp.com",
		"outsystemscloud.com",
		"*.hosting.ovh.net",
		"*.webpaas.ovh.net",
		"ownprovider.com",
		"own.pm",
		"*.owo.codes",
		"ox.rs",
		"oy.lc",
		"pgfog.com",
		"pagexl.com",
		"gotpantheon.com",
		"pantheonsite.io",
		"*.paywhirl.com",
		"*.xmit.co",
		"xmit.dev",
		"madethis.site",
		"srv.us",
		"gh.srv.us",
		"gl.srv.us",
		"lk3.ru",
		"mypep.link",
		"perspecta.cloud",
		"on-web.fr",
		"*.upsun.app",
		"upsunapp.com",
		"ent.platform.sh",
		"eu.platform.sh",
		"us.platform.sh",
		"*.platformsh.site",
		"*.tst.site",
		"platter-app.com",
		"platter-app.dev",
		"platterp.us",
		"pley.games",
		"onporter.run",
		"co.bn",
		"postman-echo.com",
		"pstmn.io",
		"mock.pstmn.io",
		"httpbin.org",
		"prequalifyme.today",
		"xen.prgmr.com",
		"priv.at",
		"protonet.io",
		"chirurgiens-dentistes-en-france.fr",
		"byen.site",
		"pubtls.org",
		"pythonanywhere.com",
		"eu.pythonanywhere.com",
		"qa2.com",
		"qcx.io",
		"*.sys.qcx.io",
		"myqnapcloud.cn",
		"alpha-myqnapcloud.com",
		"dev-myqnapcloud.com",
		"mycloudnas.com",
		"mynascloud.com",
		"myqnapcloud.com",
		"qoto.io",
		"qualifioapp.com",
		"ladesk.com",
		"qbuser.com",
		"*.quipelements.com",
		"vapor.cloud",
		"vaporcloud.io",
		"rackmaze.com",
		"rackmaze.net",
		"cloudsite.builders",
		"myradweb.net",
		"servername.us",
		"web.in",
		"in.net",
		"myrdbx.io",
		"site.rb-hosting.io",
		"*.on-rancher.cloud",
		"*.on-k3s.io",
		"*.on-rio.io",
		"ravpage.co.il",
		"readthedocs-hosted.com",
		"readthedocs.io",
		"rhcloud.com",
		"instances.spawn.cc",
		"onrender.com",
		"app.render.com",
		"replit.app",
		"id.replit.app",
		"firewalledreplit.co",
		"id.firewalledreplit.co",
		"repl.co",
		"id.repl.co",
		"replit.dev",
		"archer.replit.dev",
		"bones.replit.dev",
		"canary.replit.dev",
		"global.replit.dev",
		"hacker.replit.dev",
		"id.replit.dev",
		"janeway.replit.dev",
		"kim.replit.dev",
		"kira.replit.dev",
		"kirk.replit.dev",
		"odo.replit.dev",
		"paris.replit.dev",
		"picard.replit.dev",
		"pike.replit.dev",
		"prerelease.replit.dev",
		"reed.replit.dev",
		"riker.replit.dev",
		"sisko.replit.dev",
		"spock.replit.dev",
		"staging.replit.dev",
		"sulu.replit.dev",
		"tarpit.replit.dev",
		"teams.replit.dev",
		"tucker.replit.dev",
		"wesley.replit.dev",
		"worf.replit.dev",
		"repl.run",
		"resindevice.io",
		"devices.resinstaging.io",
		"hzc.io",
		"adimo.co.uk",
		"itcouldbewor.se",
		"aus.basketball",
		"nz.basketball",
		"git-pages.rit.edu",
		"rocky.page",
		"rub.de",
		"ruhr-uni-bochum.de",
		"io.noc.ruhr-uni-bochum.de",
		"биз.рус",
		"ком.рус",
		"крым.рус",
		"мир.рус",
		"мск.рус",
		"орг.рус",
		"самара.рус",
		"сочи.рус",
		"спб.рус",
		"я.рус",
		"ras.ru",
		"nyat.app",
		"180r.com",
		"dojin.com",
		"sakuratan.com",
		"sakuraweb.com",
		"x0.com",
		"2-d.jp",
		"bona.jp",
		"crap.jp",
		"daynight.jp",
		"eek.jp",
		"flop.jp",
		"halfmoon.jp",
		"jeez.jp",
		"matrix.jp",
		"mimoza.jp",
		"ivory.ne.jp",
		"mail-box.ne.jp",
		"mints.ne.jp",
		"mokuren.ne.jp",
		"opal.ne.jp",
		"sakura.ne.jp",
		"sumomo.ne.jp",
		"topaz.ne.jp",
		"netgamers.jp",
		"nyanta.jp",
		"o0o0.jp",
		"rdy.jp",
		"rgr.jp",
		"rulez.jp",
		"s3.isk01.sakurastorage.jp",
		"s3.isk02.sakurastorage.jp",
		"saloon.jp",
		"sblo.jp",
		"skr.jp",
		"tank.jp",
		"uh-oh.jp",
		"undo.jp",
		"rs.webaccel.jp",
		"user.webaccel.jp",
		"websozai.jp",
		"xii.jp",
		"squares.net",
		"jpn.org",
		"kirara.st",
		"x0.to",
		"from.tv",
		"sakura.tv",
		"*.builder.code.com",
		"*.dev-builder.code.com",
		"*.stg-builder.code.com",
		"*.001.test.code-builder-stg.platform.salesforce.com",
		"*.d.crm.dev",
		"*.w.crm.dev",
		"*.wa.crm.dev",
		"*.wb.crm.dev",
		"*.wc.crm.dev",
		"*.wd.crm.dev",
		"*.we.crm.dev",
		"*.wf.crm.dev",
		"sandcats.io",
		"logoip.com",
		"logoip.de",
		"fr-par-1.baremetal.scw.cloud",
		"fr-par-2.baremetal.scw.cloud",
		"nl-ams-1.baremetal.scw.cloud",
		"cockpit.fr-par.scw.cloud",
		"fnc.fr-par.scw.cloud",
		"functions.fnc.fr-par.scw.cloud",
		"k8s.fr-par.scw.cloud",
		"nodes.k8s.fr-par.scw.cloud",
		"s3.fr-par.scw.cloud",
		"s3-website.fr-par.scw.cloud",
		"whm.fr-par.scw.cloud",
		"priv.instances.scw.cloud",
		"pub.instances.scw.cloud",
		"k8s.scw.cloud",
		"cockpit.nl-ams.scw.cloud",
		"k8s.nl-ams.scw.cloud",
		"nodes.k8s.nl-ams.scw.cloud",
		"s3.nl-ams.scw.cloud",
		"s3-website.nl-ams.scw.cloud",
		"whm.nl-ams.scw.cloud",
		"cockpit.pl-waw.scw.cloud",
		"k8s.pl-waw.scw.cloud",
		"nodes.k8s.pl-waw.scw.cloud",
		"s3.pl-waw.scw.cloud",
		"s3-website.pl-waw.scw.cloud",
		"scalebook.scw.cloud",
		"smartlabeling.scw.cloud",
		"dedibox.fr",
		"schokokeks.net",
		"gov.scot",
		"service.gov.scot",
		"scrysec.com",
		"client.scrypted.io",
		"firewall-gateway.com",
		"firewall-gateway.de",
		"my-gateway.de",
		"my-router.de",
		"spdns.de",
		"spdns.eu",
		"firewall-gateway.net",
		"my-firewall.org",
		"myfirewall.org",
		"spdns.org",
		"seidat.net",
		"sellfy.store",
		"minisite.ms",
		"senseering.net",
		"servebolt.cloud",
		"biz.ua",
		"co.ua",
		"pp.ua",
		"as.sh.cn",
		"sheezy.games",
		"shiftedit.io",
		"myshopblocks.com",
		"myshopify.com",
		"shopitsite.com",
		"shopware.shop",
		"shopware.store",
		"mo-siemens.io",
		"1kapp.com",
		"appchizi.com",
		"applinzi.com",
		"sinaapp.com",
		"vipsinaapp.com",
		"siteleaf.net",
		"small-web.org",
		"aeroport.fr",
		"avocat.fr",
		"chambagri.fr",
		"chirurgiens-dentistes.fr",
		"experts-comptables.fr",
		"medecin.fr",
		"notaires.fr",
		"pharmacien.fr",
		"port.fr",
		"veterinaire.fr",
		"vp4.me",
		"*.snowflake.app",
		"*.privatelink.snowflake.app",
		"streamlit.app",
		"streamlitapp.com",
		"try-snowplow.com",
		"mafelo.net",
		"playstation-cloud.com",
		"srht.site",
		"apps.lair.io",
		"*.stolos.io",
		"spacekit.io",
		"ind.mom",
		"customer.speedpartner.de",
		"myspreadshop.at",
		"myspreadshop.com.au",
		"myspreadshop.be",
		"myspreadshop.ca",
		"myspreadshop.ch",
		"myspreadshop.com",
		"myspreadshop.de",
		"myspreadshop.dk",
		"myspreadshop.es",
		"myspreadshop.fi",
		"myspreadshop.fr",
		"myspreadshop.ie",
		"myspreadshop.it",
		"myspreadshop.net",
		"myspreadshop.nl",
		"myspreadshop.no",
		"myspreadshop.pl",
		"myspreadshop.se",
		"myspreadshop.co.uk",
		"w-corp-staticblitz.com",
		"w-credentialless-staticblitz.com",
		"w-staticblitz.com",
		"stackhero-network.com",
		"runs.onstackit.cloud",
		"stackit.gg",
		"stackit.rocks",
		"stackit.run",
		"stackit.zone",
		"musician.io",
		"novecore.site",
		"api.stdlib.com",
		"feedback.ac",
		"forms.ac",
		"assessments.cx",
		"calculators.cx",
		"funnels.cx",
		"paynow.cx",
		"quizzes.cx",
		"researched.cx",
		"tests.cx",
		"surveys.so",
		"storebase.store",
		"storipress.app",
		"storj.farm",
		"strapiapp.com",
		"media.strapiapp.com",
		"vps-host.net",
		"atl.jelastic.vps-host.net",
		"njs.jelastic.vps-host.net",
		"ric.jelastic.vps-host.net",
		"streak-link.com",
		"streaklinks.com",
		"streakusercontent.com",
		"soc.srcf.net",
		"user.srcf.net",
		"utwente.io",
		"temp-dns.com",
		"supabase.co",
		"supabase.in",
		"supabase.net",
		"syncloud.it",
		"dscloud.biz",
		"direct.quickconnect.cn",
		"dsmynas.com",
		"familyds.com",
		"diskstation.me",
		"dscloud.me",
		"i234.me",
		"myds.me",
		"synology.me",
		"dscloud.mobi",
		"dsmynas.net",
		"familyds.net",
		"dsmynas.org",
		"familyds.org",
		"direct.quickconnect.to",
		"vpnplus.to",
		"mytabit.com",
		"mytabit.co.il",
		"tabitorder.co.il",
		"taifun-dns.de",
		"ts.net",
		"*.c.ts.net",
		"gda.pl",
		"gdansk.pl",
		"gdynia.pl",
		"med.pl",
		"sopot.pl",
		"taveusercontent.com",
		"p.tawk.email",
		"p.tawkto.email",
		"site.tb-hosting.com",
		"edugit.io",
		"s3.teckids.org",
		"telebit.app",
		"telebit.io",
		"*.telebit.xyz",
		"*.firenet.ch",
		"*.svc.firenet.ch",
		"reservd.com",
		"thingdustdata.com",
		"cust.dev.thingdust.io",
		"reservd.dev.thingdust.io",
		"cust.disrec.thingdust.io",
		"reservd.disrec.thingdust.io",
		"cust.prod.thingdust.io",
		"cust.testing.thingdust.io",
		"reservd.testing.thingdust.io",
		"tickets.io",
		"arvo.network",
		"azimuth.network",
		"tlon.network",
		"torproject.net",
		"pages.torproject.net",
		"townnews-staging.com",
		"12hp.at",
		"2ix.at",
		"4lima.at",
		"lima-city.at",
		"12hp.ch",
		"2ix.ch",
		"4lima.ch",
		"lima-city.ch",
		"trafficplex.cloud",
		"de.cool",
		"12hp.de",
		"2ix.de",
		"4lima.de",
		"lima-city.de",
		"1337.pictures",
		"clan.rip",
		"lima-city.rocks",
		"webspace.rocks",
		"lima.zone",
		"*.transurl.be",
		"*.transurl.eu",
		"site.transip.me",
		"*.transurl.nl",
		"tuxfamily.org",
		"dd-dns.de",
		"dray-dns.de",
		"draydns.de",
		"dyn-vpn.de",
		"dynvpn.de",
		"mein-vigor.de",
		"my-vigor.de",
		"my-wan.de",
		"syno-ds.de",
		"synology-diskstation.de",
		"synology-ds.de",
		"diskstation.eu",
		"diskstation.org",
		"typedream.app",
		"pro.typeform.com",
		"*.uberspace.de",
		"uber.space",
		"hk.com",
		"inc.hk",
		"ltd.hk",
		"hk.org",
		"it.com",
		"unison-services.cloud",
		"virtual-user.de",
		"virtualuser.de",
		"name.pm",
		"sch.tf",
		"biz.wf",
		"sch.wf",
		"org.yt",
		"rs.ba",
		"bielsko.pl",
		"upli.io",
		"urown.cloud",
		"dnsupdate.info",
		"us.org",
		"v.ua",
		"express.val.run",
		"web.val.run",
		"vercel.app",
		"v0.build",
		"vercel.dev",
		"vusercontent.net",
		"now.sh",
		"2038.io",
		"router.management",
		"v-info.info",
		"voorloper.cloud",
		"*.vultrobjects.com",
		"wafflecell.com",
		"webflow.io",
		"webflowtest.io",
		"*.webhare.dev",
		"bookonline.app",
		"hotelwithflight.com",
		"reserve-online.com",
		"reserve-online.net",
		"cprapid.com",
		"pleskns.com",
		"wp2.host",
		"pdns.page",
		"plesk.page",
		"wpsquared.site",
		"*.wadl.top",
		"remotewd.com",
		"box.ca",
		"pages.wiardweb.com",
		"toolforge.org",
		"wmcloud.org",
		"wmflabs.org",
		"wdh.app",
		"panel.gg",
		"daemon.panel.gg",
		"wixsite.com",
		"wixstudio.com",
		"editorx.io",
		"wixstudio.io",
		"wix.run",
		"messwithdns.com",
		"woltlab-demo.com",
		"myforum.community",
		"community-pro.de",
		"diskussionsbereich.de",
		"community-pro.net",
		"meinforum.net",
		"affinitylottery.org.uk",
		"raffleentry.org.uk",
		"weeklylottery.org.uk",
		"wpenginepowered.com",
		"js.wpenginepowered.com",
		"half.host",
		"xnbay.com",
		"u2.xnbay.com",
		"u2-local.xnbay.com",
		"cistron.nl",
		"demon.nl",
		"xs4all.space",
		"yandexcloud.net",
		"storage.yandexcloud.net",
		"website.yandexcloud.net",
		"official.academy",
		"yolasite.com",
		"yombo.me",
		"ynh.fr",
		"nohost.me",
		"noho.st",
		"za.net",
		"za.org",
		"zap.cloud",
		"zeabur.app",
		"bss.design",
		"basicserver.io",
		"virtualserver.io",
		"enterprisecloud.nu"
	].reduce((e, s) => {
		const c = s.replace(/^(\*\.|!)/, ""), o = A.toASCII(c), t = s.charAt(0);
		if (e.has(o)) {throw new Error(`Multiple rules found for ${s} (${o})`);}
		return e.set(o, {
			rule: s,
			suffix: c,
			punySuffix: o,
			wildcard: t === "*",
			exception: t === "!"
		}), e;
	}, /* @__PURE__ */ new Map()), aa = (e) => {
		const c = A.toASCII(e).split(".");
		for (let o = 0; o < c.length; o++) {
			const t = c.slice(o).join("."), d = Z.get(t);
			if (d) {return d;}
		}
		return null;
	}, H = {
		DOMAIN_TOO_SHORT: "Domain name too short.",
		DOMAIN_TOO_LONG: "Domain name too long. It should be no more than 255 chars.",
		LABEL_STARTS_WITH_DASH: "Domain name label can not start with a dash.",
		LABEL_ENDS_WITH_DASH: "Domain name label can not end with a dash.",
		LABEL_TOO_LONG: "Domain name label should be at most 63 chars long.",
		LABEL_TOO_SHORT: "Domain name label should be at least 1 character long.",
		LABEL_INVALID_CHARS: "Domain name label can only contain alphanumeric characters or dashes."
	}, oa = (e) => {
		const s = A.toASCII(e);
		if (s.length < 1) {return "DOMAIN_TOO_SHORT";}
		if (s.length > 255) {return "DOMAIN_TOO_LONG";}
		const c = s.split(".");
		let o;
		for (let t = 0; t < c.length; ++t) {
			if (o = c[t], !o.length) {return "LABEL_TOO_SHORT";}
			if (o.length > 63) {return "LABEL_TOO_LONG";}
			if (o.charAt(0) === "-") {return "LABEL_STARTS_WITH_DASH";}
			if (o.charAt(o.length - 1) === "-") {return "LABEL_ENDS_WITH_DASH";}
			if (!/^[a-z0-9\-_]+$/.test(o)) {return "LABEL_INVALID_CHARS";}
		}
	}, _ = (e) => {
		if (typeof e != "string") {throw new TypeError("Domain name must be a string.");}
		let s = e.slice(0).toLowerCase();
		s.charAt(s.length - 1) === "." && (s = s.slice(0, s.length - 1));
		const c = oa(s);
		if (c) {return {
			input: e,
			error: {
				message: H[c],
				code: c
			}
		};}
		const o = {
			input: e,
			tld: null,
			sld: null,
			domain: null,
			subdomain: null,
			listed: !1
		}, t = s.split(".");
		if (t[t.length - 1] === "local") {return o;}
		const d = () => (/xn--/.test(s) && (o.domain && (o.domain = A.toASCII(o.domain)), o.subdomain && (o.subdomain = A.toASCII(o.subdomain))), o), z = aa(s);
		if (!z) {return t.length < 2 ? o : (o.tld = t.pop(), o.sld = t.pop(), o.domain = [o.sld, o.tld].join("."), t.length && (o.subdomain = t.pop()), d());}
		o.listed = !0;
		const y = z.suffix.split("."), g = t.slice(0, t.length - y.length);
		return z.exception && g.push(y.shift()), o.tld = y.join("."), !g.length || (z.wildcard && (y.unshift(g.pop()), o.tld = y.join(".")), !g.length) || (o.sld = g.pop(), o.domain = [o.sld, o.tld].join("."), g.length && (o.subdomain = g.join("."))), d();
	}, N = (e) => e && _(e).domain || null, R = (e) => {
		const s = _(e);
		return !!(s.domain && s.listed);
	};
	exports.default = {
		parse: _,
		get: N,
		isValid: R
	};
	exports.errorCodes = H;
	exports.get = N;
	exports.isValid = R;
	exports.parse = _;
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/pubsuffix-psl.js
/*!
* Copyright (c) 2018, Salesforce.com, Inc.
* All rights reserved.
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice,
* this list of conditions and the following disclaimer.
*
* 2. Redistributions in binary form must reproduce the above copyright notice,
* this list of conditions and the following disclaimer in the documentation
* and/or other materials provided with the distribution.
*
* 3. Neither the name of Salesforce.com nor the names of its contributors may
* be used to endorse or promote products derived from this software without
* specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
* AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
* IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
* ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
* LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
* CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
* SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
* INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
* CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
* ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
* POSSIBILITY OF SUCH DAMAGE.
*/
var require_pubsuffix_psl = /* @__PURE__ */ __commonJSMin(((exports) => {
	const psl = require_psl();
	const SPECIAL_USE_DOMAINS = new Set([
		"local",
		"example",
		"invalid",
		"localhost",
		"test"
	]);
	const SPECIAL_TREATMENT_DOMAINS = ["localhost", "invalid"];
	function getPublicSuffix(domain, options = {}) {
		const domainParts = domain.split(".");
		const topLevelDomain = domainParts[domainParts.length - 1];
		const allowSpecialUseDomain = !!options.allowSpecialUseDomain;
		const ignoreError = !!options.ignoreError;
		if (allowSpecialUseDomain && SPECIAL_USE_DOMAINS.has(topLevelDomain)) {
			if (domainParts.length > 1) return `${domainParts[domainParts.length - 2]}.${topLevelDomain}`;
			else if (SPECIAL_TREATMENT_DOMAINS.includes(topLevelDomain)) return `${topLevelDomain}`;
		}
		if (!ignoreError && SPECIAL_USE_DOMAINS.has(topLevelDomain)) {throw new Error(`Cookie has domain set to the public suffix "${topLevelDomain}" which is a special use domain. To allow this, configure your CookieJar with {allowSpecialUseDomain:true, rejectPublicSuffixes: false}.`);}
		return psl.get(domain);
	}
	exports.getPublicSuffix = getPublicSuffix;
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/store.js
/*!
* Copyright (c) 2015, Salesforce.com, Inc.
* All rights reserved.
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice,
* this list of conditions and the following disclaimer.
*
* 2. Redistributions in binary form must reproduce the above copyright notice,
* this list of conditions and the following disclaimer in the documentation
* and/or other materials provided with the distribution.
*
* 3. Neither the name of Salesforce.com nor the names of its contributors may
* be used to endorse or promote products derived from this software without
* specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
* AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
* IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
* ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
* LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
* CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
* SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
* INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
* CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
* ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
* POSSIBILITY OF SUCH DAMAGE.
*/
var require_store = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Store = class {
		constructor() {
			this.synchronous = false;
		}
		findCookie(domain, path, key, cb) {
			throw new Error("findCookie is not implemented");
		}
		findCookies(domain, path, allowSpecialUseDomain, cb) {
			throw new Error("findCookies is not implemented");
		}
		putCookie(cookie, cb) {
			throw new Error("putCookie is not implemented");
		}
		updateCookie(oldCookie, newCookie, cb) {
			throw new Error("updateCookie is not implemented");
		}
		removeCookie(domain, path, key, cb) {
			throw new Error("removeCookie is not implemented");
		}
		removeCookies(domain, path, cb) {
			throw new Error("removeCookies is not implemented");
		}
		removeAllCookies(cb) {
			throw new Error("removeAllCookies is not implemented");
		}
		getAllCookies(cb) {
			throw new Error("getAllCookies is not implemented (therefore jar cannot be serialized)");
		}
	};
	exports.Store = Store;
}));
//#endregion
//#region node_modules/.pnpm/universalify@0.2.0/node_modules/universalify/index.js
var require_universalify = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.fromCallback = function(fn) {
		return Object.defineProperty(function() {
			if (typeof arguments[arguments.length - 1] === "function") {fn.apply(this, arguments);}
			else {return new Promise((resolve, reject) => {
				arguments[arguments.length] = (err, res) => {
					if (err) return reject(err);
					resolve(res);
				};
				arguments.length++;
				fn.apply(this, arguments);
			});}
		}, "name", { value: fn.name });
	};
	exports.fromPromise = function(fn) {
		return Object.defineProperty(function() {
			const cb = arguments[arguments.length - 1];
			if (typeof cb !== "function") {return fn.apply(this, arguments);}
			else {
				delete arguments[arguments.length - 1];
				arguments.length--;
				fn.apply(this, arguments).then((r) => cb(null, r), cb);
			}
		}, "name", { value: fn.name });
	};
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/permuteDomain.js
/*!
* Copyright (c) 2015, Salesforce.com, Inc.
* All rights reserved.
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice,
* this list of conditions and the following disclaimer.
*
* 2. Redistributions in binary form must reproduce the above copyright notice,
* this list of conditions and the following disclaimer in the documentation
* and/or other materials provided with the distribution.
*
* 3. Neither the name of Salesforce.com nor the names of its contributors may
* be used to endorse or promote products derived from this software without
* specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
* AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
* IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
* ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
* LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
* CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
* SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
* INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
* CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
* ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
* POSSIBILITY OF SUCH DAMAGE.
*/
var require_permuteDomain = /* @__PURE__ */ __commonJSMin(((exports) => {
	const pubsuffix = require_pubsuffix_psl();
	function permuteDomain(domain, allowSpecialUseDomain) {
		const pubSuf = pubsuffix.getPublicSuffix(domain, { allowSpecialUseDomain });
		if (!pubSuf) {return null;}
		if (pubSuf == domain) {return [domain];}
		if (domain.slice(-1) == ".") {domain = domain.slice(0, -1);}
		const parts = domain.slice(0, -(pubSuf.length + 1)).split(".").toReversed();
		let cur = pubSuf;
		const permutations = [cur];
		while (parts.length) {
			cur = `${parts.shift()}.${cur}`;
			permutations.push(cur);
		}
		return permutations;
	}
	exports.permuteDomain = permuteDomain;
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/pathMatch.js
/*!
* Copyright (c) 2015, Salesforce.com, Inc.
* All rights reserved.
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice,
* this list of conditions and the following disclaimer.
*
* 2. Redistributions in binary form must reproduce the above copyright notice,
* this list of conditions and the following disclaimer in the documentation
* and/or other materials provided with the distribution.
*
* 3. Neither the name of Salesforce.com nor the names of its contributors may
* be used to endorse or promote products derived from this software without
* specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
* AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
* IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
* ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
* LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
* CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
* SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
* INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
* CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
* ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
* POSSIBILITY OF SUCH DAMAGE.
*/
var require_pathMatch = /* @__PURE__ */ __commonJSMin(((exports) => {
	function pathMatch(reqPath, cookiePath) {
		if (cookiePath === reqPath) {return true;}
		if (reqPath.indexOf(cookiePath) === 0) {
			if (cookiePath.substr(-1) === "/") {return true;}
			if (reqPath.substr(cookiePath.length, 1) === "/") {return true;}
		}
		return false;
	}
	exports.pathMatch = pathMatch;
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/utilHelper.js
var require_utilHelper = /* @__PURE__ */ __commonJSMin(((exports) => {
	function requireUtil() {
		try {
			return __require("util");
		} catch (e) {
			return null;
		}
	}
	function lookupCustomInspectSymbol() {
		return Symbol.for("nodejs.util.inspect.custom");
	}
	function tryReadingCustomSymbolFromUtilInspect(options) {
		const util = (options.requireUtil || requireUtil)();
		return util ? util.inspect.custom : null;
	}
	exports.getUtilInspect = function getUtilInspect(fallback, options = {}) {
		const util = (options.requireUtil || requireUtil)();
		return function inspect(value, showHidden, depth) {
			return util ? util.inspect(value, showHidden, depth) : fallback(value);
		};
	};
	exports.getCustomInspectSymbol = function getCustomInspectSymbol(options = {}) {
		return (options.lookupCustomInspectSymbol || lookupCustomInspectSymbol)() || tryReadingCustomSymbolFromUtilInspect(options);
	};
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/memstore.js
/*!
* Copyright (c) 2015, Salesforce.com, Inc.
* All rights reserved.
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice,
* this list of conditions and the following disclaimer.
*
* 2. Redistributions in binary form must reproduce the above copyright notice,
* this list of conditions and the following disclaimer in the documentation
* and/or other materials provided with the distribution.
*
* 3. Neither the name of Salesforce.com nor the names of its contributors may
* be used to endorse or promote products derived from this software without
* specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
* AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
* IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
* ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
* LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
* CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
* SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
* INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
* CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
* ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
* POSSIBILITY OF SUCH DAMAGE.
*/
var require_memstore = /* @__PURE__ */ __commonJSMin(((exports) => {
	const { fromCallback } = require_universalify();
	const Store = require_store().Store;
	const permuteDomain = require_permuteDomain().permuteDomain;
	const pathMatch = require_pathMatch().pathMatch;
	const { getCustomInspectSymbol, getUtilInspect } = require_utilHelper();
	var MemoryCookieStore = class extends Store {
		constructor() {
			super();
			this.synchronous = true;
			this.idx = Object.create(null);
			const customInspectSymbol = getCustomInspectSymbol();
			if (customInspectSymbol) {this[customInspectSymbol] = this.inspect;}
		}
		inspect() {
			return `{ idx: ${{ inspect: getUtilInspect(inspectFallback) }.inspect(this.idx, false, 2)} }`;
		}
		findCookie(domain, path, key, cb) {
			if (!this.idx[domain]) {return cb(null, void 0);}
			if (!this.idx[domain][path]) {return cb(null, void 0);}
			return cb(null, this.idx[domain][path][key] || null);
		}
		findCookies(domain, path, allowSpecialUseDomain, cb) {
			const results = [];
			if (typeof allowSpecialUseDomain === "function") {
				cb = allowSpecialUseDomain;
				allowSpecialUseDomain = true;
			}
			if (!domain) {return cb(null, []);}
			let pathMatcher;
			if (!path) {pathMatcher = function matchAll(domainIndex) {
				for (const curPath in domainIndex) {
					const pathIndex = domainIndex[curPath];
					for (const key in pathIndex) results.push(pathIndex[key]);
				}
			};}
			else {pathMatcher = function matchRFC(domainIndex) {
				Object.keys(domainIndex).forEach((cookiePath) => {
					if (pathMatch(path, cookiePath)) {
						const pathIndex = domainIndex[cookiePath];
						for (const key in pathIndex) results.push(pathIndex[key]);
					}
				});
			};}
			const domains = permuteDomain(domain, allowSpecialUseDomain) || [domain];
			const idx = this.idx;
			domains.forEach((curDomain) => {
				const domainIndex = idx[curDomain];
				if (!domainIndex) {return;}
				pathMatcher(domainIndex);
			});
			cb(null, results);
		}
		putCookie(cookie, cb) {
			if (!this.idx[cookie.domain]) {this.idx[cookie.domain] = Object.create(null);}
			if (!this.idx[cookie.domain][cookie.path]) {this.idx[cookie.domain][cookie.path] = Object.create(null);}
			this.idx[cookie.domain][cookie.path][cookie.key] = cookie;
			cb(null);
		}
		updateCookie(oldCookie, newCookie, cb) {
			this.putCookie(newCookie, cb);
		}
		removeCookie(domain, path, key, cb) {
			if (this.idx[domain] && this.idx[domain][path] && this.idx[domain][path][key]) {delete this.idx[domain][path][key];}
			cb(null);
		}
		removeCookies(domain, path, cb) {
			if (this.idx[domain]) {if (path) delete this.idx[domain][path];
			else delete this.idx[domain];}
			return cb(null);
		}
		removeAllCookies(cb) {
			this.idx = Object.create(null);
			return cb(null);
		}
		getAllCookies(cb) {
			const cookies = [];
			const idx = this.idx;
			Object.keys(idx).forEach((domain) => {
				Object.keys(idx[domain]).forEach((path) => {
					Object.keys(idx[domain][path]).forEach((key) => {
						if (key !== null) {cookies.push(idx[domain][path][key]);}
					});
				});
			});
			cookies.sort((a, b) => {
				return (a.creationIndex || 0) - (b.creationIndex || 0);
			});
			cb(null, cookies);
		}
	};
	[
		"findCookie",
		"findCookies",
		"putCookie",
		"updateCookie",
		"removeCookie",
		"removeCookies",
		"removeAllCookies",
		"getAllCookies"
	].forEach((name) => {
		MemoryCookieStore.prototype[name] = fromCallback(MemoryCookieStore.prototype[name]);
	});
	exports.MemoryCookieStore = MemoryCookieStore;
	function inspectFallback(val) {
		const domains = Object.keys(val);
		if (domains.length === 0) {return "[Object: null prototype] {}";}
		let result = "[Object: null prototype] {\n";
		Object.keys(val).forEach((domain, i) => {
			result += formatDomain(domain, val[domain]);
			if (i < domains.length - 1) {result += ",";}
			result += "\n";
		});
		result += "}";
		return result;
	}
	function formatDomain(domainName, domainValue) {
		const indent = "  ";
		let result = `${indent}'${domainName}': [Object: null prototype] {\n`;
		Object.keys(domainValue).forEach((path, i, paths) => {
			result += formatPath(path, domainValue[path]);
			if (i < paths.length - 1) {result += ",";}
			result += "\n";
		});
		result += `${indent}}`;
		return result;
	}
	function formatPath(pathName, pathValue) {
		const indent = "    ";
		let result = `${indent}'${pathName}': [Object: null prototype] {\n`;
		Object.keys(pathValue).forEach((cookieName, i, cookieNames) => {
			const cookie = pathValue[cookieName];
			result += `      ${cookieName}: ${cookie.inspect()}`;
			if (i < cookieNames.length - 1) {result += ",";}
			result += "\n";
		});
		result += `${indent}}`;
		return result;
	}
	exports.inspectFallback = inspectFallback;
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/validators.js
var require_validators = /* @__PURE__ */ __commonJSMin(((exports) => {
	function isFunction(data) {
		return typeof data === "function";
	}
	function isNonEmptyString(data) {
		return isString(data) && data !== "";
	}
	function isDate(data) {
		return isInstanceStrict(data, Date) && isInteger(data.getTime());
	}
	function isEmptyString(data) {
		return data === "" || data instanceof String && data.toString() === "";
	}
	function isString(data) {
		return typeof data === "string" || data instanceof String;
	}
	function isObject(data) {
		return toString.call(data) === "[object Object]";
	}
	function isInstanceStrict(data, prototype) {
		try {
			return data instanceof prototype;
		} catch (error) {
			return false;
		}
	}
	function isInteger(data) {
		return typeof data === "number" && data % 1 === 0;
	}
	function validate(bool, cb, options) {
		if (!isFunction(cb)) {
			options = cb;
			cb = null;
		}
		if (!isObject(options)) {options = { Error: "Failed Check" };}
		if (!bool) {if (cb) cb(new ParameterError(options));
		else throw new ParameterError(options);}
	}
	var ParameterError = class extends Error {
		constructor(...params) {
			super(...params);
		}
	};
	exports.ParameterError = ParameterError;
	exports.isFunction = isFunction;
	exports.isNonEmptyString = isNonEmptyString;
	exports.isDate = isDate;
	exports.isEmptyString = isEmptyString;
	exports.isString = isString;
	exports.isObject = isObject;
	exports.validate = validate;
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/version.js
var require_version = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = "4.1.3";
}));
//#endregion
//#region node_modules/.pnpm/tough-cookie@4.1.3/node_modules/tough-cookie/lib/cookie.js
/*!
* Copyright (c) 2015-2020, Salesforce.com, Inc.
* All rights reserved.
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice,
* this list of conditions and the following disclaimer.
*
* 2. Redistributions in binary form must reproduce the above copyright notice,
* this list of conditions and the following disclaimer in the documentation
* and/or other materials provided with the distribution.
*
* 3. Neither the name of Salesforce.com nor the names of its contributors may
* be used to endorse or promote products derived from this software without
* specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
* AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
* IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
* ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
* LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
* CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
* SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
* INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
* CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
* ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
* POSSIBILITY OF SUCH DAMAGE.
*/
var require_cookie = /* @__PURE__ */ __commonJSMin(((exports) => {
	const punycode = require_punycode();
	const urlParse = require_url_parse();
	const pubsuffix = require_pubsuffix_psl();
	const Store = require_store().Store;
	const MemoryCookieStore = require_memstore().MemoryCookieStore;
	const pathMatch = require_pathMatch().pathMatch;
	const validators = require_validators();
	const VERSION = require_version();
	const { fromCallback } = require_universalify();
	const { getCustomInspectSymbol } = require_utilHelper();
	const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
	const CONTROL_CHARS = /[\x00-\x1F]/;
	const TERMINATORS = [
		"\n",
		"\r",
		"\0"
	];
	const PATH_VALUE = /[\x20-\x3A\x3C-\x7E]+/;
	const DATE_DELIM = /[\x09\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]/;
	const MONTH_TO_NUM = {
		jan: 0,
		feb: 1,
		mar: 2,
		apr: 3,
		may: 4,
		jun: 5,
		jul: 6,
		aug: 7,
		sep: 8,
		oct: 9,
		nov: 10,
		dec: 11
	};
	const MAX_TIME = 2147483647e3;
	const MIN_TIME = 0;
	const SAME_SITE_CONTEXT_VAL_ERR = "Invalid sameSiteContext option for getCookies(); expected one of \"strict\", \"lax\", or \"none\"";
	function checkSameSiteContext(value) {
		validators.validate(validators.isNonEmptyString(value), value);
		const context = String(value).toLowerCase();
		if (context === "none" || context === "lax" || context === "strict") {return context;}
		else {return null;}
	}
	const PrefixSecurityEnum = Object.freeze({
		SILENT: "silent",
		STRICT: "strict",
		DISABLED: "unsafe-disabled"
	});
	const IP_REGEX_LOWERCASE = /(?:^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$)|(?:^(?:(?:[a-f\d]{1,4}:){7}(?:[a-f\d]{1,4}|:)|(?:[a-f\d]{1,4}:){6}(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|:[a-f\d]{1,4}|:)|(?:[a-f\d]{1,4}:){5}(?::(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-f\d]{1,4}){1,2}|:)|(?:[a-f\d]{1,4}:){4}(?:(?::[a-f\d]{1,4}){0,1}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-f\d]{1,4}){1,3}|:)|(?:[a-f\d]{1,4}:){3}(?:(?::[a-f\d]{1,4}){0,2}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-f\d]{1,4}){1,4}|:)|(?:[a-f\d]{1,4}:){2}(?:(?::[a-f\d]{1,4}){0,3}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-f\d]{1,4}){1,5}|:)|(?:[a-f\d]{1,4}:){1}(?:(?::[a-f\d]{1,4}){0,4}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-f\d]{1,4}){1,6}|:)|(?::(?:(?::[a-f\d]{1,4}){0,5}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-f\d]{1,4}){1,7}|:)))$)/;
	const IP_V6_REGEX = `
\\[?(?:
(?:[a-fA-F\\d]{1,4}:){7}(?:[a-fA-F\\d]{1,4}|:)|
(?:[a-fA-F\\d]{1,4}:){6}(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}|:[a-fA-F\\d]{1,4}|:)|
(?:[a-fA-F\\d]{1,4}:){5}(?::(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}|(?::[a-fA-F\\d]{1,4}){1,2}|:)|
(?:[a-fA-F\\d]{1,4}:){4}(?:(?::[a-fA-F\\d]{1,4}){0,1}:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}|(?::[a-fA-F\\d]{1,4}){1,3}|:)|
(?:[a-fA-F\\d]{1,4}:){3}(?:(?::[a-fA-F\\d]{1,4}){0,2}:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}|(?::[a-fA-F\\d]{1,4}){1,4}|:)|
(?:[a-fA-F\\d]{1,4}:){2}(?:(?::[a-fA-F\\d]{1,4}){0,3}:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}|(?::[a-fA-F\\d]{1,4}){1,5}|:)|
(?:[a-fA-F\\d]{1,4}:){1}(?:(?::[a-fA-F\\d]{1,4}){0,4}:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}|(?::[a-fA-F\\d]{1,4}){1,6}|:)|
(?::(?:(?::[a-fA-F\\d]{1,4}){0,5}:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}|(?::[a-fA-F\\d]{1,4}){1,7}|:))
)(?:%[0-9a-zA-Z]{1,})?\\]?
`.replace(/\s*\/\/.*$/gm, "").replace(/\n/g, "").trim();
	const IP_V6_REGEX_OBJECT = new RegExp(`^${IP_V6_REGEX}$`);
	function parseDigits(token, minDigits, maxDigits, trailingOK) {
		let count = 0;
		while (count < token.length) {
			const c = token.charCodeAt(count);
			if (c <= 47 || c >= 58) {break;}
			count++;
		}
		if (count < minDigits || count > maxDigits) {return null;}
		if (!trailingOK && count != token.length) {return null;}
		return parseInt(token.substr(0, count), 10);
	}
	function parseTime(token) {
		const parts = token.split(":");
		const result = [
			0,
			0,
			0
		];
		if (parts.length !== 3) {return null;}
		for (let i = 0; i < 3; i++) {
			const trailingOK = i == 2;
			const num = parseDigits(parts[i], 1, 2, trailingOK);
			if (num === null) {return null;}
			result[i] = num;
		}
		return result;
	}
	function parseMonth(token) {
		token = String(token).substr(0, 3).toLowerCase();
		const num = MONTH_TO_NUM[token];
		return num >= 0 ? num : null;
	}
	function parseDate(str) {
		if (!str) {return;}
		const tokens = str.split(DATE_DELIM);
		if (!tokens) {return;}
		let hour = null;
		let minute = null;
		let second = null;
		let dayOfMonth = null;
		let month = null;
		let year = null;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i].trim();
			if (!token.length) {continue;}
			let result;
			if (second === null) {
				result = parseTime(token);
				if (result) {
					hour = result[0];
					minute = result[1];
					second = result[2];
					continue;
				}
			}
			if (dayOfMonth === null) {
				result = parseDigits(token, 1, 2, true);
				if (result !== null) {
					dayOfMonth = result;
					continue;
				}
			}
			if (month === null) {
				result = parseMonth(token);
				if (result !== null) {
					month = result;
					continue;
				}
			}
			if (year === null) {
				result = parseDigits(token, 2, 4, true);
				if (result !== null) {
					year = result;
					if (year >= 70 && year <= 99) {year += 1900;}
					else if (year >= 0 && year <= 69) {year += 2e3;}
				}
			}
		}
		if (dayOfMonth === null || month === null || year === null || second === null || dayOfMonth < 1 || dayOfMonth > 31 || year < 1601 || hour > 23 || minute > 59 || second > 59) {return;}
		return new Date(Date.UTC(year, month, dayOfMonth, hour, minute, second));
	}
	function formatDate(date) {
		validators.validate(validators.isDate(date), date);
		return date.toUTCString();
	}
	function canonicalDomain(str) {
		if (str == null) {return null;}
		str = str.trim().replace(/^\./, "");
		if (IP_V6_REGEX_OBJECT.test(str)) {str = str.replace("[", "").replace("]", "");}
		if (punycode && /[^\u0001-\u007f]/.test(str)) {str = punycode.toASCII(str);}
		return str.toLowerCase();
	}
	function domainMatch(str, domStr, canonicalize) {
		if (str == null || domStr == null) {return null;}
		if (canonicalize !== false) {
			str = canonicalDomain(str);
			domStr = canonicalDomain(domStr);
		}
		if (str == domStr) {return true;}
		const idx = str.lastIndexOf(domStr);
		if (idx <= 0) {return false;}
		if (str.length !== domStr.length + idx) {return false;}
		if (str.substr(idx - 1, 1) !== ".") {return false;}
		if (IP_REGEX_LOWERCASE.test(str)) {return false;}
		return true;
	}
	function defaultPath(path) {
		if (!path || path.substr(0, 1) !== "/") {return "/";}
		if (path === "/") {return path;}
		const rightSlash = path.lastIndexOf("/");
		if (rightSlash === 0) {return "/";}
		return path.slice(0, rightSlash);
	}
	function trimTerminator(str) {
		if (validators.isEmptyString(str)) {return str;}
		for (let t = 0; t < TERMINATORS.length; t++) {
			const terminatorIdx = str.indexOf(TERMINATORS[t]);
			if (terminatorIdx !== -1) {str = str.substr(0, terminatorIdx);}
		}
		return str;
	}
	function parseCookiePair(cookiePair, looseMode) {
		cookiePair = trimTerminator(cookiePair);
		validators.validate(validators.isString(cookiePair), cookiePair);
		let firstEq = cookiePair.indexOf("=");
		if (looseMode) {
			if (firstEq === 0) {
				cookiePair = cookiePair.substr(1);
				firstEq = cookiePair.indexOf("=");
			}
		} else if (firstEq <= 0) {return;}
		let cookieName, cookieValue;
		if (firstEq <= 0) {
			cookieName = "";
			cookieValue = cookiePair.trim();
		} else {
			cookieName = cookiePair.substr(0, firstEq).trim();
			cookieValue = cookiePair.substr(firstEq + 1).trim();
		}
		if (CONTROL_CHARS.test(cookieName) || CONTROL_CHARS.test(cookieValue)) {return;}
		const c = new Cookie();
		c.key = cookieName;
		c.value = cookieValue;
		return c;
	}
	function parse(str, options) {
		if (!options || typeof options !== "object") {options = {};}
		if (validators.isEmptyString(str) || !validators.isString(str)) {return null;}
		str = str.trim();
		const firstSemi = str.indexOf(";");
		const c = parseCookiePair(firstSemi === -1 ? str : str.substr(0, firstSemi), !!options.loose);
		if (!c) {return;}
		if (firstSemi === -1) {return c;}
		const unparsed = str.slice(firstSemi + 1).trim();
		if (unparsed.length === 0) {return c;}
		const cookie_avs = unparsed.split(";");
		while (cookie_avs.length) {
			const av = cookie_avs.shift().trim();
			if (av.length === 0) {continue;}
			const av_sep = av.indexOf("=");
			let av_key, av_value;
			if (av_sep === -1) {
				av_key = av;
				av_value = null;
			} else {
				av_key = av.substr(0, av_sep);
				av_value = av.substr(av_sep + 1);
			}
			av_key = av_key.trim().toLowerCase();
			if (av_value) {av_value = av_value.trim();}
			switch (av_key) {
				case "expires":
					if (av_value) {
						const exp = parseDate(av_value);
						if (exp) {c.expires = exp;}
					}
					break;
				case "max-age":
					if (av_value) {
						if (/^-?[0-9]+$/.test(av_value)) {
							const delta = parseInt(av_value, 10);
							c.setMaxAge(delta);
						}
					}
					break;
				case "domain":
					if (av_value) {
						const domain = av_value.trim().replace(/^\./, "");
						if (domain) {c.domain = domain.toLowerCase();}
					}
					break;
				case "path":
					c.path = av_value && av_value[0] === "/" ? av_value : null;
					break;
				case "secure":
					c.secure = true;
					break;
				case "httponly":
					c.httpOnly = true;
					break;
				case "samesite":
					switch (av_value ? av_value.toLowerCase() : "") {
						case "strict":
							c.sameSite = "strict";
							break;
						case "lax":
							c.sameSite = "lax";
							break;
						case "none":
							c.sameSite = "none";
							break;
						default:
							c.sameSite = void 0;
							break;
					}
					break;
				default:
					c.extensions = c.extensions || [];
					c.extensions.push(av);
					break;
			}
		}
		return c;
	}
	/**
	*  If the cookie-name begins with a case-sensitive match for the
	*  string "__Secure-", abort these steps and ignore the cookie
	*  entirely unless the cookie's secure-only-flag is true.
	* @param cookie
	* @returns boolean
	*/
	function isSecurePrefixConditionMet(cookie) {
		validators.validate(validators.isObject(cookie), cookie);
		return !cookie.key.startsWith("__Secure-") || cookie.secure;
	}
	/**
	*  If the cookie-name begins with a case-sensitive match for the
	*  string "__Host-", abort these steps and ignore the cookie
	*  entirely unless the cookie meets all the following criteria:
	*    1.  The cookie's secure-only-flag is true.
	*    2.  The cookie's host-only-flag is true.
	*    3.  The cookie-attribute-list contains an attribute with an
	*        attribute-name of "Path", and the cookie's path is "/".
	* @param cookie
	* @returns boolean
	*/
	function isHostPrefixConditionMet(cookie) {
		validators.validate(validators.isObject(cookie));
		return !cookie.key.startsWith("__Host-") || cookie.secure && cookie.hostOnly && cookie.path != null && cookie.path === "/";
	}
	function jsonParse(str) {
		let obj;
		try {
			obj = JSON.parse(str);
		} catch (e) {
			return e;
		}
		return obj;
	}
	function fromJSON(str) {
		if (!str || validators.isEmptyString(str)) {return null;}
		let obj;
		if (typeof str === "string") {
			obj = jsonParse(str);
			if (obj instanceof Error) {return null;}
		} else {obj = str;}
		const c = new Cookie();
		for (let i = 0; i < Cookie.serializableProperties.length; i++) {
			const prop = Cookie.serializableProperties[i];
			if (obj[prop] === void 0 || obj[prop] === cookieDefaults[prop]) {continue;}
			if (prop === "expires" || prop === "creation" || prop === "lastAccessed") {if (obj[prop] === null) c[prop] = null;
			else c[prop] = obj[prop] == "Infinity" ? "Infinity" : new Date(obj[prop]);}
			else {c[prop] = obj[prop];}
		}
		return c;
	}
	function cookieCompare(a, b) {
		validators.validate(validators.isObject(a), a);
		validators.validate(validators.isObject(b), b);
		let cmp = 0;
		const aPathLen = a.path ? a.path.length : 0;
		cmp = (b.path ? b.path.length : 0) - aPathLen;
		if (cmp !== 0) {return cmp;}
		cmp = (a.creation ? a.creation.getTime() : MAX_TIME) - (b.creation ? b.creation.getTime() : MAX_TIME);
		if (cmp !== 0) {return cmp;}
		cmp = a.creationIndex - b.creationIndex;
		return cmp;
	}
	function getCookieContext(url) {
		if (url instanceof Object) {return url;}
		try {
			url = decodeURI(url);
		} catch (err) {}
		return urlParse(url);
	}
	const cookieDefaults = {
		key: "",
		value: "",
		expires: "Infinity",
		maxAge: null,
		domain: null,
		path: null,
		secure: false,
		httpOnly: false,
		extensions: null,
		hostOnly: null,
		pathIsDefault: null,
		creation: null,
		lastAccessed: null,
		sameSite: void 0
	};
	var Cookie = class Cookie {
		constructor(options = {}) {
			const customInspectSymbol = getCustomInspectSymbol();
			if (customInspectSymbol) {this[customInspectSymbol] = this.inspect;}
			Object.assign(this, cookieDefaults, options);
			this.creation = this.creation || /* @__PURE__ */ new Date();
			Object.defineProperty(this, "creationIndex", {
				configurable: false,
				enumerable: false,
				writable: true,
				value: ++Cookie.cookiesCreated
			});
		}
		inspect() {
			const now = Date.now();
			const hostOnly = this.hostOnly != null ? this.hostOnly : "?";
			const createAge = this.creation ? `${now - this.creation.getTime()}ms` : "?";
			const accessAge = this.lastAccessed ? `${now - this.lastAccessed.getTime()}ms` : "?";
			return `Cookie="${this.toString()}; hostOnly=${hostOnly}; aAge=${accessAge}; cAge=${createAge}"`;
		}
		toJSON() {
			const obj = {};
			for (const prop of Cookie.serializableProperties) {
				if (this[prop] === cookieDefaults[prop]) {continue;}
				if (prop === "expires" || prop === "creation" || prop === "lastAccessed") {if (this[prop] === null) obj[prop] = null;
				else obj[prop] = this[prop] == "Infinity" ? "Infinity" : this[prop].toISOString();}
				else if (prop === "maxAge") {
					if (this[prop] !== null) {obj[prop] = this[prop] == Infinity || this[prop] == -Infinity ? this[prop].toString() : this[prop];}
				} else if (this[prop] !== cookieDefaults[prop]) {obj[prop] = this[prop];}
			}
			return obj;
		}
		clone() {
			return fromJSON(this.toJSON());
		}
		validate() {
			if (!COOKIE_OCTETS.test(this.value)) {return false;}
			if (this.expires != Infinity && !(this.expires instanceof Date) && !parseDate(this.expires)) {return false;}
			if (this.maxAge != null && this.maxAge <= 0) {return false;}
			if (this.path != null && !PATH_VALUE.test(this.path)) {return false;}
			const cdomain = this.cdomain();
			if (cdomain) {
				if (cdomain.match(/\.$/)) {return false;}
				if (pubsuffix.getPublicSuffix(cdomain) == null) {return false;}
			}
			return true;
		}
		setExpires(exp) {
			if (exp instanceof Date) {this.expires = exp;}
			else {this.expires = parseDate(exp) || "Infinity";}
		}
		setMaxAge(age) {
			if (age === Infinity || age === -Infinity) {this.maxAge = age.toString();}
			else {this.maxAge = age;}
		}
		cookieString() {
			let val = this.value;
			if (val == null) {val = "";}
			if (this.key === "") {return val;}
			return `${this.key}=${val}`;
		}
		toString() {
			let str = this.cookieString();
			if (this.expires != Infinity) {if (this.expires instanceof Date) str += `; Expires=${formatDate(this.expires)}`;
			else str += `; Expires=${this.expires}`;}
			if (this.maxAge != null && this.maxAge != Infinity) {str += `; Max-Age=${this.maxAge}`;}
			if (this.domain && !this.hostOnly) {str += `; Domain=${this.domain}`;}
			if (this.path) {str += `; Path=${this.path}`;}
			if (this.secure) {str += "; Secure";}
			if (this.httpOnly) {str += "; HttpOnly";}
			if (this.sameSite && this.sameSite !== "none") {
				const ssCanon = Cookie.sameSiteCanonical[this.sameSite.toLowerCase()];
				str += `; SameSite=${ssCanon ? ssCanon : this.sameSite}`;
			}
			if (this.extensions) {this.extensions.forEach((ext) => {
				str += `; ${ext}`;
			});}
			return str;
		}
		TTL(now) {
			if (this.maxAge != null) {return this.maxAge <= 0 ? 0 : this.maxAge * 1e3;}
			let expires = this.expires;
			if (expires != Infinity) {
				if (!(expires instanceof Date)) {expires = parseDate(expires) || Infinity;}
				if (expires == Infinity) {return Infinity;}
				return expires.getTime() - (now || Date.now());
			}
			return Infinity;
		}
		expiryTime(now) {
			if (this.maxAge != null) {
				const relativeTo = now || this.creation || /* @__PURE__ */ new Date();
				const age = this.maxAge <= 0 ? -Infinity : this.maxAge * 1e3;
				return relativeTo.getTime() + age;
			}
			if (this.expires == Infinity) {return Infinity;}
			return this.expires.getTime();
		}
		expiryDate(now) {
			const millisec = this.expiryTime(now);
			if (millisec == Infinity) {return new Date(MAX_TIME);}
			else if (millisec == -Infinity) {return new Date(MIN_TIME);}
			else {return new Date(millisec);}
		}
		isPersistent() {
			return this.maxAge != null || this.expires != Infinity;
		}
		canonicalizedDomain() {
			if (this.domain == null) {return null;}
			return canonicalDomain(this.domain);
		}
		cdomain() {
			return this.canonicalizedDomain();
		}
	};
	Cookie.cookiesCreated = 0;
	Cookie.parse = parse;
	Cookie.fromJSON = fromJSON;
	Cookie.serializableProperties = Object.keys(cookieDefaults);
	Cookie.sameSiteLevel = {
		strict: 3,
		lax: 2,
		none: 1
	};
	Cookie.sameSiteCanonical = {
		strict: "Strict",
		lax: "Lax"
	};
	function getNormalizedPrefixSecurity(prefixSecurity) {
		if (prefixSecurity != null) {
			const normalizedPrefixSecurity = prefixSecurity.toLowerCase();
			switch (normalizedPrefixSecurity) {
				case PrefixSecurityEnum.STRICT:
				case PrefixSecurityEnum.SILENT:
				case PrefixSecurityEnum.DISABLED: return normalizedPrefixSecurity;
			}
		}
		return PrefixSecurityEnum.SILENT;
	}
	var CookieJar = class CookieJar {
		constructor(store, options = { rejectPublicSuffixes: true }) {
			if (typeof options === "boolean") {options = { rejectPublicSuffixes: options };}
			validators.validate(validators.isObject(options), options);
			this.rejectPublicSuffixes = options.rejectPublicSuffixes;
			this.enableLooseMode = !!options.looseMode;
			this.allowSpecialUseDomain = typeof options.allowSpecialUseDomain === "boolean" ? options.allowSpecialUseDomain : true;
			this.store = store || new MemoryCookieStore();
			this.prefixSecurity = getNormalizedPrefixSecurity(options.prefixSecurity);
			this._cloneSync = syncWrap("clone");
			this._importCookiesSync = syncWrap("_importCookies");
			this.getCookiesSync = syncWrap("getCookies");
			this.getCookieStringSync = syncWrap("getCookieString");
			this.getSetCookieStringsSync = syncWrap("getSetCookieStrings");
			this.removeAllCookiesSync = syncWrap("removeAllCookies");
			this.setCookieSync = syncWrap("setCookie");
			this.serializeSync = syncWrap("serialize");
		}
		setCookie(cookie, url, options, cb) {
			validators.validate(validators.isNonEmptyString(url), cb, options);
			let err;
			if (validators.isFunction(url)) {
				cb = url;
				return cb(/* @__PURE__ */ new Error("No URL was specified"));
			}
			const context = getCookieContext(url);
			if (validators.isFunction(options)) {
				cb = options;
				options = {};
			}
			validators.validate(validators.isFunction(cb), cb);
			if (!validators.isNonEmptyString(cookie) && !validators.isObject(cookie) && cookie instanceof String && cookie.length == 0) {return cb(null);}
			const host = canonicalDomain(context.hostname);
			const loose = options.loose || this.enableLooseMode;
			let sameSiteContext = null;
			if (options.sameSiteContext) {
				sameSiteContext = checkSameSiteContext(options.sameSiteContext);
				if (!sameSiteContext) {return cb(new Error(SAME_SITE_CONTEXT_VAL_ERR));}
			}
			if (typeof cookie === "string" || cookie instanceof String) {
				cookie = Cookie.parse(cookie, { loose });
				if (!cookie) {
					err = /* @__PURE__ */ new Error("Cookie failed to parse");
					return cb(options.ignoreError ? null : err);
				}
			} else if (!(cookie instanceof Cookie)) {
				err = /* @__PURE__ */ new Error("First argument to setCookie must be a Cookie object or string");
				return cb(options.ignoreError ? null : err);
			}
			const now = options.now || /* @__PURE__ */ new Date();
			if (this.rejectPublicSuffixes && cookie.domain) {
				if (pubsuffix.getPublicSuffix(cookie.cdomain(), {
					allowSpecialUseDomain: this.allowSpecialUseDomain,
					ignoreError: options.ignoreError
				}) == null && !IP_V6_REGEX_OBJECT.test(cookie.domain)) {
					err = /* @__PURE__ */ new Error("Cookie has domain set to a public suffix");
					return cb(options.ignoreError ? null : err);
				}
			}
			if (cookie.domain) {
				if (!domainMatch(host, cookie.cdomain(), false)) {
					err = /* @__PURE__ */ new Error(`Cookie not in this host's domain. Cookie:${cookie.cdomain()} Request:${host}`);
					return cb(options.ignoreError ? null : err);
				}
				if (cookie.hostOnly == null) {cookie.hostOnly = false;}
			} else {
				cookie.hostOnly = true;
				cookie.domain = host;
			}
			if (!cookie.path || cookie.path[0] !== "/") {
				cookie.path = defaultPath(context.pathname);
				cookie.pathIsDefault = true;
			}
			if (options.http === false && cookie.httpOnly) {
				err = /* @__PURE__ */ new Error("Cookie is HttpOnly and this isn't an HTTP API");
				return cb(options.ignoreError ? null : err);
			}
			if (cookie.sameSite !== "none" && cookie.sameSite !== void 0 && sameSiteContext) {
				if (sameSiteContext === "none") {
					err = /* @__PURE__ */ new Error("Cookie is SameSite but this is a cross-origin request");
					return cb(options.ignoreError ? null : err);
				}
			}
			const ignoreErrorForPrefixSecurity = this.prefixSecurity === PrefixSecurityEnum.SILENT;
			if (!(this.prefixSecurity === PrefixSecurityEnum.DISABLED)) {
				let errorFound = false;
				let errorMsg;
				if (!isSecurePrefixConditionMet(cookie)) {
					errorFound = true;
					errorMsg = "Cookie has __Secure prefix but Secure attribute is not set";
				} else if (!isHostPrefixConditionMet(cookie)) {
					errorFound = true;
					errorMsg = "Cookie has __Host prefix but either Secure or HostOnly attribute is not set or Path is not '/'";
				}
				if (errorFound) {return cb(options.ignoreError || ignoreErrorForPrefixSecurity ? null : new Error(errorMsg));}
			}
			const store = this.store;
			if (!store.updateCookie) {store.updateCookie = function(oldCookie, newCookie, cb) {
				this.putCookie(newCookie, cb);
			};}
			function withCookie(err, oldCookie) {
				if (err) {return cb(err);}
				const next = function(err) {
					if (err) {return cb(err);}
					else {cb(null, cookie);}
				};
				if (oldCookie) {
					if (options.http === false && oldCookie.httpOnly) {
						err = /* @__PURE__ */ new Error("old Cookie is HttpOnly and this isn't an HTTP API");
						return cb(options.ignoreError ? null : err);
					}
					cookie.creation = oldCookie.creation;
					cookie.creationIndex = oldCookie.creationIndex;
					cookie.lastAccessed = now;
					store.updateCookie(oldCookie, cookie, next);
				} else {
					cookie.creation = cookie.lastAccessed = now;
					store.putCookie(cookie, next);
				}
			}
			store.findCookie(cookie.domain, cookie.path, cookie.key, withCookie);
		}
		getCookies(url, options, cb) {
			validators.validate(validators.isNonEmptyString(url), cb, url);
			const context = getCookieContext(url);
			if (validators.isFunction(options)) {
				cb = options;
				options = {};
			}
			validators.validate(validators.isObject(options), cb, options);
			validators.validate(validators.isFunction(cb), cb);
			const host = canonicalDomain(context.hostname);
			const path = context.pathname || "/";
			let secure = options.secure;
			if (secure == null && context.protocol && (context.protocol == "https:" || context.protocol == "wss:")) {secure = true;}
			let sameSiteLevel = 0;
			if (options.sameSiteContext) {
				const sameSiteContext = checkSameSiteContext(options.sameSiteContext);
				sameSiteLevel = Cookie.sameSiteLevel[sameSiteContext];
				if (!sameSiteLevel) {return cb(new Error(SAME_SITE_CONTEXT_VAL_ERR));}
			}
			let http = options.http;
			if (http == null) {http = true;}
			const now = options.now || Date.now();
			const expireCheck = options.expire !== false;
			const allPaths = !!options.allPaths;
			const store = this.store;
			function matchingCookie(c) {
				if (c.hostOnly) {
					if (c.domain != host) {return false;}
				} else if (!domainMatch(host, c.domain, false)) {return false;}
				if (!allPaths && !pathMatch(path, c.path)) {return false;}
				if (c.secure && !secure) {return false;}
				if (c.httpOnly && !http) {return false;}
				if (sameSiteLevel) {
					if (Cookie.sameSiteLevel[c.sameSite || "none"] > sameSiteLevel) {return false;}
				}
				if (expireCheck && c.expiryTime() <= now) {
					store.removeCookie(c.domain, c.path, c.key, () => {});
					return false;
				}
				return true;
			}
			store.findCookies(host, allPaths ? null : path, this.allowSpecialUseDomain, (err, cookies) => {
				if (err) {return cb(err);}
				cookies = cookies.filter(matchingCookie);
				if (options.sort !== false) {cookies = cookies.sort(cookieCompare);}
				const now = /* @__PURE__ */ new Date();
				for (const cookie of cookies) {cookie.lastAccessed = now;}
				cb(null, cookies);
			});
		}
		getCookieString(...args) {
			const cb = args.pop();
			validators.validate(validators.isFunction(cb), cb);
			const next = function(err, cookies) {
				if (err) {cb(err);}
				else {cb(null, cookies.sort(cookieCompare).map((c) => c.cookieString()).join("; "));}
			};
			args.push(next);
			this.getCookies.apply(this, args);
		}
		getSetCookieStrings(...args) {
			const cb = args.pop();
			validators.validate(validators.isFunction(cb), cb);
			const next = function(err, cookies) {
				if (err) {cb(err);}
				else {cb(null, cookies.map((c) => {
					return c.toString();
				}));}
			};
			args.push(next);
			this.getCookies.apply(this, args);
		}
		serialize(cb) {
			validators.validate(validators.isFunction(cb), cb);
			let type = this.store.constructor.name;
			if (validators.isObject(type)) {type = null;}
			const serialized = {
				version: `tough-cookie@${VERSION}`,
				storeType: type,
				rejectPublicSuffixes: !!this.rejectPublicSuffixes,
				enableLooseMode: !!this.enableLooseMode,
				allowSpecialUseDomain: !!this.allowSpecialUseDomain,
				prefixSecurity: getNormalizedPrefixSecurity(this.prefixSecurity),
				cookies: []
			};
			if (!(this.store.getAllCookies && typeof this.store.getAllCookies === "function")) {return cb(/* @__PURE__ */ new Error("store does not support getAllCookies and cannot be serialized"));}
			this.store.getAllCookies((err, cookies) => {
				if (err) {return cb(err);}
				serialized.cookies = cookies.map((cookie) => {
					cookie = cookie instanceof Cookie ? cookie.toJSON() : cookie;
					delete cookie.creationIndex;
					return cookie;
				});
				return cb(null, serialized);
			});
		}
		toJSON() {
			return this.serializeSync();
		}
		_importCookies(serialized, cb) {
			let cookies = serialized.cookies;
			if (!cookies || !Array.isArray(cookies)) {return cb(/* @__PURE__ */ new Error("serialized jar has no cookies array"));}
			cookies = cookies.slice();
			const putNext = (err) => {
				if (err) {return cb(err);}
				if (!cookies.length) {return cb(err, this);}
				let cookie;
				try {
					cookie = fromJSON(cookies.shift());
				} catch (e) {
					return cb(e);
				}
				if (cookie === null) {return putNext(null);}
				this.store.putCookie(cookie, putNext);
			};
			putNext();
		}
		clone(newStore, cb) {
			if (arguments.length === 1) {
				cb = newStore;
				newStore = null;
			}
			this.serialize((err, serialized) => {
				if (err) {return cb(err);}
				CookieJar.deserialize(serialized, newStore, cb);
			});
		}
		cloneSync(newStore) {
			if (arguments.length === 0) {return this._cloneSync();}
			if (!newStore.synchronous) {throw new Error("CookieJar clone destination store is not synchronous; use async API instead.");}
			return this._cloneSync(newStore);
		}
		removeAllCookies(cb) {
			validators.validate(validators.isFunction(cb), cb);
			const store = this.store;
			if (typeof store.removeAllCookies === "function" && store.removeAllCookies !== Store.prototype.removeAllCookies) {return store.removeAllCookies(cb);}
			store.getAllCookies((err, cookies) => {
				if (err) {return cb(err);}
				if (cookies.length === 0) {return cb(null);}
				let completedCount = 0;
				const removeErrors = [];
				function removeCookieCb(removeErr) {
					if (removeErr) {removeErrors.push(removeErr);}
					completedCount++;
					if (completedCount === cookies.length) {return cb(removeErrors.length ? removeErrors[0] : null);}
				}
				cookies.forEach((cookie) => {
					store.removeCookie(cookie.domain, cookie.path, cookie.key, removeCookieCb);
				});
			});
		}
		static deserialize(strOrObj, store, cb) {
			if (arguments.length !== 3) {
				cb = store;
				store = null;
			}
			validators.validate(validators.isFunction(cb), cb);
			let serialized;
			if (typeof strOrObj === "string") {
				serialized = jsonParse(strOrObj);
				if (serialized instanceof Error) {return cb(serialized);}
			} else {serialized = strOrObj;}
			const jar = new CookieJar(store, {
				rejectPublicSuffixes: serialized.rejectPublicSuffixes,
				looseMode: serialized.enableLooseMode,
				allowSpecialUseDomain: serialized.allowSpecialUseDomain,
				prefixSecurity: serialized.prefixSecurity
			});
			jar._importCookies(serialized, (err) => {
				if (err) {return cb(err);}
				cb(null, jar);
			});
		}
		static deserializeSync(strOrObj, store) {
			const serialized = typeof strOrObj === "string" ? JSON.parse(strOrObj) : strOrObj;
			const jar = new CookieJar(store, {
				rejectPublicSuffixes: serialized.rejectPublicSuffixes,
				looseMode: serialized.enableLooseMode
			});
			if (!jar.store.synchronous) {throw new Error("CookieJar store is not synchronous; use async API instead.");}
			jar._importCookiesSync(serialized);
			return jar;
		}
	};
	CookieJar.fromJSON = CookieJar.deserializeSync;
	[
		"_importCookies",
		"clone",
		"getCookies",
		"getCookieString",
		"getSetCookieStrings",
		"removeAllCookies",
		"serialize",
		"setCookie"
	].forEach((name) => {
		CookieJar.prototype[name] = fromCallback(CookieJar.prototype[name]);
	});
	CookieJar.deserialize = fromCallback(CookieJar.deserialize);
	function syncWrap(method) {
		return function(...args) {
			if (!this.store.synchronous) {throw new Error("CookieJar store is not synchronous; use async API instead.");}
			let syncErr, syncResult;
			this[method](...args, (err, result) => {
				syncErr = err;
				syncResult = result;
			});
			if (syncErr) {throw syncErr;}
			return syncResult;
		};
	}
	exports.CookieJar = CookieJar;
	exports.Cookie = Cookie;
	exports.getPublicSuffix = pubsuffix.getPublicSuffix;
	exports.permuteDomain = require_permuteDomain().permuteDomain;
	exports.ParameterError = validators.ParameterError;
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/core.js
var require_core = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory();}
		else if (typeof define === "function" && define.amd) {define([], factory);}
		else {root.CryptoJS = factory();}
	})(exports, function() {
		/**
		* CryptoJS core components.
		*/
		var CryptoJS = CryptoJS || function(Math, undefined) {
			var crypto;
			if (typeof window !== "undefined" && window.crypto) {crypto = window.crypto;}
			if (typeof self !== "undefined" && self.crypto) {crypto = self.crypto;}
			if (typeof globalThis !== "undefined" && globalThis.crypto) {crypto = globalThis.crypto;}
			if (!crypto && typeof window !== "undefined" && window.msCrypto) {crypto = window.msCrypto;}
			if (!crypto && typeof global !== "undefined" && global.crypto) {crypto = global.crypto;}
			if (!crypto && typeof __require === "function") {try {
				crypto = __require("crypto");
			} catch (err) {}}
			var cryptoSecureRandomInt = function() {
				if (crypto) {
					if (typeof crypto.getRandomValues === "function") {try {
						return crypto.getRandomValues(new Uint32Array(1))[0];
					} catch (err) {}}
					if (typeof crypto.randomBytes === "function") {try {
						return crypto.randomBytes(4).readInt32LE();
					} catch (err) {}}
				}
				throw new Error("Native crypto module could not be used to get secure random number.");
			};
			var create = Object.create || function() {
				function F() {}
				return function(obj) {
					var subtype;
					F.prototype = obj;
					subtype = new F();
					F.prototype = null;
					return subtype;
				};
			}();
			/**
			* CryptoJS namespace.
			*/
			var C = {};
			/**
			* Library namespace.
			*/
			var C_lib = C.lib = {};
			/**
			* Base object for prototypal inheritance.
			*/
			var Base = C_lib.Base = function() {
				return {
					extend: function(overrides) {
						var subtype = create(this);
						if (overrides) {subtype.mixIn(overrides);}
						if (!subtype.hasOwnProperty("init") || this.init === subtype.init) {subtype.init = function() {
							subtype.$super.init.apply(this, arguments);
						};}
						subtype.init.prototype = subtype;
						subtype.$super = this;
						return subtype;
					},
					create: function() {
						var instance = this.extend();
						instance.init.apply(instance, arguments);
						return instance;
					},
					init: function() {},
					mixIn: function(properties) {
						for (var propertyName in properties) {if (properties.hasOwnProperty(propertyName)) this[propertyName] = properties[propertyName];}
						if (properties.hasOwnProperty("toString")) {this.toString = properties.toString;}
					},
					clone: function() {
						return this.init.prototype.extend(this);
					}
				};
			}();
			/**
			* An array of 32-bit words.
			*
			* @property {Array} words The array of 32-bit words.
			* @property {number} sigBytes The number of significant bytes in this word array.
			*/
			var WordArray = C_lib.WordArray = Base.extend({
				init: function(words, sigBytes) {
					words = this.words = words || [];
					if (sigBytes != undefined) {this.sigBytes = sigBytes;}
					else {this.sigBytes = words.length * 4;}
				},
				toString: function(encoder) {
					return (encoder || Hex).stringify(this);
				},
				concat: function(wordArray) {
					var thisWords = this.words;
					var thatWords = wordArray.words;
					var thisSigBytes = this.sigBytes;
					var thatSigBytes = wordArray.sigBytes;
					this.clamp();
					if (thisSigBytes % 4) {for (var i = 0; i < thatSigBytes; i++) {
						var thatByte = thatWords[i >>> 2] >>> 24 - i % 4 * 8 & 255;
						thisWords[thisSigBytes + i >>> 2] |= thatByte << 24 - (thisSigBytes + i) % 4 * 8;
					}}
					else {for (var j = 0; j < thatSigBytes; j += 4) thisWords[thisSigBytes + j >>> 2] = thatWords[j >>> 2];}
					this.sigBytes += thatSigBytes;
					return this;
				},
				clamp: function() {
					var words = this.words;
					var sigBytes = this.sigBytes;
					words[sigBytes >>> 2] &= 4294967295 << 32 - sigBytes % 4 * 8;
					words.length = Math.ceil(sigBytes / 4);
				},
				clone: function() {
					var clone = Base.clone.call(this);
					clone.words = this.words.slice(0);
					return clone;
				},
				random: function(nBytes) {
					var words = [];
					for (var i = 0; i < nBytes; i += 4) {words.push(cryptoSecureRandomInt());}
					return new WordArray.init(words, nBytes);
				}
			});
			/**
			* Encoder namespace.
			*/
			var C_enc = C.enc = {};
			/**
			* Hex encoding strategy.
			*/
			var Hex = C_enc.Hex = {
				stringify: function(wordArray) {
					var words = wordArray.words;
					var sigBytes = wordArray.sigBytes;
					var hexChars = [];
					for (var i = 0; i < sigBytes; i++) {
						var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
						hexChars.push((bite >>> 4).toString(16));
						hexChars.push((bite & 15).toString(16));
					}
					return hexChars.join("");
				},
				parse: function(hexStr) {
					var hexStrLength = hexStr.length;
					var words = [];
					for (var i = 0; i < hexStrLength; i += 2) {words[i >>> 3] |= parseInt(hexStr.substr(i, 2), 16) << 24 - i % 8 * 4;}
					return new WordArray.init(words, hexStrLength / 2);
				}
			};
			/**
			* Latin1 encoding strategy.
			*/
			var Latin1 = C_enc.Latin1 = {
				stringify: function(wordArray) {
					var words = wordArray.words;
					var sigBytes = wordArray.sigBytes;
					var latin1Chars = [];
					for (var i = 0; i < sigBytes; i++) {
						var bite = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
						latin1Chars.push(String.fromCharCode(bite));
					}
					return latin1Chars.join("");
				},
				parse: function(latin1Str) {
					var latin1StrLength = latin1Str.length;
					var words = [];
					for (var i = 0; i < latin1StrLength; i++) {words[i >>> 2] |= (latin1Str.charCodeAt(i) & 255) << 24 - i % 4 * 8;}
					return new WordArray.init(words, latin1StrLength);
				}
			};
			/**
			* UTF-8 encoding strategy.
			*/
			var Utf8 = C_enc.Utf8 = {
				stringify: function(wordArray) {
					try {
						return decodeURIComponent(escape(Latin1.stringify(wordArray)));
					} catch (e) {
						throw new Error("Malformed UTF-8 data", { cause: e });
					}
				},
				parse: function(utf8Str) {
					return Latin1.parse(unescape(encodeURIComponent(utf8Str)));
				}
			};
			/**
			* Abstract buffered block algorithm template.
			*
			* The property blockSize must be implemented in a concrete subtype.
			*
			* @property {number} _minBufferSize The number of blocks that should be kept unprocessed in the buffer. Default: 0
			*/
			var BufferedBlockAlgorithm = C_lib.BufferedBlockAlgorithm = Base.extend({
				reset: function() {
					this._data = new WordArray.init();
					this._nDataBytes = 0;
				},
				_append: function(data) {
					if (typeof data == "string") {data = Utf8.parse(data);}
					this._data.concat(data);
					this._nDataBytes += data.sigBytes;
				},
				_process: function(doFlush) {
					var processedWords;
					var data = this._data;
					var dataWords = data.words;
					var dataSigBytes = data.sigBytes;
					var blockSize = this.blockSize;
					var nBlocksReady = dataSigBytes / (blockSize * 4);
					if (doFlush) {nBlocksReady = Math.ceil(nBlocksReady);}
					else {nBlocksReady = Math.max((nBlocksReady | 0) - this._minBufferSize, 0);}
					var nWordsReady = nBlocksReady * blockSize;
					var nBytesReady = Math.min(nWordsReady * 4, dataSigBytes);
					if (nWordsReady) {
						for (var offset = 0; offset < nWordsReady; offset += blockSize) {this._doProcessBlock(dataWords, offset);}
						processedWords = dataWords.splice(0, nWordsReady);
						data.sigBytes -= nBytesReady;
					}
					return new WordArray.init(processedWords, nBytesReady);
				},
				clone: function() {
					var clone = Base.clone.call(this);
					clone._data = this._data.clone();
					return clone;
				},
				_minBufferSize: 0
			});
			C_lib.Hasher = BufferedBlockAlgorithm.extend({
				cfg: Base.extend(),
				init: function(cfg) {
					this.cfg = this.cfg.extend(cfg);
					this.reset();
				},
				reset: function() {
					BufferedBlockAlgorithm.reset.call(this);
					this._doReset();
				},
				update: function(messageUpdate) {
					this._append(messageUpdate);
					this._process();
					return this;
				},
				finalize: function(messageUpdate) {
					if (messageUpdate) {this._append(messageUpdate);}
					return this._doFinalize();
				},
				blockSize: 512 / 32,
				_createHelper: function(hasher) {
					return function(message, cfg) {
						return new hasher.init(cfg).finalize(message);
					};
				},
				_createHmacHelper: function(hasher) {
					return function(message, key) {
						return new C_algo.HMAC.init(hasher, key).finalize(message);
					};
				}
			});
			/**
			* Algorithm namespace.
			*/
			var C_algo = C.algo = {};
			return C;
		}(Math);
		return CryptoJS;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/x64-core.js
var require_x64_core = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function(undefined) {
			var C = CryptoJS;
			var C_lib = C.lib;
			var Base = C_lib.Base;
			var X32WordArray = C_lib.WordArray;
			/**
			* x64 namespace.
			*/
			var C_x64 = C.x64 = {};
			C_x64.Word = Base.extend({ init: function(high, low) {
				this.high = high;
				this.low = low;
			} });
			C_x64.WordArray = Base.extend({
				init: function(words, sigBytes) {
					words = this.words = words || [];
					if (sigBytes != undefined) {this.sigBytes = sigBytes;}
					else {this.sigBytes = words.length * 8;}
				},
				toX32: function() {
					var x64Words = this.words;
					var x64WordsLength = x64Words.length;
					var x32Words = [];
					for (var i = 0; i < x64WordsLength; i++) {
						var x64Word = x64Words[i];
						x32Words.push(x64Word.high);
						x32Words.push(x64Word.low);
					}
					return X32WordArray.create(x32Words, this.sigBytes);
				},
				clone: function() {
					var clone = Base.clone.call(this);
					var words = clone.words = this.words.slice(0);
					var wordsLength = words.length;
					for (var i = 0; i < wordsLength; i++) {words[i] = words[i].clone();}
					return clone;
				}
			});
		})();
		return CryptoJS;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/lib-typedarrays.js
var require_lib_typedarrays = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			if (typeof ArrayBuffer != "function") {return;}
			var WordArray = CryptoJS.lib.WordArray;
			var superInit = WordArray.init;
			var subInit = WordArray.init = function(typedArray) {
				if (typedArray instanceof ArrayBuffer) {typedArray = new Uint8Array(typedArray);}
				if (typedArray instanceof Int8Array || typeof Uint8ClampedArray !== "undefined" && typedArray instanceof Uint8ClampedArray || typedArray instanceof Int16Array || typedArray instanceof Uint16Array || typedArray instanceof Int32Array || typedArray instanceof Uint32Array || typedArray instanceof Float32Array || typedArray instanceof Float64Array) {typedArray = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);}
				if (typedArray instanceof Uint8Array) {
					var typedArrayByteLength = typedArray.byteLength;
					var words = [];
					for (var i = 0; i < typedArrayByteLength; i++) {words[i >>> 2] |= typedArray[i] << 24 - i % 4 * 8;}
					superInit.call(this, words, typedArrayByteLength);
				} else {superInit.apply(this, arguments);}
			};
			subInit.prototype = WordArray;
		})();
		return CryptoJS.lib.WordArray;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/enc-utf16.js
var require_enc_utf16 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var WordArray = C.lib.WordArray;
			var C_enc = C.enc;
			C_enc.Utf16 = C_enc.Utf16BE = {
				stringify: function(wordArray) {
					var words = wordArray.words;
					var sigBytes = wordArray.sigBytes;
					var utf16Chars = [];
					for (var i = 0; i < sigBytes; i += 2) {
						var codePoint = words[i >>> 2] >>> 16 - i % 4 * 8 & 65535;
						utf16Chars.push(String.fromCharCode(codePoint));
					}
					return utf16Chars.join("");
				},
				parse: function(utf16Str) {
					var utf16StrLength = utf16Str.length;
					var words = [];
					for (var i = 0; i < utf16StrLength; i++) {words[i >>> 1] |= utf16Str.charCodeAt(i) << 16 - i % 2 * 16;}
					return WordArray.create(words, utf16StrLength * 2);
				}
			};
			/**
			* UTF-16 LE encoding strategy.
			*/
			C_enc.Utf16LE = {
				stringify: function(wordArray) {
					var words = wordArray.words;
					var sigBytes = wordArray.sigBytes;
					var utf16Chars = [];
					for (var i = 0; i < sigBytes; i += 2) {
						var codePoint = swapEndian(words[i >>> 2] >>> 16 - i % 4 * 8 & 65535);
						utf16Chars.push(String.fromCharCode(codePoint));
					}
					return utf16Chars.join("");
				},
				parse: function(utf16Str) {
					var utf16StrLength = utf16Str.length;
					var words = [];
					for (var i = 0; i < utf16StrLength; i++) {words[i >>> 1] |= swapEndian(utf16Str.charCodeAt(i) << 16 - i % 2 * 16);}
					return WordArray.create(words, utf16StrLength * 2);
				}
			};
			function swapEndian(word) {
				return word << 8 & 4278255360 | word >>> 8 & 16711935;
			}
		})();
		return CryptoJS.enc.Utf16;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/enc-base64.js
var require_enc_base64 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var WordArray = C.lib.WordArray;
			var C_enc = C.enc;
			C_enc.Base64 = {
				stringify: function(wordArray) {
					var words = wordArray.words;
					var sigBytes = wordArray.sigBytes;
					var map = this._map;
					wordArray.clamp();
					var base64Chars = [];
					for (var i = 0; i < sigBytes; i += 3) {
						var byte1 = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
						var byte2 = words[i + 1 >>> 2] >>> 24 - (i + 1) % 4 * 8 & 255;
						var byte3 = words[i + 2 >>> 2] >>> 24 - (i + 2) % 4 * 8 & 255;
						var triplet = byte1 << 16 | byte2 << 8 | byte3;
						for (var j = 0; j < 4 && i + j * .75 < sigBytes; j++) {base64Chars.push(map.charAt(triplet >>> 6 * (3 - j) & 63));}
					}
					var paddingChar = map.charAt(64);
					if (paddingChar) {while (base64Chars.length % 4) base64Chars.push(paddingChar);}
					return base64Chars.join("");
				},
				parse: function(base64Str) {
					var base64StrLength = base64Str.length;
					var map = this._map;
					var reverseMap = this._reverseMap;
					if (!reverseMap) {
						reverseMap = this._reverseMap = [];
						for (var j = 0; j < map.length; j++) {reverseMap[map.charCodeAt(j)] = j;}
					}
					var paddingChar = map.charAt(64);
					if (paddingChar) {
						var paddingIndex = base64Str.indexOf(paddingChar);
						if (paddingIndex !== -1) {base64StrLength = paddingIndex;}
					}
					return parseLoop(base64Str, base64StrLength, reverseMap);
				},
				_map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
			};
			function parseLoop(base64Str, base64StrLength, reverseMap) {
				var words = [];
				var nBytes = 0;
				for (var i = 0; i < base64StrLength; i++) {if (i % 4) {
					var bitsCombined = reverseMap[base64Str.charCodeAt(i - 1)] << i % 4 * 2 | reverseMap[base64Str.charCodeAt(i)] >>> 6 - i % 4 * 2;
					words[nBytes >>> 2] |= bitsCombined << 24 - nBytes % 4 * 8;
					nBytes++;
				}}
				return WordArray.create(words, nBytes);
			}
		})();
		return CryptoJS.enc.Base64;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/enc-base64url.js
var require_enc_base64url = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var WordArray = C.lib.WordArray;
			var C_enc = C.enc;
			C_enc.Base64url = {
				stringify: function(wordArray, urlSafe) {
					if (urlSafe === void 0) {urlSafe = true;}
					var words = wordArray.words;
					var sigBytes = wordArray.sigBytes;
					var map = urlSafe ? this._safe_map : this._map;
					wordArray.clamp();
					var base64Chars = [];
					for (var i = 0; i < sigBytes; i += 3) {
						var byte1 = words[i >>> 2] >>> 24 - i % 4 * 8 & 255;
						var byte2 = words[i + 1 >>> 2] >>> 24 - (i + 1) % 4 * 8 & 255;
						var byte3 = words[i + 2 >>> 2] >>> 24 - (i + 2) % 4 * 8 & 255;
						var triplet = byte1 << 16 | byte2 << 8 | byte3;
						for (var j = 0; j < 4 && i + j * .75 < sigBytes; j++) {base64Chars.push(map.charAt(triplet >>> 6 * (3 - j) & 63));}
					}
					var paddingChar = map.charAt(64);
					if (paddingChar) {while (base64Chars.length % 4) base64Chars.push(paddingChar);}
					return base64Chars.join("");
				},
				parse: function(base64Str, urlSafe) {
					if (urlSafe === void 0) {urlSafe = true;}
					var base64StrLength = base64Str.length;
					var map = urlSafe ? this._safe_map : this._map;
					var reverseMap = this._reverseMap;
					if (!reverseMap) {
						reverseMap = this._reverseMap = [];
						for (var j = 0; j < map.length; j++) {reverseMap[map.charCodeAt(j)] = j;}
					}
					var paddingChar = map.charAt(64);
					if (paddingChar) {
						var paddingIndex = base64Str.indexOf(paddingChar);
						if (paddingIndex !== -1) {base64StrLength = paddingIndex;}
					}
					return parseLoop(base64Str, base64StrLength, reverseMap);
				},
				_map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
				_safe_map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
			};
			function parseLoop(base64Str, base64StrLength, reverseMap) {
				var words = [];
				var nBytes = 0;
				for (var i = 0; i < base64StrLength; i++) {if (i % 4) {
					var bitsCombined = reverseMap[base64Str.charCodeAt(i - 1)] << i % 4 * 2 | reverseMap[base64Str.charCodeAt(i)] >>> 6 - i % 4 * 2;
					words[nBytes >>> 2] |= bitsCombined << 24 - nBytes % 4 * 8;
					nBytes++;
				}}
				return WordArray.create(words, nBytes);
			}
		})();
		return CryptoJS.enc.Base64url;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/md5.js
var require_md5 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function(Math) {
			var C = CryptoJS;
			var C_lib = C.lib;
			var WordArray = C_lib.WordArray;
			var Hasher = C_lib.Hasher;
			var C_algo = C.algo;
			var T = [];
			(function() {
				for (var i = 0; i < 64; i++) {T[i] = Math.abs(Math.sin(i + 1)) * 4294967296 | 0;}
			})();
			/**
			* MD5 hash algorithm.
			*/
			var MD5 = C_algo.MD5 = Hasher.extend({
				_doReset: function() {
					this._hash = new WordArray.init([
						1732584193,
						4023233417,
						2562383102,
						271733878
					]);
				},
				_doProcessBlock: function(M, offset) {
					for (var i = 0; i < 16; i++) {
						var offset_i = offset + i;
						var M_offset_i = M[offset_i];
						M[offset_i] = (M_offset_i << 8 | M_offset_i >>> 24) & 16711935 | (M_offset_i << 24 | M_offset_i >>> 8) & 4278255360;
					}
					var H = this._hash.words;
					var M_offset_0 = M[offset + 0];
					var M_offset_1 = M[offset + 1];
					var M_offset_2 = M[offset + 2];
					var M_offset_3 = M[offset + 3];
					var M_offset_4 = M[offset + 4];
					var M_offset_5 = M[offset + 5];
					var M_offset_6 = M[offset + 6];
					var M_offset_7 = M[offset + 7];
					var M_offset_8 = M[offset + 8];
					var M_offset_9 = M[offset + 9];
					var M_offset_10 = M[offset + 10];
					var M_offset_11 = M[offset + 11];
					var M_offset_12 = M[offset + 12];
					var M_offset_13 = M[offset + 13];
					var M_offset_14 = M[offset + 14];
					var M_offset_15 = M[offset + 15];
					var a = H[0];
					var b = H[1];
					var c = H[2];
					var d = H[3];
					a = FF(a, b, c, d, M_offset_0, 7, T[0]);
					d = FF(d, a, b, c, M_offset_1, 12, T[1]);
					c = FF(c, d, a, b, M_offset_2, 17, T[2]);
					b = FF(b, c, d, a, M_offset_3, 22, T[3]);
					a = FF(a, b, c, d, M_offset_4, 7, T[4]);
					d = FF(d, a, b, c, M_offset_5, 12, T[5]);
					c = FF(c, d, a, b, M_offset_6, 17, T[6]);
					b = FF(b, c, d, a, M_offset_7, 22, T[7]);
					a = FF(a, b, c, d, M_offset_8, 7, T[8]);
					d = FF(d, a, b, c, M_offset_9, 12, T[9]);
					c = FF(c, d, a, b, M_offset_10, 17, T[10]);
					b = FF(b, c, d, a, M_offset_11, 22, T[11]);
					a = FF(a, b, c, d, M_offset_12, 7, T[12]);
					d = FF(d, a, b, c, M_offset_13, 12, T[13]);
					c = FF(c, d, a, b, M_offset_14, 17, T[14]);
					b = FF(b, c, d, a, M_offset_15, 22, T[15]);
					a = GG(a, b, c, d, M_offset_1, 5, T[16]);
					d = GG(d, a, b, c, M_offset_6, 9, T[17]);
					c = GG(c, d, a, b, M_offset_11, 14, T[18]);
					b = GG(b, c, d, a, M_offset_0, 20, T[19]);
					a = GG(a, b, c, d, M_offset_5, 5, T[20]);
					d = GG(d, a, b, c, M_offset_10, 9, T[21]);
					c = GG(c, d, a, b, M_offset_15, 14, T[22]);
					b = GG(b, c, d, a, M_offset_4, 20, T[23]);
					a = GG(a, b, c, d, M_offset_9, 5, T[24]);
					d = GG(d, a, b, c, M_offset_14, 9, T[25]);
					c = GG(c, d, a, b, M_offset_3, 14, T[26]);
					b = GG(b, c, d, a, M_offset_8, 20, T[27]);
					a = GG(a, b, c, d, M_offset_13, 5, T[28]);
					d = GG(d, a, b, c, M_offset_2, 9, T[29]);
					c = GG(c, d, a, b, M_offset_7, 14, T[30]);
					b = GG(b, c, d, a, M_offset_12, 20, T[31]);
					a = HH(a, b, c, d, M_offset_5, 4, T[32]);
					d = HH(d, a, b, c, M_offset_8, 11, T[33]);
					c = HH(c, d, a, b, M_offset_11, 16, T[34]);
					b = HH(b, c, d, a, M_offset_14, 23, T[35]);
					a = HH(a, b, c, d, M_offset_1, 4, T[36]);
					d = HH(d, a, b, c, M_offset_4, 11, T[37]);
					c = HH(c, d, a, b, M_offset_7, 16, T[38]);
					b = HH(b, c, d, a, M_offset_10, 23, T[39]);
					a = HH(a, b, c, d, M_offset_13, 4, T[40]);
					d = HH(d, a, b, c, M_offset_0, 11, T[41]);
					c = HH(c, d, a, b, M_offset_3, 16, T[42]);
					b = HH(b, c, d, a, M_offset_6, 23, T[43]);
					a = HH(a, b, c, d, M_offset_9, 4, T[44]);
					d = HH(d, a, b, c, M_offset_12, 11, T[45]);
					c = HH(c, d, a, b, M_offset_15, 16, T[46]);
					b = HH(b, c, d, a, M_offset_2, 23, T[47]);
					a = II(a, b, c, d, M_offset_0, 6, T[48]);
					d = II(d, a, b, c, M_offset_7, 10, T[49]);
					c = II(c, d, a, b, M_offset_14, 15, T[50]);
					b = II(b, c, d, a, M_offset_5, 21, T[51]);
					a = II(a, b, c, d, M_offset_12, 6, T[52]);
					d = II(d, a, b, c, M_offset_3, 10, T[53]);
					c = II(c, d, a, b, M_offset_10, 15, T[54]);
					b = II(b, c, d, a, M_offset_1, 21, T[55]);
					a = II(a, b, c, d, M_offset_8, 6, T[56]);
					d = II(d, a, b, c, M_offset_15, 10, T[57]);
					c = II(c, d, a, b, M_offset_6, 15, T[58]);
					b = II(b, c, d, a, M_offset_13, 21, T[59]);
					a = II(a, b, c, d, M_offset_4, 6, T[60]);
					d = II(d, a, b, c, M_offset_11, 10, T[61]);
					c = II(c, d, a, b, M_offset_2, 15, T[62]);
					b = II(b, c, d, a, M_offset_9, 21, T[63]);
					H[0] = H[0] + a | 0;
					H[1] = H[1] + b | 0;
					H[2] = H[2] + c | 0;
					H[3] = H[3] + d | 0;
				},
				_doFinalize: function() {
					var data = this._data;
					var dataWords = data.words;
					var nBitsTotal = this._nDataBytes * 8;
					var nBitsLeft = data.sigBytes * 8;
					dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
					var nBitsTotalH = Math.floor(nBitsTotal / 4294967296);
					var nBitsTotalL = nBitsTotal;
					dataWords[(nBitsLeft + 64 >>> 9 << 4) + 15] = (nBitsTotalH << 8 | nBitsTotalH >>> 24) & 16711935 | (nBitsTotalH << 24 | nBitsTotalH >>> 8) & 4278255360;
					dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = (nBitsTotalL << 8 | nBitsTotalL >>> 24) & 16711935 | (nBitsTotalL << 24 | nBitsTotalL >>> 8) & 4278255360;
					data.sigBytes = (dataWords.length + 1) * 4;
					this._process();
					var hash = this._hash;
					var H = hash.words;
					for (var i = 0; i < 4; i++) {
						var H_i = H[i];
						H[i] = (H_i << 8 | H_i >>> 24) & 16711935 | (H_i << 24 | H_i >>> 8) & 4278255360;
					}
					return hash;
				},
				clone: function() {
					var clone = Hasher.clone.call(this);
					clone._hash = this._hash.clone();
					return clone;
				}
			});
			function FF(a, b, c, d, x, s, t) {
				var n = a + (b & c | ~b & d) + x + t;
				return (n << s | n >>> 32 - s) + b;
			}
			function GG(a, b, c, d, x, s, t) {
				var n = a + (b & d | c & ~d) + x + t;
				return (n << s | n >>> 32 - s) + b;
			}
			function HH(a, b, c, d, x, s, t) {
				var n = a + (b ^ c ^ d) + x + t;
				return (n << s | n >>> 32 - s) + b;
			}
			function II(a, b, c, d, x, s, t) {
				var n = a + (c ^ (b | ~d)) + x + t;
				return (n << s | n >>> 32 - s) + b;
			}
			/**
			* Shortcut function to the hasher's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			*
			* @return {WordArray} The hash.
			*
			* @static
			*
			* @example
			*
			*     var hash = CryptoJS.MD5('message');
			*     var hash = CryptoJS.MD5(wordArray);
			*/
			C.MD5 = Hasher._createHelper(MD5);
			/**
			* Shortcut function to the HMAC's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			* @param {WordArray|string} key The secret key.
			*
			* @return {WordArray} The HMAC.
			*
			* @static
			*
			* @example
			*
			*     var hmac = CryptoJS.HmacMD5(message, key);
			*/
			C.HmacMD5 = Hasher._createHmacHelper(MD5);
		})(Math);
		return CryptoJS.MD5;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/sha1.js
var require_sha1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var C_lib = C.lib;
			var WordArray = C_lib.WordArray;
			var Hasher = C_lib.Hasher;
			var C_algo = C.algo;
			var W = [];
			/**
			* SHA-1 hash algorithm.
			*/
			var SHA1 = C_algo.SHA1 = Hasher.extend({
				_doReset: function() {
					this._hash = new WordArray.init([
						1732584193,
						4023233417,
						2562383102,
						271733878,
						3285377520
					]);
				},
				_doProcessBlock: function(M, offset) {
					var H = this._hash.words;
					var a = H[0];
					var b = H[1];
					var c = H[2];
					var d = H[3];
					var e = H[4];
					for (var i = 0; i < 80; i++) {
						if (i < 16) {W[i] = M[offset + i] | 0;}
						else {
							var n = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
							W[i] = n << 1 | n >>> 31;
						}
						var t = (a << 5 | a >>> 27) + e + W[i];
						if (i < 20) {t += (b & c | ~b & d) + 1518500249;}
						else if (i < 40) {t += (b ^ c ^ d) + 1859775393;}
						else if (i < 60) {t += (b & c | b & d | c & d) - 1894007588;}
						else {t += (b ^ c ^ d) - 899497514;}
						e = d;
						d = c;
						c = b << 30 | b >>> 2;
						b = a;
						a = t;
					}
					H[0] = H[0] + a | 0;
					H[1] = H[1] + b | 0;
					H[2] = H[2] + c | 0;
					H[3] = H[3] + d | 0;
					H[4] = H[4] + e | 0;
				},
				_doFinalize: function() {
					var data = this._data;
					var dataWords = data.words;
					var nBitsTotal = this._nDataBytes * 8;
					var nBitsLeft = data.sigBytes * 8;
					dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
					dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = Math.floor(nBitsTotal / 4294967296);
					dataWords[(nBitsLeft + 64 >>> 9 << 4) + 15] = nBitsTotal;
					data.sigBytes = dataWords.length * 4;
					this._process();
					return this._hash;
				},
				clone: function() {
					var clone = Hasher.clone.call(this);
					clone._hash = this._hash.clone();
					return clone;
				}
			});
			/**
			* Shortcut function to the hasher's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			*
			* @return {WordArray} The hash.
			*
			* @static
			*
			* @example
			*
			*     var hash = CryptoJS.SHA1('message');
			*     var hash = CryptoJS.SHA1(wordArray);
			*/
			C.SHA1 = Hasher._createHelper(SHA1);
			/**
			* Shortcut function to the HMAC's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			* @param {WordArray|string} key The secret key.
			*
			* @return {WordArray} The HMAC.
			*
			* @static
			*
			* @example
			*
			*     var hmac = CryptoJS.HmacSHA1(message, key);
			*/
			C.HmacSHA1 = Hasher._createHmacHelper(SHA1);
		})();
		return CryptoJS.SHA1;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/sha256.js
var require_sha256 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function(Math) {
			var C = CryptoJS;
			var C_lib = C.lib;
			var WordArray = C_lib.WordArray;
			var Hasher = C_lib.Hasher;
			var C_algo = C.algo;
			var H = [];
			var K = [];
			(function() {
				function isPrime(n) {
					var sqrtN = Math.sqrt(n);
					for (var factor = 2; factor <= sqrtN; factor++) {if (!(n % factor)) return false;}
					return true;
				}
				function getFractionalBits(n) {
					return (n - (n | 0)) * 4294967296 | 0;
				}
				var n = 2;
				var nPrime = 0;
				while (nPrime < 64) {
					if (isPrime(n)) {
						if (nPrime < 8) {H[nPrime] = getFractionalBits(Math.pow(n, 1 / 2));}
						K[nPrime] = getFractionalBits(Math.pow(n, 1 / 3));
						nPrime++;
					}
					n++;
				}
			})();
			var W = [];
			/**
			* SHA-256 hash algorithm.
			*/
			var SHA256 = C_algo.SHA256 = Hasher.extend({
				_doReset: function() {
					this._hash = new WordArray.init(H.slice(0));
				},
				_doProcessBlock: function(M, offset) {
					var H = this._hash.words;
					var a = H[0];
					var b = H[1];
					var c = H[2];
					var d = H[3];
					var e = H[4];
					var f = H[5];
					var g = H[6];
					var h = H[7];
					for (var i = 0; i < 64; i++) {
						if (i < 16) {W[i] = M[offset + i] | 0;}
						else {
							var gamma0x = W[i - 15];
							var gamma0 = (gamma0x << 25 | gamma0x >>> 7) ^ (gamma0x << 14 | gamma0x >>> 18) ^ gamma0x >>> 3;
							var gamma1x = W[i - 2];
							var gamma1 = (gamma1x << 15 | gamma1x >>> 17) ^ (gamma1x << 13 | gamma1x >>> 19) ^ gamma1x >>> 10;
							W[i] = gamma0 + W[i - 7] + gamma1 + W[i - 16];
						}
						var ch = e & f ^ ~e & g;
						var maj = a & b ^ a & c ^ b & c;
						var sigma0 = (a << 30 | a >>> 2) ^ (a << 19 | a >>> 13) ^ (a << 10 | a >>> 22);
						var sigma1 = (e << 26 | e >>> 6) ^ (e << 21 | e >>> 11) ^ (e << 7 | e >>> 25);
						var t1 = h + sigma1 + ch + K[i] + W[i];
						var t2 = sigma0 + maj;
						h = g;
						g = f;
						f = e;
						e = d + t1 | 0;
						d = c;
						c = b;
						b = a;
						a = t1 + t2 | 0;
					}
					H[0] = H[0] + a | 0;
					H[1] = H[1] + b | 0;
					H[2] = H[2] + c | 0;
					H[3] = H[3] + d | 0;
					H[4] = H[4] + e | 0;
					H[5] = H[5] + f | 0;
					H[6] = H[6] + g | 0;
					H[7] = H[7] + h | 0;
				},
				_doFinalize: function() {
					var data = this._data;
					var dataWords = data.words;
					var nBitsTotal = this._nDataBytes * 8;
					var nBitsLeft = data.sigBytes * 8;
					dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
					dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = Math.floor(nBitsTotal / 4294967296);
					dataWords[(nBitsLeft + 64 >>> 9 << 4) + 15] = nBitsTotal;
					data.sigBytes = dataWords.length * 4;
					this._process();
					return this._hash;
				},
				clone: function() {
					var clone = Hasher.clone.call(this);
					clone._hash = this._hash.clone();
					return clone;
				}
			});
			/**
			* Shortcut function to the hasher's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			*
			* @return {WordArray} The hash.
			*
			* @static
			*
			* @example
			*
			*     var hash = CryptoJS.SHA256('message');
			*     var hash = CryptoJS.SHA256(wordArray);
			*/
			C.SHA256 = Hasher._createHelper(SHA256);
			/**
			* Shortcut function to the HMAC's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			* @param {WordArray|string} key The secret key.
			*
			* @return {WordArray} The HMAC.
			*
			* @static
			*
			* @example
			*
			*     var hmac = CryptoJS.HmacSHA256(message, key);
			*/
			C.HmacSHA256 = Hasher._createHmacHelper(SHA256);
		})(Math);
		return CryptoJS.SHA256;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/sha224.js
var require_sha224 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_sha256());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./sha256"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var WordArray = C.lib.WordArray;
			var C_algo = C.algo;
			var SHA256 = C_algo.SHA256;
			/**
			* SHA-224 hash algorithm.
			*/
			var SHA224 = C_algo.SHA224 = SHA256.extend({
				_doReset: function() {
					this._hash = new WordArray.init([
						3238371032,
						914150663,
						812702999,
						4144912697,
						4290775857,
						1750603025,
						1694076839,
						3204075428
					]);
				},
				_doFinalize: function() {
					var hash = SHA256._doFinalize.call(this);
					hash.sigBytes -= 4;
					return hash;
				}
			});
			/**
			* Shortcut function to the hasher's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			*
			* @return {WordArray} The hash.
			*
			* @static
			*
			* @example
			*
			*     var hash = CryptoJS.SHA224('message');
			*     var hash = CryptoJS.SHA224(wordArray);
			*/
			C.SHA224 = SHA256._createHelper(SHA224);
			/**
			* Shortcut function to the HMAC's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			* @param {WordArray|string} key The secret key.
			*
			* @return {WordArray} The HMAC.
			*
			* @static
			*
			* @example
			*
			*     var hmac = CryptoJS.HmacSHA224(message, key);
			*/
			C.HmacSHA224 = SHA256._createHmacHelper(SHA224);
		})();
		return CryptoJS.SHA224;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/sha512.js
var require_sha512 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_x64_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./x64-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var Hasher = C.lib.Hasher;
			var C_x64 = C.x64;
			var X64Word = C_x64.Word;
			var X64WordArray = C_x64.WordArray;
			var C_algo = C.algo;
			function X64Word_create() {
				return X64Word.create.apply(X64Word, arguments);
			}
			var K = [
				X64Word_create(1116352408, 3609767458),
				X64Word_create(1899447441, 602891725),
				X64Word_create(3049323471, 3964484399),
				X64Word_create(3921009573, 2173295548),
				X64Word_create(961987163, 4081628472),
				X64Word_create(1508970993, 3053834265),
				X64Word_create(2453635748, 2937671579),
				X64Word_create(2870763221, 3664609560),
				X64Word_create(3624381080, 2734883394),
				X64Word_create(310598401, 1164996542),
				X64Word_create(607225278, 1323610764),
				X64Word_create(1426881987, 3590304994),
				X64Word_create(1925078388, 4068182383),
				X64Word_create(2162078206, 991336113),
				X64Word_create(2614888103, 633803317),
				X64Word_create(3248222580, 3479774868),
				X64Word_create(3835390401, 2666613458),
				X64Word_create(4022224774, 944711139),
				X64Word_create(264347078, 2341262773),
				X64Word_create(604807628, 2007800933),
				X64Word_create(770255983, 1495990901),
				X64Word_create(1249150122, 1856431235),
				X64Word_create(1555081692, 3175218132),
				X64Word_create(1996064986, 2198950837),
				X64Word_create(2554220882, 3999719339),
				X64Word_create(2821834349, 766784016),
				X64Word_create(2952996808, 2566594879),
				X64Word_create(3210313671, 3203337956),
				X64Word_create(3336571891, 1034457026),
				X64Word_create(3584528711, 2466948901),
				X64Word_create(113926993, 3758326383),
				X64Word_create(338241895, 168717936),
				X64Word_create(666307205, 1188179964),
				X64Word_create(773529912, 1546045734),
				X64Word_create(1294757372, 1522805485),
				X64Word_create(1396182291, 2643833823),
				X64Word_create(1695183700, 2343527390),
				X64Word_create(1986661051, 1014477480),
				X64Word_create(2177026350, 1206759142),
				X64Word_create(2456956037, 344077627),
				X64Word_create(2730485921, 1290863460),
				X64Word_create(2820302411, 3158454273),
				X64Word_create(3259730800, 3505952657),
				X64Word_create(3345764771, 106217008),
				X64Word_create(3516065817, 3606008344),
				X64Word_create(3600352804, 1432725776),
				X64Word_create(4094571909, 1467031594),
				X64Word_create(275423344, 851169720),
				X64Word_create(430227734, 3100823752),
				X64Word_create(506948616, 1363258195),
				X64Word_create(659060556, 3750685593),
				X64Word_create(883997877, 3785050280),
				X64Word_create(958139571, 3318307427),
				X64Word_create(1322822218, 3812723403),
				X64Word_create(1537002063, 2003034995),
				X64Word_create(1747873779, 3602036899),
				X64Word_create(1955562222, 1575990012),
				X64Word_create(2024104815, 1125592928),
				X64Word_create(2227730452, 2716904306),
				X64Word_create(2361852424, 442776044),
				X64Word_create(2428436474, 593698344),
				X64Word_create(2756734187, 3733110249),
				X64Word_create(3204031479, 2999351573),
				X64Word_create(3329325298, 3815920427),
				X64Word_create(3391569614, 3928383900),
				X64Word_create(3515267271, 566280711),
				X64Word_create(3940187606, 3454069534),
				X64Word_create(4118630271, 4000239992),
				X64Word_create(116418474, 1914138554),
				X64Word_create(174292421, 2731055270),
				X64Word_create(289380356, 3203993006),
				X64Word_create(460393269, 320620315),
				X64Word_create(685471733, 587496836),
				X64Word_create(852142971, 1086792851),
				X64Word_create(1017036298, 365543100),
				X64Word_create(1126000580, 2618297676),
				X64Word_create(1288033470, 3409855158),
				X64Word_create(1501505948, 4234509866),
				X64Word_create(1607167915, 987167468),
				X64Word_create(1816402316, 1246189591)
			];
			var W = [];
			(function() {
				for (var i = 0; i < 80; i++) {W[i] = X64Word_create();}
			})();
			/**
			* SHA-512 hash algorithm.
			*/
			var SHA512 = C_algo.SHA512 = Hasher.extend({
				_doReset: function() {
					this._hash = new X64WordArray.init([
						new X64Word.init(1779033703, 4089235720),
						new X64Word.init(3144134277, 2227873595),
						new X64Word.init(1013904242, 4271175723),
						new X64Word.init(2773480762, 1595750129),
						new X64Word.init(1359893119, 2917565137),
						new X64Word.init(2600822924, 725511199),
						new X64Word.init(528734635, 4215389547),
						new X64Word.init(1541459225, 327033209)
					]);
				},
				_doProcessBlock: function(M, offset) {
					var H = this._hash.words;
					var H0 = H[0];
					var H1 = H[1];
					var H2 = H[2];
					var H3 = H[3];
					var H4 = H[4];
					var H5 = H[5];
					var H6 = H[6];
					var H7 = H[7];
					var H0h = H0.high;
					var H0l = H0.low;
					var H1h = H1.high;
					var H1l = H1.low;
					var H2h = H2.high;
					var H2l = H2.low;
					var H3h = H3.high;
					var H3l = H3.low;
					var H4h = H4.high;
					var H4l = H4.low;
					var H5h = H5.high;
					var H5l = H5.low;
					var H6h = H6.high;
					var H6l = H6.low;
					var H7h = H7.high;
					var H7l = H7.low;
					var ah = H0h;
					var al = H0l;
					var bh = H1h;
					var bl = H1l;
					var ch = H2h;
					var cl = H2l;
					var dh = H3h;
					var dl = H3l;
					var eh = H4h;
					var el = H4l;
					var fh = H5h;
					var fl = H5l;
					var gh = H6h;
					var gl = H6l;
					var hh = H7h;
					var hl = H7l;
					for (var i = 0; i < 80; i++) {
						var Wil;
						var Wih;
						var Wi = W[i];
						if (i < 16) {
							Wih = Wi.high = M[offset + i * 2] | 0;
							Wil = Wi.low = M[offset + i * 2 + 1] | 0;
						} else {
							var gamma0x = W[i - 15];
							var gamma0xh = gamma0x.high;
							var gamma0xl = gamma0x.low;
							var gamma0h = (gamma0xh >>> 1 | gamma0xl << 31) ^ (gamma0xh >>> 8 | gamma0xl << 24) ^ gamma0xh >>> 7;
							var gamma0l = (gamma0xl >>> 1 | gamma0xh << 31) ^ (gamma0xl >>> 8 | gamma0xh << 24) ^ (gamma0xl >>> 7 | gamma0xh << 25);
							var gamma1x = W[i - 2];
							var gamma1xh = gamma1x.high;
							var gamma1xl = gamma1x.low;
							var gamma1h = (gamma1xh >>> 19 | gamma1xl << 13) ^ (gamma1xh << 3 | gamma1xl >>> 29) ^ gamma1xh >>> 6;
							var gamma1l = (gamma1xl >>> 19 | gamma1xh << 13) ^ (gamma1xl << 3 | gamma1xh >>> 29) ^ (gamma1xl >>> 6 | gamma1xh << 26);
							var Wi7 = W[i - 7];
							var Wi7h = Wi7.high;
							var Wi7l = Wi7.low;
							var Wi16 = W[i - 16];
							var Wi16h = Wi16.high;
							var Wi16l = Wi16.low;
							Wil = gamma0l + Wi7l;
							Wih = gamma0h + Wi7h + (Wil >>> 0 < gamma0l >>> 0 ? 1 : 0);
							Wil = Wil + gamma1l;
							Wih = Wih + gamma1h + (Wil >>> 0 < gamma1l >>> 0 ? 1 : 0);
							Wil = Wil + Wi16l;
							Wih = Wih + Wi16h + (Wil >>> 0 < Wi16l >>> 0 ? 1 : 0);
							Wi.high = Wih;
							Wi.low = Wil;
						}
						var chh = eh & fh ^ ~eh & gh;
						var chl = el & fl ^ ~el & gl;
						var majh = ah & bh ^ ah & ch ^ bh & ch;
						var majl = al & bl ^ al & cl ^ bl & cl;
						var sigma0h = (ah >>> 28 | al << 4) ^ (ah << 30 | al >>> 2) ^ (ah << 25 | al >>> 7);
						var sigma0l = (al >>> 28 | ah << 4) ^ (al << 30 | ah >>> 2) ^ (al << 25 | ah >>> 7);
						var sigma1h = (eh >>> 14 | el << 18) ^ (eh >>> 18 | el << 14) ^ (eh << 23 | el >>> 9);
						var sigma1l = (el >>> 14 | eh << 18) ^ (el >>> 18 | eh << 14) ^ (el << 23 | eh >>> 9);
						var Ki = K[i];
						var Kih = Ki.high;
						var Kil = Ki.low;
						var t1l = hl + sigma1l;
						var t1h = hh + sigma1h + (t1l >>> 0 < hl >>> 0 ? 1 : 0);
						var t1l = t1l + chl;
						var t1h = t1h + chh + (t1l >>> 0 < chl >>> 0 ? 1 : 0);
						var t1l = t1l + Kil;
						var t1h = t1h + Kih + (t1l >>> 0 < Kil >>> 0 ? 1 : 0);
						var t1l = t1l + Wil;
						var t1h = t1h + Wih + (t1l >>> 0 < Wil >>> 0 ? 1 : 0);
						var t2l = sigma0l + majl;
						var t2h = sigma0h + majh + (t2l >>> 0 < sigma0l >>> 0 ? 1 : 0);
						hh = gh;
						hl = gl;
						gh = fh;
						gl = fl;
						fh = eh;
						fl = el;
						el = dl + t1l | 0;
						eh = dh + t1h + (el >>> 0 < dl >>> 0 ? 1 : 0) | 0;
						dh = ch;
						dl = cl;
						ch = bh;
						cl = bl;
						bh = ah;
						bl = al;
						al = t1l + t2l | 0;
						ah = t1h + t2h + (al >>> 0 < t1l >>> 0 ? 1 : 0) | 0;
					}
					H0l = H0.low = H0l + al;
					H0.high = H0h + ah + (H0l >>> 0 < al >>> 0 ? 1 : 0);
					H1l = H1.low = H1l + bl;
					H1.high = H1h + bh + (H1l >>> 0 < bl >>> 0 ? 1 : 0);
					H2l = H2.low = H2l + cl;
					H2.high = H2h + ch + (H2l >>> 0 < cl >>> 0 ? 1 : 0);
					H3l = H3.low = H3l + dl;
					H3.high = H3h + dh + (H3l >>> 0 < dl >>> 0 ? 1 : 0);
					H4l = H4.low = H4l + el;
					H4.high = H4h + eh + (H4l >>> 0 < el >>> 0 ? 1 : 0);
					H5l = H5.low = H5l + fl;
					H5.high = H5h + fh + (H5l >>> 0 < fl >>> 0 ? 1 : 0);
					H6l = H6.low = H6l + gl;
					H6.high = H6h + gh + (H6l >>> 0 < gl >>> 0 ? 1 : 0);
					H7l = H7.low = H7l + hl;
					H7.high = H7h + hh + (H7l >>> 0 < hl >>> 0 ? 1 : 0);
				},
				_doFinalize: function() {
					var data = this._data;
					var dataWords = data.words;
					var nBitsTotal = this._nDataBytes * 8;
					var nBitsLeft = data.sigBytes * 8;
					dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
					dataWords[(nBitsLeft + 128 >>> 10 << 5) + 30] = Math.floor(nBitsTotal / 4294967296);
					dataWords[(nBitsLeft + 128 >>> 10 << 5) + 31] = nBitsTotal;
					data.sigBytes = dataWords.length * 4;
					this._process();
					return this._hash.toX32();
				},
				clone: function() {
					var clone = Hasher.clone.call(this);
					clone._hash = this._hash.clone();
					return clone;
				},
				blockSize: 1024 / 32
			});
			/**
			* Shortcut function to the hasher's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			*
			* @return {WordArray} The hash.
			*
			* @static
			*
			* @example
			*
			*     var hash = CryptoJS.SHA512('message');
			*     var hash = CryptoJS.SHA512(wordArray);
			*/
			C.SHA512 = Hasher._createHelper(SHA512);
			/**
			* Shortcut function to the HMAC's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			* @param {WordArray|string} key The secret key.
			*
			* @return {WordArray} The HMAC.
			*
			* @static
			*
			* @example
			*
			*     var hmac = CryptoJS.HmacSHA512(message, key);
			*/
			C.HmacSHA512 = Hasher._createHmacHelper(SHA512);
		})();
		return CryptoJS.SHA512;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/sha384.js
var require_sha384 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_x64_core(), require_sha512());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./x64-core",
			"./sha512"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var C_x64 = C.x64;
			var X64Word = C_x64.Word;
			var X64WordArray = C_x64.WordArray;
			var C_algo = C.algo;
			var SHA512 = C_algo.SHA512;
			/**
			* SHA-384 hash algorithm.
			*/
			var SHA384 = C_algo.SHA384 = SHA512.extend({
				_doReset: function() {
					this._hash = new X64WordArray.init([
						new X64Word.init(3418070365, 3238371032),
						new X64Word.init(1654270250, 914150663),
						new X64Word.init(2438529370, 812702999),
						new X64Word.init(355462360, 4144912697),
						new X64Word.init(1731405415, 4290775857),
						new X64Word.init(2394180231, 1750603025),
						new X64Word.init(3675008525, 1694076839),
						new X64Word.init(1203062813, 3204075428)
					]);
				},
				_doFinalize: function() {
					var hash = SHA512._doFinalize.call(this);
					hash.sigBytes -= 16;
					return hash;
				}
			});
			/**
			* Shortcut function to the hasher's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			*
			* @return {WordArray} The hash.
			*
			* @static
			*
			* @example
			*
			*     var hash = CryptoJS.SHA384('message');
			*     var hash = CryptoJS.SHA384(wordArray);
			*/
			C.SHA384 = SHA512._createHelper(SHA384);
			/**
			* Shortcut function to the HMAC's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			* @param {WordArray|string} key The secret key.
			*
			* @return {WordArray} The HMAC.
			*
			* @static
			*
			* @example
			*
			*     var hmac = CryptoJS.HmacSHA384(message, key);
			*/
			C.HmacSHA384 = SHA512._createHmacHelper(SHA384);
		})();
		return CryptoJS.SHA384;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/sha3.js
var require_sha3 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_x64_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./x64-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function(Math) {
			var C = CryptoJS;
			var C_lib = C.lib;
			var WordArray = C_lib.WordArray;
			var Hasher = C_lib.Hasher;
			var X64Word = C.x64.Word;
			var C_algo = C.algo;
			var RHO_OFFSETS = [];
			var PI_INDEXES = [];
			var ROUND_CONSTANTS = [];
			(function() {
				var x = 1, y = 0;
				for (var t = 0; t < 24; t++) {
					RHO_OFFSETS[x + 5 * y] = (t + 1) * (t + 2) / 2 % 64;
					var newX = y % 5;
					var newY = (2 * x + 3 * y) % 5;
					x = newX;
					y = newY;
				}
				for (var x = 0; x < 5; x++) {for (var y = 0; y < 5; y++) PI_INDEXES[x + 5 * y] = y + (2 * x + 3 * y) % 5 * 5;}
				var LFSR = 1;
				for (var i = 0; i < 24; i++) {
					var roundConstantMsw = 0;
					var roundConstantLsw = 0;
					for (var j = 0; j < 7; j++) {
						if (LFSR & 1) {
							var bitPosition = (1 << j) - 1;
							if (bitPosition < 32) {roundConstantLsw ^= 1 << bitPosition;}
							else {roundConstantMsw ^= 1 << bitPosition - 32;}
						}
						if (LFSR & 128) {LFSR = LFSR << 1 ^ 113;}
						else {LFSR <<= 1;}
					}
					ROUND_CONSTANTS[i] = X64Word.create(roundConstantMsw, roundConstantLsw);
				}
			})();
			var T = [];
			(function() {
				for (var i = 0; i < 25; i++) {T[i] = X64Word.create();}
			})();
			/**
			* SHA-3 hash algorithm.
			*/
			var SHA3 = C_algo.SHA3 = Hasher.extend({
				cfg: Hasher.cfg.extend({ outputLength: 512 }),
				_doReset: function() {
					var state = this._state = [];
					for (var i = 0; i < 25; i++) {state[i] = new X64Word.init();}
					this.blockSize = (1600 - 2 * this.cfg.outputLength) / 32;
				},
				_doProcessBlock: function(M, offset) {
					var state = this._state;
					var nBlockSizeLanes = this.blockSize / 2;
					for (var i = 0; i < nBlockSizeLanes; i++) {
						var M2i = M[offset + 2 * i];
						var M2i1 = M[offset + 2 * i + 1];
						M2i = (M2i << 8 | M2i >>> 24) & 16711935 | (M2i << 24 | M2i >>> 8) & 4278255360;
						M2i1 = (M2i1 << 8 | M2i1 >>> 24) & 16711935 | (M2i1 << 24 | M2i1 >>> 8) & 4278255360;
						var lane = state[i];
						lane.high ^= M2i1;
						lane.low ^= M2i;
					}
					for (var round = 0; round < 24; round++) {
						for (var x = 0; x < 5; x++) {
							var tMsw = 0, tLsw = 0;
							for (var y = 0; y < 5; y++) {
								var lane = state[x + 5 * y];
								tMsw ^= lane.high;
								tLsw ^= lane.low;
							}
							var Tx = T[x];
							Tx.high = tMsw;
							Tx.low = tLsw;
						}
						for (var x = 0; x < 5; x++) {
							var Tx4 = T[(x + 4) % 5];
							var Tx1 = T[(x + 1) % 5];
							var Tx1Msw = Tx1.high;
							var Tx1Lsw = Tx1.low;
							var tMsw = Tx4.high ^ (Tx1Msw << 1 | Tx1Lsw >>> 31);
							var tLsw = Tx4.low ^ (Tx1Lsw << 1 | Tx1Msw >>> 31);
							for (var y = 0; y < 5; y++) {
								var lane = state[x + 5 * y];
								lane.high ^= tMsw;
								lane.low ^= tLsw;
							}
						}
						for (var laneIndex = 1; laneIndex < 25; laneIndex++) {
							var tMsw;
							var tLsw;
							var lane = state[laneIndex];
							var laneMsw = lane.high;
							var laneLsw = lane.low;
							var rhoOffset = RHO_OFFSETS[laneIndex];
							if (rhoOffset < 32) {
								tMsw = laneMsw << rhoOffset | laneLsw >>> 32 - rhoOffset;
								tLsw = laneLsw << rhoOffset | laneMsw >>> 32 - rhoOffset;
							} else {
								tMsw = laneLsw << rhoOffset - 32 | laneMsw >>> 64 - rhoOffset;
								tLsw = laneMsw << rhoOffset - 32 | laneLsw >>> 64 - rhoOffset;
							}
							var TPiLane = T[PI_INDEXES[laneIndex]];
							TPiLane.high = tMsw;
							TPiLane.low = tLsw;
						}
						var T0 = T[0];
						var state0 = state[0];
						T0.high = state0.high;
						T0.low = state0.low;
						for (var x = 0; x < 5; x++) {for (var y = 0; y < 5; y++) {
							var laneIndex = x + 5 * y;
							var lane = state[laneIndex];
							var TLane = T[laneIndex];
							var Tx1Lane = T[(x + 1) % 5 + 5 * y];
							var Tx2Lane = T[(x + 2) % 5 + 5 * y];
							lane.high = TLane.high ^ ~Tx1Lane.high & Tx2Lane.high;
							lane.low = TLane.low ^ ~Tx1Lane.low & Tx2Lane.low;
						}}
						var lane = state[0];
						var roundConstant = ROUND_CONSTANTS[round];
						lane.high ^= roundConstant.high;
						lane.low ^= roundConstant.low;
					}
				},
				_doFinalize: function() {
					var data = this._data;
					var dataWords = data.words;
					this._nDataBytes * 8;
					var nBitsLeft = data.sigBytes * 8;
					var blockSizeBits = this.blockSize * 32;
					dataWords[nBitsLeft >>> 5] |= 1 << 24 - nBitsLeft % 32;
					dataWords[(Math.ceil((nBitsLeft + 1) / blockSizeBits) * blockSizeBits >>> 5) - 1] |= 128;
					data.sigBytes = dataWords.length * 4;
					this._process();
					var state = this._state;
					var outputLengthBytes = this.cfg.outputLength / 8;
					var outputLengthLanes = outputLengthBytes / 8;
					var hashWords = [];
					for (var i = 0; i < outputLengthLanes; i++) {
						var lane = state[i];
						var laneMsw = lane.high;
						var laneLsw = lane.low;
						laneMsw = (laneMsw << 8 | laneMsw >>> 24) & 16711935 | (laneMsw << 24 | laneMsw >>> 8) & 4278255360;
						laneLsw = (laneLsw << 8 | laneLsw >>> 24) & 16711935 | (laneLsw << 24 | laneLsw >>> 8) & 4278255360;
						hashWords.push(laneLsw);
						hashWords.push(laneMsw);
					}
					return new WordArray.init(hashWords, outputLengthBytes);
				},
				clone: function() {
					var clone = Hasher.clone.call(this);
					var state = clone._state = this._state.slice(0);
					for (var i = 0; i < 25; i++) {state[i] = state[i].clone();}
					return clone;
				}
			});
			/**
			* Shortcut function to the hasher's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			*
			* @return {WordArray} The hash.
			*
			* @static
			*
			* @example
			*
			*     var hash = CryptoJS.SHA3('message');
			*     var hash = CryptoJS.SHA3(wordArray);
			*/
			C.SHA3 = Hasher._createHelper(SHA3);
			/**
			* Shortcut function to the HMAC's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			* @param {WordArray|string} key The secret key.
			*
			* @return {WordArray} The HMAC.
			*
			* @static
			*
			* @example
			*
			*     var hmac = CryptoJS.HmacSHA3(message, key);
			*/
			C.HmacSHA3 = Hasher._createHmacHelper(SHA3);
		})(Math);
		return CryptoJS.SHA3;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/ripemd160.js
var require_ripemd160 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/** @preserve
		(c) 2012 by Cédric Mesnil. All rights reserved.
		
		Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
		
		- Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
		- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
		
		THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
		*/
		(function(Math) {
			var C = CryptoJS;
			var C_lib = C.lib;
			var WordArray = C_lib.WordArray;
			var Hasher = C_lib.Hasher;
			var C_algo = C.algo;
			var _zl = WordArray.create([
				0,
				1,
				2,
				3,
				4,
				5,
				6,
				7,
				8,
				9,
				10,
				11,
				12,
				13,
				14,
				15,
				7,
				4,
				13,
				1,
				10,
				6,
				15,
				3,
				12,
				0,
				9,
				5,
				2,
				14,
				11,
				8,
				3,
				10,
				14,
				4,
				9,
				15,
				8,
				1,
				2,
				7,
				0,
				6,
				13,
				11,
				5,
				12,
				1,
				9,
				11,
				10,
				0,
				8,
				12,
				4,
				13,
				3,
				7,
				15,
				14,
				5,
				6,
				2,
				4,
				0,
				5,
				9,
				7,
				12,
				2,
				10,
				14,
				1,
				3,
				8,
				11,
				6,
				15,
				13
			]);
			var _zr = WordArray.create([
				5,
				14,
				7,
				0,
				9,
				2,
				11,
				4,
				13,
				6,
				15,
				8,
				1,
				10,
				3,
				12,
				6,
				11,
				3,
				7,
				0,
				13,
				5,
				10,
				14,
				15,
				8,
				12,
				4,
				9,
				1,
				2,
				15,
				5,
				1,
				3,
				7,
				14,
				6,
				9,
				11,
				8,
				12,
				2,
				10,
				0,
				4,
				13,
				8,
				6,
				4,
				1,
				3,
				11,
				15,
				0,
				5,
				12,
				2,
				13,
				9,
				7,
				10,
				14,
				12,
				15,
				10,
				4,
				1,
				5,
				8,
				7,
				6,
				2,
				13,
				14,
				0,
				3,
				9,
				11
			]);
			var _sl = WordArray.create([
				11,
				14,
				15,
				12,
				5,
				8,
				7,
				9,
				11,
				13,
				14,
				15,
				6,
				7,
				9,
				8,
				7,
				6,
				8,
				13,
				11,
				9,
				7,
				15,
				7,
				12,
				15,
				9,
				11,
				7,
				13,
				12,
				11,
				13,
				6,
				7,
				14,
				9,
				13,
				15,
				14,
				8,
				13,
				6,
				5,
				12,
				7,
				5,
				11,
				12,
				14,
				15,
				14,
				15,
				9,
				8,
				9,
				14,
				5,
				6,
				8,
				6,
				5,
				12,
				9,
				15,
				5,
				11,
				6,
				8,
				13,
				12,
				5,
				12,
				13,
				14,
				11,
				8,
				5,
				6
			]);
			var _sr = WordArray.create([
				8,
				9,
				9,
				11,
				13,
				15,
				15,
				5,
				7,
				7,
				8,
				11,
				14,
				14,
				12,
				6,
				9,
				13,
				15,
				7,
				12,
				8,
				9,
				11,
				7,
				7,
				12,
				7,
				6,
				15,
				13,
				11,
				9,
				7,
				15,
				11,
				8,
				6,
				6,
				14,
				12,
				13,
				5,
				14,
				13,
				13,
				7,
				5,
				15,
				5,
				8,
				11,
				14,
				14,
				6,
				14,
				6,
				9,
				12,
				9,
				12,
				5,
				15,
				8,
				8,
				5,
				12,
				9,
				12,
				5,
				14,
				6,
				8,
				13,
				6,
				5,
				15,
				13,
				11,
				11
			]);
			var _hl = WordArray.create([
				0,
				1518500249,
				1859775393,
				2400959708,
				2840853838
			]);
			var _hr = WordArray.create([
				1352829926,
				1548603684,
				1836072691,
				2053994217,
				0
			]);
			/**
			* RIPEMD160 hash algorithm.
			*/
			var RIPEMD160 = C_algo.RIPEMD160 = Hasher.extend({
				_doReset: function() {
					this._hash = WordArray.create([
						1732584193,
						4023233417,
						2562383102,
						271733878,
						3285377520
					]);
				},
				_doProcessBlock: function(M, offset) {
					for (var i = 0; i < 16; i++) {
						var offset_i = offset + i;
						var M_offset_i = M[offset_i];
						M[offset_i] = (M_offset_i << 8 | M_offset_i >>> 24) & 16711935 | (M_offset_i << 24 | M_offset_i >>> 8) & 4278255360;
					}
					var H = this._hash.words;
					var hl = _hl.words;
					var hr = _hr.words;
					var zl = _zl.words;
					var zr = _zr.words;
					var sl = _sl.words;
					var sr = _sr.words;
					var al, bl, cl, dl, el;
					var ar = al = H[0], br = bl = H[1], cr = cl = H[2], dr = dl = H[3], er = el = H[4];
					var t;
					for (var i = 0; i < 80; i += 1) {
						t = al + M[offset + zl[i]] | 0;
						if (i < 16) {t += f1(bl, cl, dl) + hl[0];}
						else if (i < 32) {t += f2(bl, cl, dl) + hl[1];}
						else if (i < 48) {t += f3(bl, cl, dl) + hl[2];}
						else if (i < 64) {t += f4(bl, cl, dl) + hl[3];}
						else {t += f5(bl, cl, dl) + hl[4];}
						t = t | 0;
						t = rotl(t, sl[i]);
						t = t + el | 0;
						al = el;
						el = dl;
						dl = rotl(cl, 10);
						cl = bl;
						bl = t;
						t = ar + M[offset + zr[i]] | 0;
						if (i < 16) {t += f5(br, cr, dr) + hr[0];}
						else if (i < 32) {t += f4(br, cr, dr) + hr[1];}
						else if (i < 48) {t += f3(br, cr, dr) + hr[2];}
						else if (i < 64) {t += f2(br, cr, dr) + hr[3];}
						else {t += f1(br, cr, dr) + hr[4];}
						t = t | 0;
						t = rotl(t, sr[i]);
						t = t + er | 0;
						ar = er;
						er = dr;
						dr = rotl(cr, 10);
						cr = br;
						br = t;
					}
					t = H[1] + cl + dr | 0;
					H[1] = H[2] + dl + er | 0;
					H[2] = H[3] + el + ar | 0;
					H[3] = H[4] + al + br | 0;
					H[4] = H[0] + bl + cr | 0;
					H[0] = t;
				},
				_doFinalize: function() {
					var data = this._data;
					var dataWords = data.words;
					var nBitsTotal = this._nDataBytes * 8;
					var nBitsLeft = data.sigBytes * 8;
					dataWords[nBitsLeft >>> 5] |= 128 << 24 - nBitsLeft % 32;
					dataWords[(nBitsLeft + 64 >>> 9 << 4) + 14] = (nBitsTotal << 8 | nBitsTotal >>> 24) & 16711935 | (nBitsTotal << 24 | nBitsTotal >>> 8) & 4278255360;
					data.sigBytes = (dataWords.length + 1) * 4;
					this._process();
					var hash = this._hash;
					var H = hash.words;
					for (var i = 0; i < 5; i++) {
						var H_i = H[i];
						H[i] = (H_i << 8 | H_i >>> 24) & 16711935 | (H_i << 24 | H_i >>> 8) & 4278255360;
					}
					return hash;
				},
				clone: function() {
					var clone = Hasher.clone.call(this);
					clone._hash = this._hash.clone();
					return clone;
				}
			});
			function f1(x, y, z) {
				return x ^ y ^ z;
			}
			function f2(x, y, z) {
				return x & y | ~x & z;
			}
			function f3(x, y, z) {
				return (x | ~y) ^ z;
			}
			function f4(x, y, z) {
				return x & z | y & ~z;
			}
			function f5(x, y, z) {
				return x ^ (y | ~z);
			}
			function rotl(x, n) {
				return x << n | x >>> 32 - n;
			}
			/**
			* Shortcut function to the hasher's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			*
			* @return {WordArray} The hash.
			*
			* @static
			*
			* @example
			*
			*     var hash = CryptoJS.RIPEMD160('message');
			*     var hash = CryptoJS.RIPEMD160(wordArray);
			*/
			C.RIPEMD160 = Hasher._createHelper(RIPEMD160);
			/**
			* Shortcut function to the HMAC's object interface.
			*
			* @param {WordArray|string} message The message to hash.
			* @param {WordArray|string} key The secret key.
			*
			* @return {WordArray} The HMAC.
			*
			* @static
			*
			* @example
			*
			*     var hmac = CryptoJS.HmacRIPEMD160(message, key);
			*/
			C.HmacRIPEMD160 = Hasher._createHmacHelper(RIPEMD160);
		})(Math);
		return CryptoJS.RIPEMD160;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/hmac.js
var require_hmac = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core());}
		else if (typeof define === "function" && define.amd) {define(["./core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var Base = C.lib.Base;
			var Utf8 = C.enc.Utf8;
			var C_algo = C.algo;
			C_algo.HMAC = Base.extend({
				init: function(hasher, key) {
					hasher = this._hasher = new hasher.init();
					if (typeof key == "string") {key = Utf8.parse(key);}
					var hasherBlockSize = hasher.blockSize;
					var hasherBlockSizeBytes = hasherBlockSize * 4;
					if (key.sigBytes > hasherBlockSizeBytes) {key = hasher.finalize(key);}
					key.clamp();
					var oKey = this._oKey = key.clone();
					var iKey = this._iKey = key.clone();
					var oKeyWords = oKey.words;
					var iKeyWords = iKey.words;
					for (var i = 0; i < hasherBlockSize; i++) {
						oKeyWords[i] ^= 1549556828;
						iKeyWords[i] ^= 909522486;
					}
					oKey.sigBytes = iKey.sigBytes = hasherBlockSizeBytes;
					this.reset();
				},
				reset: function() {
					var hasher = this._hasher;
					hasher.reset();
					hasher.update(this._iKey);
				},
				update: function(messageUpdate) {
					this._hasher.update(messageUpdate);
					return this;
				},
				finalize: function(messageUpdate) {
					var hasher = this._hasher;
					var innerHash = hasher.finalize(messageUpdate);
					hasher.reset();
					return hasher.finalize(this._oKey.clone().concat(innerHash));
				}
			});
		})();
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/pbkdf2.js
var require_pbkdf2 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_sha256(), require_hmac());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./sha256",
			"./hmac"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var C_lib = C.lib;
			var Base = C_lib.Base;
			var WordArray = C_lib.WordArray;
			var C_algo = C.algo;
			var SHA256 = C_algo.SHA256;
			var HMAC = C_algo.HMAC;
			/**
			* Password-Based Key Derivation Function 2 algorithm.
			*/
			var PBKDF2 = C_algo.PBKDF2 = Base.extend({
				cfg: Base.extend({
					keySize: 128 / 32,
					hasher: SHA256,
					iterations: 25e4
				}),
				init: function(cfg) {
					this.cfg = this.cfg.extend(cfg);
				},
				compute: function(password, salt) {
					var cfg = this.cfg;
					var hmac = HMAC.create(cfg.hasher, password);
					var derivedKey = WordArray.create();
					var blockIndex = WordArray.create([1]);
					var derivedKeyWords = derivedKey.words;
					var blockIndexWords = blockIndex.words;
					var keySize = cfg.keySize;
					var iterations = cfg.iterations;
					while (derivedKeyWords.length < keySize) {
						var block = hmac.update(salt).finalize(blockIndex);
						hmac.reset();
						var blockWords = block.words;
						var blockWordsLength = blockWords.length;
						var intermediate = block;
						for (var i = 1; i < iterations; i++) {
							intermediate = hmac.finalize(intermediate);
							hmac.reset();
							var intermediateWords = intermediate.words;
							for (var j = 0; j < blockWordsLength; j++) {blockWords[j] ^= intermediateWords[j];}
						}
						derivedKey.concat(block);
						blockIndexWords[0]++;
					}
					derivedKey.sigBytes = keySize * 4;
					return derivedKey;
				}
			});
			/**
			* Computes the Password-Based Key Derivation Function 2.
			*
			* @param {WordArray|string} password The password.
			* @param {WordArray|string} salt A salt.
			* @param {Object} cfg (Optional) The configuration options to use for this computation.
			*
			* @return {WordArray} The derived key.
			*
			* @static
			*
			* @example
			*
			*     var key = CryptoJS.PBKDF2(password, salt);
			*     var key = CryptoJS.PBKDF2(password, salt, { keySize: 8 });
			*     var key = CryptoJS.PBKDF2(password, salt, { keySize: 8, iterations: 1000 });
			*/
			C.PBKDF2 = function(password, salt, cfg) {
				return PBKDF2.create(cfg).compute(password, salt);
			};
		})();
		return CryptoJS.PBKDF2;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/evpkdf.js
var require_evpkdf = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_sha1(), require_hmac());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./sha1",
			"./hmac"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var C_lib = C.lib;
			var Base = C_lib.Base;
			var WordArray = C_lib.WordArray;
			var C_algo = C.algo;
			var MD5 = C_algo.MD5;
			/**
			* This key derivation function is meant to conform with EVP_BytesToKey.
			* www.openssl.org/docs/crypto/EVP_BytesToKey.html
			*/
			var EvpKDF = C_algo.EvpKDF = Base.extend({
				cfg: Base.extend({
					keySize: 128 / 32,
					hasher: MD5,
					iterations: 1
				}),
				init: function(cfg) {
					this.cfg = this.cfg.extend(cfg);
				},
				compute: function(password, salt) {
					var block;
					var cfg = this.cfg;
					var hasher = cfg.hasher.create();
					var derivedKey = WordArray.create();
					var derivedKeyWords = derivedKey.words;
					var keySize = cfg.keySize;
					var iterations = cfg.iterations;
					while (derivedKeyWords.length < keySize) {
						if (block) {hasher.update(block);}
						block = hasher.update(password).finalize(salt);
						hasher.reset();
						for (var i = 1; i < iterations; i++) {
							block = hasher.finalize(block);
							hasher.reset();
						}
						derivedKey.concat(block);
					}
					derivedKey.sigBytes = keySize * 4;
					return derivedKey;
				}
			});
			/**
			* Derives a key from a password.
			*
			* @param {WordArray|string} password The password.
			* @param {WordArray|string} salt A salt.
			* @param {Object} cfg (Optional) The configuration options to use for this computation.
			*
			* @return {WordArray} The derived key.
			*
			* @static
			*
			* @example
			*
			*     var key = CryptoJS.EvpKDF(password, salt);
			*     var key = CryptoJS.EvpKDF(password, salt, { keySize: 8 });
			*     var key = CryptoJS.EvpKDF(password, salt, { keySize: 8, iterations: 1000 });
			*/
			C.EvpKDF = function(password, salt, cfg) {
				return EvpKDF.create(cfg).compute(password, salt);
			};
		})();
		return CryptoJS.EvpKDF;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/cipher-core.js
var require_cipher_core = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_evpkdf());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./evpkdf"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* Cipher core components.
		*/
		CryptoJS.lib.Cipher || function(undefined) {
			var C = CryptoJS;
			var C_lib = C.lib;
			var Base = C_lib.Base;
			var WordArray = C_lib.WordArray;
			var BufferedBlockAlgorithm = C_lib.BufferedBlockAlgorithm;
			var C_enc = C.enc;
			C_enc.Utf8;
			var Base64 = C_enc.Base64;
			var EvpKDF = C.algo.EvpKDF;
			/**
			* Abstract base cipher template.
			*
			* @property {number} keySize This cipher's key size. Default: 4 (128 bits)
			* @property {number} ivSize This cipher's IV size. Default: 4 (128 bits)
			* @property {number} _ENC_XFORM_MODE A constant representing encryption mode.
			* @property {number} _DEC_XFORM_MODE A constant representing decryption mode.
			*/
			var Cipher = C_lib.Cipher = BufferedBlockAlgorithm.extend({
				cfg: Base.extend(),
				createEncryptor: function(key, cfg) {
					return this.create(this._ENC_XFORM_MODE, key, cfg);
				},
				createDecryptor: function(key, cfg) {
					return this.create(this._DEC_XFORM_MODE, key, cfg);
				},
				init: function(xformMode, key, cfg) {
					this.cfg = this.cfg.extend(cfg);
					this._xformMode = xformMode;
					this._key = key;
					this.reset();
				},
				reset: function() {
					BufferedBlockAlgorithm.reset.call(this);
					this._doReset();
				},
				process: function(dataUpdate) {
					this._append(dataUpdate);
					return this._process();
				},
				finalize: function(dataUpdate) {
					if (dataUpdate) {this._append(dataUpdate);}
					return this._doFinalize();
				},
				keySize: 128 / 32,
				ivSize: 128 / 32,
				_ENC_XFORM_MODE: 1,
				_DEC_XFORM_MODE: 2,
				_createHelper: function() {
					function selectCipherStrategy(key) {
						if (typeof key == "string") {return PasswordBasedCipher;}
						else {return SerializableCipher;}
					}
					return function(cipher) {
						return {
							encrypt: function(message, key, cfg) {
								return selectCipherStrategy(key).encrypt(cipher, message, key, cfg);
							},
							decrypt: function(ciphertext, key, cfg) {
								return selectCipherStrategy(key).decrypt(cipher, ciphertext, key, cfg);
							}
						};
					};
				}()
			});
			C_lib.StreamCipher = Cipher.extend({
				_doFinalize: function() {
					return this._process(true);
				},
				blockSize: 1
			});
			/**
			* Mode namespace.
			*/
			var C_mode = C.mode = {};
			/**
			* Abstract base block cipher mode template.
			*/
			var BlockCipherMode = C_lib.BlockCipherMode = Base.extend({
				createEncryptor: function(cipher, iv) {
					return this.Encryptor.create(cipher, iv);
				},
				createDecryptor: function(cipher, iv) {
					return this.Decryptor.create(cipher, iv);
				},
				init: function(cipher, iv) {
					this._cipher = cipher;
					this._iv = iv;
				}
			});
			/**
			* Cipher Block Chaining mode.
			*/
			var CBC = C_mode.CBC = function() {
				/**
				* Abstract base CBC mode.
				*/
				var CBC = BlockCipherMode.extend();
				/**
				* CBC encryptor.
				*/
				CBC.Encryptor = CBC.extend({ processBlock: function(words, offset) {
					var cipher = this._cipher;
					var blockSize = cipher.blockSize;
					xorBlock.call(this, words, offset, blockSize);
					cipher.encryptBlock(words, offset);
					this._prevBlock = words.slice(offset, offset + blockSize);
				} });
				/**
				* CBC decryptor.
				*/
				CBC.Decryptor = CBC.extend({ processBlock: function(words, offset) {
					var cipher = this._cipher;
					var blockSize = cipher.blockSize;
					var thisBlock = words.slice(offset, offset + blockSize);
					cipher.decryptBlock(words, offset);
					xorBlock.call(this, words, offset, blockSize);
					this._prevBlock = thisBlock;
				} });
				function xorBlock(words, offset, blockSize) {
					var block;
					var iv = this._iv;
					if (iv) {
						block = iv;
						this._iv = undefined;
					} else {block = this._prevBlock;}
					for (var i = 0; i < blockSize; i++) {words[offset + i] ^= block[i];}
				}
				return CBC;
			}();
			/**
			* Padding namespace.
			*/
			var C_pad = C.pad = {};
			/**
			* PKCS #5/7 padding strategy.
			*/
			var Pkcs7 = C_pad.Pkcs7 = {
				pad: function(data, blockSize) {
					var blockSizeBytes = blockSize * 4;
					var nPaddingBytes = blockSizeBytes - data.sigBytes % blockSizeBytes;
					var paddingWord = nPaddingBytes << 24 | nPaddingBytes << 16 | nPaddingBytes << 8 | nPaddingBytes;
					var paddingWords = [];
					for (var i = 0; i < nPaddingBytes; i += 4) {paddingWords.push(paddingWord);}
					var padding = WordArray.create(paddingWords, nPaddingBytes);
					data.concat(padding);
				},
				unpad: function(data) {
					var nPaddingBytes = data.words[data.sigBytes - 1 >>> 2] & 255;
					data.sigBytes -= nPaddingBytes;
				}
			};
			C_lib.BlockCipher = Cipher.extend({
				cfg: Cipher.cfg.extend({
					mode: CBC,
					padding: Pkcs7
				}),
				reset: function() {
					var modeCreator;
					Cipher.reset.call(this);
					var cfg = this.cfg;
					var iv = cfg.iv;
					var mode = cfg.mode;
					if (this._xformMode == this._ENC_XFORM_MODE) {modeCreator = mode.createEncryptor;}
					else {
						modeCreator = mode.createDecryptor;
						this._minBufferSize = 1;
					}
					if (this._mode && this._mode.__creator == modeCreator) {this._mode.init(this, iv && iv.words);}
					else {
						this._mode = modeCreator.call(mode, this, iv && iv.words);
						this._mode.__creator = modeCreator;
					}
				},
				_doProcessBlock: function(words, offset) {
					this._mode.processBlock(words, offset);
				},
				_doFinalize: function() {
					var finalProcessedBlocks;
					var padding = this.cfg.padding;
					if (this._xformMode == this._ENC_XFORM_MODE) {
						padding.pad(this._data, this.blockSize);
						finalProcessedBlocks = this._process(true);
					} else {
						finalProcessedBlocks = this._process(true);
						padding.unpad(finalProcessedBlocks);
					}
					return finalProcessedBlocks;
				},
				blockSize: 128 / 32
			});
			/**
			* A collection of cipher parameters.
			*
			* @property {WordArray} ciphertext The raw ciphertext.
			* @property {WordArray} key The key to this ciphertext.
			* @property {WordArray} iv The IV used in the ciphering operation.
			* @property {WordArray} salt The salt used with a key derivation function.
			* @property {Cipher} algorithm The cipher algorithm.
			* @property {Mode} mode The block mode used in the ciphering operation.
			* @property {Padding} padding The padding scheme used in the ciphering operation.
			* @property {number} blockSize The block size of the cipher.
			* @property {Format} formatter The default formatting strategy to convert this cipher params object to a string.
			*/
			var CipherParams = C_lib.CipherParams = Base.extend({
				init: function(cipherParams) {
					this.mixIn(cipherParams);
				},
				toString: function(formatter) {
					return (formatter || this.formatter).stringify(this);
				}
			});
			/**
			* Format namespace.
			*/
			var C_format = C.format = {};
			/**
			* OpenSSL formatting strategy.
			*/
			var OpenSSLFormatter = C_format.OpenSSL = {
				stringify: function(cipherParams) {
					var wordArray;
					var ciphertext = cipherParams.ciphertext;
					var salt = cipherParams.salt;
					if (salt) {wordArray = WordArray.create([1398893684, 1701076831]).concat(salt).concat(ciphertext);}
					else {wordArray = ciphertext;}
					return wordArray.toString(Base64);
				},
				parse: function(openSSLStr) {
					var salt;
					var ciphertext = Base64.parse(openSSLStr);
					var ciphertextWords = ciphertext.words;
					if (ciphertextWords[0] == 1398893684 && ciphertextWords[1] == 1701076831) {
						salt = WordArray.create(ciphertextWords.slice(2, 4));
						ciphertextWords.splice(0, 4);
						ciphertext.sigBytes -= 16;
					}
					return CipherParams.create({
						ciphertext,
						salt
					});
				}
			};
			/**
			* A cipher wrapper that returns ciphertext as a serializable cipher params object.
			*/
			var SerializableCipher = C_lib.SerializableCipher = Base.extend({
				cfg: Base.extend({ format: OpenSSLFormatter }),
				encrypt: function(cipher, message, key, cfg) {
					cfg = this.cfg.extend(cfg);
					var encryptor = cipher.createEncryptor(key, cfg);
					var ciphertext = encryptor.finalize(message);
					var cipherCfg = encryptor.cfg;
					return CipherParams.create({
						ciphertext,
						key,
						iv: cipherCfg.iv,
						algorithm: cipher,
						mode: cipherCfg.mode,
						padding: cipherCfg.padding,
						blockSize: cipher.blockSize,
						formatter: cfg.format
					});
				},
				decrypt: function(cipher, ciphertext, key, cfg) {
					cfg = this.cfg.extend(cfg);
					ciphertext = this._parse(ciphertext, cfg.format);
					return cipher.createDecryptor(key, cfg).finalize(ciphertext.ciphertext);
				},
				_parse: function(ciphertext, format) {
					if (typeof ciphertext == "string") {return format.parse(ciphertext, this);}
					else {return ciphertext;}
				}
			});
			/**
			* Key derivation function namespace.
			*/
			var C_kdf = C.kdf = {};
			/**
			* OpenSSL key derivation function.
			*/
			var OpenSSLKdf = C_kdf.OpenSSL = { execute: function(password, keySize, ivSize, salt, hasher) {
				if (!salt) {salt = WordArray.random(64 / 8);}
				if (!hasher) {var key = EvpKDF.create({ keySize: keySize + ivSize }).compute(password, salt);}
				else {var key = EvpKDF.create({
					keySize: keySize + ivSize,
					hasher
				}).compute(password, salt);}
				var iv = WordArray.create(key.words.slice(keySize), ivSize * 4);
				key.sigBytes = keySize * 4;
				return CipherParams.create({
					key,
					iv,
					salt
				});
			} };
			/**
			* A serializable cipher wrapper that derives the key from a password,
			* and returns ciphertext as a serializable cipher params object.
			*/
			var PasswordBasedCipher = C_lib.PasswordBasedCipher = SerializableCipher.extend({
				cfg: SerializableCipher.cfg.extend({ kdf: OpenSSLKdf }),
				encrypt: function(cipher, message, password, cfg) {
					cfg = this.cfg.extend(cfg);
					var derivedParams = cfg.kdf.execute(password, cipher.keySize, cipher.ivSize, cfg.salt, cfg.hasher);
					cfg.iv = derivedParams.iv;
					var ciphertext = SerializableCipher.encrypt.call(this, cipher, message, derivedParams.key, cfg);
					ciphertext.mixIn(derivedParams);
					return ciphertext;
				},
				decrypt: function(cipher, ciphertext, password, cfg) {
					cfg = this.cfg.extend(cfg);
					ciphertext = this._parse(ciphertext, cfg.format);
					var derivedParams = cfg.kdf.execute(password, cipher.keySize, cipher.ivSize, ciphertext.salt, cfg.hasher);
					cfg.iv = derivedParams.iv;
					return SerializableCipher.decrypt.call(this, cipher, ciphertext, derivedParams.key, cfg);
				}
			});
		}();
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/mode-cfb.js
var require_mode_cfb = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* Cipher Feedback block mode.
		*/
		CryptoJS.mode.CFB = function() {
			var CFB = CryptoJS.lib.BlockCipherMode.extend();
			CFB.Encryptor = CFB.extend({ processBlock: function(words, offset) {
				var cipher = this._cipher;
				var blockSize = cipher.blockSize;
				generateKeystreamAndEncrypt.call(this, words, offset, blockSize, cipher);
				this._prevBlock = words.slice(offset, offset + blockSize);
			} });
			CFB.Decryptor = CFB.extend({ processBlock: function(words, offset) {
				var cipher = this._cipher;
				var blockSize = cipher.blockSize;
				var thisBlock = words.slice(offset, offset + blockSize);
				generateKeystreamAndEncrypt.call(this, words, offset, blockSize, cipher);
				this._prevBlock = thisBlock;
			} });
			function generateKeystreamAndEncrypt(words, offset, blockSize, cipher) {
				var keystream;
				var iv = this._iv;
				if (iv) {
					keystream = iv.slice(0);
					this._iv = void 0;
				} else {keystream = this._prevBlock;}
				cipher.encryptBlock(keystream, 0);
				for (var i = 0; i < blockSize; i++) {words[offset + i] ^= keystream[i];}
			}
			return CFB;
		}();
		return CryptoJS.mode.CFB;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/mode-ctr.js
var require_mode_ctr = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* Counter block mode.
		*/
		CryptoJS.mode.CTR = function() {
			var CTR = CryptoJS.lib.BlockCipherMode.extend();
			CTR.Decryptor = CTR.Encryptor = CTR.extend({ processBlock: function(words, offset) {
				var cipher = this._cipher;
				var blockSize = cipher.blockSize;
				var iv = this._iv;
				var counter = this._counter;
				if (iv) {
					counter = this._counter = iv.slice(0);
					this._iv = void 0;
				}
				var keystream = counter.slice(0);
				cipher.encryptBlock(keystream, 0);
				counter[blockSize - 1] = counter[blockSize - 1] + 1 | 0;
				for (var i = 0; i < blockSize; i++) {words[offset + i] ^= keystream[i];}
			} });
			return CTR;
		}();
		return CryptoJS.mode.CTR;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/mode-ctr-gladman.js
var require_mode_ctr_gladman = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/** @preserve
		* Counter block mode compatible with  Dr Brian Gladman fileenc.c
		* derived from CryptoJS.mode.CTR
		* Jan Hruby jhruby.web@gmail.com
		*/
		CryptoJS.mode.CTRGladman = function() {
			var CTRGladman = CryptoJS.lib.BlockCipherMode.extend();
			function incWord(word) {
				if ((word >> 24 & 255) === 255) {
					var b1 = word >> 16 & 255;
					var b2 = word >> 8 & 255;
					var b3 = word & 255;
					if (b1 === 255) {
						b1 = 0;
						if (b2 === 255) {
							b2 = 0;
							if (b3 === 255) {b3 = 0;}
							else {++b3;}
						} else {++b2;}
					} else {++b1;}
					word = 0;
					word += b1 << 16;
					word += b2 << 8;
					word += b3;
				} else {word += 1 << 24;}
				return word;
			}
			function incCounter(counter) {
				if ((counter[0] = incWord(counter[0])) === 0) {counter[1] = incWord(counter[1]);}
				return counter;
			}
			CTRGladman.Decryptor = CTRGladman.Encryptor = CTRGladman.extend({ processBlock: function(words, offset) {
				var cipher = this._cipher;
				var blockSize = cipher.blockSize;
				var iv = this._iv;
				var counter = this._counter;
				if (iv) {
					counter = this._counter = iv.slice(0);
					this._iv = void 0;
				}
				incCounter(counter);
				var keystream = counter.slice(0);
				cipher.encryptBlock(keystream, 0);
				for (var i = 0; i < blockSize; i++) {words[offset + i] ^= keystream[i];}
			} });
			return CTRGladman;
		}();
		return CryptoJS.mode.CTRGladman;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/mode-ofb.js
var require_mode_ofb = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* Output Feedback block mode.
		*/
		CryptoJS.mode.OFB = function() {
			var OFB = CryptoJS.lib.BlockCipherMode.extend();
			OFB.Decryptor = OFB.Encryptor = OFB.extend({ processBlock: function(words, offset) {
				var cipher = this._cipher;
				var blockSize = cipher.blockSize;
				var iv = this._iv;
				var keystream = this._keystream;
				if (iv) {
					keystream = this._keystream = iv.slice(0);
					this._iv = void 0;
				}
				cipher.encryptBlock(keystream, 0);
				for (var i = 0; i < blockSize; i++) {words[offset + i] ^= keystream[i];}
			} });
			return OFB;
		}();
		return CryptoJS.mode.OFB;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/mode-ecb.js
var require_mode_ecb = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* Electronic Codebook block mode.
		*/
		CryptoJS.mode.ECB = function() {
			var ECB = CryptoJS.lib.BlockCipherMode.extend();
			ECB.Encryptor = ECB.extend({ processBlock: function(words, offset) {
				this._cipher.encryptBlock(words, offset);
			} });
			ECB.Decryptor = ECB.extend({ processBlock: function(words, offset) {
				this._cipher.decryptBlock(words, offset);
			} });
			return ECB;
		}();
		return CryptoJS.mode.ECB;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/pad-ansix923.js
var require_pad_ansix923 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* ANSI X.923 padding strategy.
		*/
		CryptoJS.pad.AnsiX923 = {
			pad: function(data, blockSize) {
				var dataSigBytes = data.sigBytes;
				var blockSizeBytes = blockSize * 4;
				var nPaddingBytes = blockSizeBytes - dataSigBytes % blockSizeBytes;
				var lastBytePos = dataSigBytes + nPaddingBytes - 1;
				data.clamp();
				data.words[lastBytePos >>> 2] |= nPaddingBytes << 24 - lastBytePos % 4 * 8;
				data.sigBytes += nPaddingBytes;
			},
			unpad: function(data) {
				var nPaddingBytes = data.words[data.sigBytes - 1 >>> 2] & 255;
				data.sigBytes -= nPaddingBytes;
			}
		};
		return CryptoJS.pad.Ansix923;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/pad-iso10126.js
var require_pad_iso10126 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* ISO 10126 padding strategy.
		*/
		CryptoJS.pad.Iso10126 = {
			pad: function(data, blockSize) {
				var blockSizeBytes = blockSize * 4;
				var nPaddingBytes = blockSizeBytes - data.sigBytes % blockSizeBytes;
				data.concat(CryptoJS.lib.WordArray.random(nPaddingBytes - 1)).concat(CryptoJS.lib.WordArray.create([nPaddingBytes << 24], 1));
			},
			unpad: function(data) {
				var nPaddingBytes = data.words[data.sigBytes - 1 >>> 2] & 255;
				data.sigBytes -= nPaddingBytes;
			}
		};
		return CryptoJS.pad.Iso10126;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/pad-iso97971.js
var require_pad_iso97971 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* ISO/IEC 9797-1 Padding Method 2.
		*/
		CryptoJS.pad.Iso97971 = {
			pad: function(data, blockSize) {
				data.concat(CryptoJS.lib.WordArray.create([2147483648], 1));
				CryptoJS.pad.ZeroPadding.pad(data, blockSize);
			},
			unpad: function(data) {
				CryptoJS.pad.ZeroPadding.unpad(data);
				data.sigBytes--;
			}
		};
		return CryptoJS.pad.Iso97971;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/pad-zeropadding.js
var require_pad_zeropadding = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* Zero padding strategy.
		*/
		CryptoJS.pad.ZeroPadding = {
			pad: function(data, blockSize) {
				var blockSizeBytes = blockSize * 4;
				data.clamp();
				data.sigBytes += blockSizeBytes - (data.sigBytes % blockSizeBytes || blockSizeBytes);
			},
			unpad: function(data) {
				var dataWords = data.words;
				var i = data.sigBytes - 1;
				for (var i = data.sigBytes - 1; i >= 0; i--) {if (dataWords[i >>> 2] >>> 24 - i % 4 * 8 & 255) {
					data.sigBytes = i + 1;
					break;
				}}
			}
		};
		return CryptoJS.pad.ZeroPadding;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/pad-nopadding.js
var require_pad_nopadding = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		/**
		* A noop padding strategy.
		*/
		CryptoJS.pad.NoPadding = {
			pad: function() {},
			unpad: function() {}
		};
		return CryptoJS.pad.NoPadding;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/format-hex.js
var require_format_hex = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define(["./core", "./cipher-core"], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function(undefined) {
			var C = CryptoJS;
			var CipherParams = C.lib.CipherParams;
			var Hex = C.enc.Hex;
			var C_format = C.format;
			C_format.Hex = {
				stringify: function(cipherParams) {
					return cipherParams.ciphertext.toString(Hex);
				},
				parse: function(input) {
					var ciphertext = Hex.parse(input);
					return CipherParams.create({ ciphertext });
				}
			};
		})();
		return CryptoJS.format.Hex;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/aes.js
var require_aes = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./enc-base64",
			"./md5",
			"./evpkdf",
			"./cipher-core"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var BlockCipher = C.lib.BlockCipher;
			var C_algo = C.algo;
			var SBOX = [];
			var INV_SBOX = [];
			var SUB_MIX_0 = [];
			var SUB_MIX_1 = [];
			var SUB_MIX_2 = [];
			var SUB_MIX_3 = [];
			var INV_SUB_MIX_0 = [];
			var INV_SUB_MIX_1 = [];
			var INV_SUB_MIX_2 = [];
			var INV_SUB_MIX_3 = [];
			(function() {
				var d = [];
				for (var i = 0; i < 256; i++) {if (i < 128) d[i] = i << 1;
				else d[i] = i << 1 ^ 283;}
				var x = 0;
				var xi = 0;
				for (var i = 0; i < 256; i++) {
					var sx = xi ^ xi << 1 ^ xi << 2 ^ xi << 3 ^ xi << 4;
					sx = sx >>> 8 ^ sx & 255 ^ 99;
					SBOX[x] = sx;
					INV_SBOX[sx] = x;
					var x2 = d[x];
					var x4 = d[x2];
					var x8 = d[x4];
					var t = d[sx] * 257 ^ sx * 16843008;
					SUB_MIX_0[x] = t << 24 | t >>> 8;
					SUB_MIX_1[x] = t << 16 | t >>> 16;
					SUB_MIX_2[x] = t << 8 | t >>> 24;
					SUB_MIX_3[x] = t;
					var t = x8 * 16843009 ^ x4 * 65537 ^ x2 * 257 ^ x * 16843008;
					INV_SUB_MIX_0[sx] = t << 24 | t >>> 8;
					INV_SUB_MIX_1[sx] = t << 16 | t >>> 16;
					INV_SUB_MIX_2[sx] = t << 8 | t >>> 24;
					INV_SUB_MIX_3[sx] = t;
					if (!x) {x = xi = 1;}
					else {
						x = x2 ^ d[d[d[x8 ^ x2]]];
						xi ^= d[d[xi]];
					}
				}
			})();
			var RCON = [
				0,
				1,
				2,
				4,
				8,
				16,
				32,
				64,
				128,
				27,
				54
			];
			/**
			* AES block cipher algorithm.
			*/
			var AES = C_algo.AES = BlockCipher.extend({
				_doReset: function() {
					var t;
					if (this._nRounds && this._keyPriorReset === this._key) {return;}
					var key = this._keyPriorReset = this._key;
					var keyWords = key.words;
					var keySize = key.sigBytes / 4;
					var ksRows = ((this._nRounds = keySize + 6) + 1) * 4;
					var keySchedule = this._keySchedule = [];
					for (var ksRow = 0; ksRow < ksRows; ksRow++) {if (ksRow < keySize) keySchedule[ksRow] = keyWords[ksRow];
					else {
						t = keySchedule[ksRow - 1];
						if (!(ksRow % keySize)) {
							t = t << 8 | t >>> 24;
							t = SBOX[t >>> 24] << 24 | SBOX[t >>> 16 & 255] << 16 | SBOX[t >>> 8 & 255] << 8 | SBOX[t & 255];
							t ^= RCON[ksRow / keySize | 0] << 24;
						} else if (keySize > 6 && ksRow % keySize == 4) t = SBOX[t >>> 24] << 24 | SBOX[t >>> 16 & 255] << 16 | SBOX[t >>> 8 & 255] << 8 | SBOX[t & 255];
						keySchedule[ksRow] = keySchedule[ksRow - keySize] ^ t;
					}}
					var invKeySchedule = this._invKeySchedule = [];
					for (var invKsRow = 0; invKsRow < ksRows; invKsRow++) {
						var ksRow = ksRows - invKsRow;
						if (invKsRow % 4) {var t = keySchedule[ksRow];}
						else {var t = keySchedule[ksRow - 4];}
						if (invKsRow < 4 || ksRow <= 4) {invKeySchedule[invKsRow] = t;}
						else {invKeySchedule[invKsRow] = INV_SUB_MIX_0[SBOX[t >>> 24]] ^ INV_SUB_MIX_1[SBOX[t >>> 16 & 255]] ^ INV_SUB_MIX_2[SBOX[t >>> 8 & 255]] ^ INV_SUB_MIX_3[SBOX[t & 255]];}
					}
				},
				encryptBlock: function(M, offset) {
					this._doCryptBlock(M, offset, this._keySchedule, SUB_MIX_0, SUB_MIX_1, SUB_MIX_2, SUB_MIX_3, SBOX);
				},
				decryptBlock: function(M, offset) {
					var t = M[offset + 1];
					M[offset + 1] = M[offset + 3];
					M[offset + 3] = t;
					this._doCryptBlock(M, offset, this._invKeySchedule, INV_SUB_MIX_0, INV_SUB_MIX_1, INV_SUB_MIX_2, INV_SUB_MIX_3, INV_SBOX);
					var t = M[offset + 1];
					M[offset + 1] = M[offset + 3];
					M[offset + 3] = t;
				},
				_doCryptBlock: function(M, offset, keySchedule, SUB_MIX_0, SUB_MIX_1, SUB_MIX_2, SUB_MIX_3, SBOX) {
					var nRounds = this._nRounds;
					var s0 = M[offset] ^ keySchedule[0];
					var s1 = M[offset + 1] ^ keySchedule[1];
					var s2 = M[offset + 2] ^ keySchedule[2];
					var s3 = M[offset + 3] ^ keySchedule[3];
					var ksRow = 4;
					for (var round = 1; round < nRounds; round++) {
						var t0 = SUB_MIX_0[s0 >>> 24] ^ SUB_MIX_1[s1 >>> 16 & 255] ^ SUB_MIX_2[s2 >>> 8 & 255] ^ SUB_MIX_3[s3 & 255] ^ keySchedule[ksRow++];
						var t1 = SUB_MIX_0[s1 >>> 24] ^ SUB_MIX_1[s2 >>> 16 & 255] ^ SUB_MIX_2[s3 >>> 8 & 255] ^ SUB_MIX_3[s0 & 255] ^ keySchedule[ksRow++];
						var t2 = SUB_MIX_0[s2 >>> 24] ^ SUB_MIX_1[s3 >>> 16 & 255] ^ SUB_MIX_2[s0 >>> 8 & 255] ^ SUB_MIX_3[s1 & 255] ^ keySchedule[ksRow++];
						var t3 = SUB_MIX_0[s3 >>> 24] ^ SUB_MIX_1[s0 >>> 16 & 255] ^ SUB_MIX_2[s1 >>> 8 & 255] ^ SUB_MIX_3[s2 & 255] ^ keySchedule[ksRow++];
						s0 = t0;
						s1 = t1;
						s2 = t2;
						s3 = t3;
					}
					var t0 = (SBOX[s0 >>> 24] << 24 | SBOX[s1 >>> 16 & 255] << 16 | SBOX[s2 >>> 8 & 255] << 8 | SBOX[s3 & 255]) ^ keySchedule[ksRow++];
					var t1 = (SBOX[s1 >>> 24] << 24 | SBOX[s2 >>> 16 & 255] << 16 | SBOX[s3 >>> 8 & 255] << 8 | SBOX[s0 & 255]) ^ keySchedule[ksRow++];
					var t2 = (SBOX[s2 >>> 24] << 24 | SBOX[s3 >>> 16 & 255] << 16 | SBOX[s0 >>> 8 & 255] << 8 | SBOX[s1 & 255]) ^ keySchedule[ksRow++];
					var t3 = (SBOX[s3 >>> 24] << 24 | SBOX[s0 >>> 16 & 255] << 16 | SBOX[s1 >>> 8 & 255] << 8 | SBOX[s2 & 255]) ^ keySchedule[ksRow++];
					M[offset] = t0;
					M[offset + 1] = t1;
					M[offset + 2] = t2;
					M[offset + 3] = t3;
				},
				keySize: 256 / 32
			});
			/**
			* Shortcut functions to the cipher's object interface.
			*
			* @example
			*
			*     var ciphertext = CryptoJS.AES.encrypt(message, key, cfg);
			*     var plaintext  = CryptoJS.AES.decrypt(ciphertext, key, cfg);
			*/
			C.AES = BlockCipher._createHelper(AES);
		})();
		return CryptoJS.AES;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/tripledes.js
var require_tripledes = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./enc-base64",
			"./md5",
			"./evpkdf",
			"./cipher-core"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var C_lib = C.lib;
			var WordArray = C_lib.WordArray;
			var BlockCipher = C_lib.BlockCipher;
			var C_algo = C.algo;
			var PC1 = [
				57,
				49,
				41,
				33,
				25,
				17,
				9,
				1,
				58,
				50,
				42,
				34,
				26,
				18,
				10,
				2,
				59,
				51,
				43,
				35,
				27,
				19,
				11,
				3,
				60,
				52,
				44,
				36,
				63,
				55,
				47,
				39,
				31,
				23,
				15,
				7,
				62,
				54,
				46,
				38,
				30,
				22,
				14,
				6,
				61,
				53,
				45,
				37,
				29,
				21,
				13,
				5,
				28,
				20,
				12,
				4
			];
			var PC2 = [
				14,
				17,
				11,
				24,
				1,
				5,
				3,
				28,
				15,
				6,
				21,
				10,
				23,
				19,
				12,
				4,
				26,
				8,
				16,
				7,
				27,
				20,
				13,
				2,
				41,
				52,
				31,
				37,
				47,
				55,
				30,
				40,
				51,
				45,
				33,
				48,
				44,
				49,
				39,
				56,
				34,
				53,
				46,
				42,
				50,
				36,
				29,
				32
			];
			var BIT_SHIFTS = [
				1,
				2,
				4,
				6,
				8,
				10,
				12,
				14,
				15,
				17,
				19,
				21,
				23,
				25,
				27,
				28
			];
			var SBOX_P = [
				{
					0: 8421888,
					268435456: 32768,
					536870912: 8421378,
					805306368: 2,
					1073741824: 512,
					1342177280: 8421890,
					1610612736: 8389122,
					1879048192: 8388608,
					2147483648: 514,
					2415919104: 8389120,
					2684354560: 33280,
					2952790016: 8421376,
					3221225472: 32770,
					3489660928: 8388610,
					3758096384: 0,
					4026531840: 33282,
					134217728: 0,
					402653184: 8421890,
					671088640: 33282,
					939524096: 32768,
					1207959552: 8421888,
					1476395008: 512,
					1744830464: 8421378,
					2013265920: 2,
					2281701376: 8389120,
					2550136832: 33280,
					2818572288: 8421376,
					3087007744: 8389122,
					3355443200: 8388610,
					3623878656: 32770,
					3892314112: 514,
					4160749568: 8388608,
					1: 32768,
					268435457: 2,
					536870913: 8421888,
					805306369: 8388608,
					1073741825: 8421378,
					1342177281: 33280,
					1610612737: 512,
					1879048193: 8389122,
					2147483649: 8421890,
					2415919105: 8421376,
					2684354561: 8388610,
					2952790017: 33282,
					3221225473: 514,
					3489660929: 8389120,
					3758096385: 32770,
					4026531841: 0,
					134217729: 8421890,
					402653185: 8421376,
					671088641: 8388608,
					939524097: 512,
					1207959553: 32768,
					1476395009: 8388610,
					1744830465: 2,
					2013265921: 33282,
					2281701377: 32770,
					2550136833: 8389122,
					2818572289: 514,
					3087007745: 8421888,
					3355443201: 8389120,
					3623878657: 0,
					3892314113: 33280,
					4160749569: 8421378
				},
				{
					0: 1074282512,
					16777216: 16384,
					33554432: 524288,
					50331648: 1074266128,
					67108864: 1073741840,
					83886080: 1074282496,
					100663296: 1073758208,
					117440512: 16,
					134217728: 540672,
					150994944: 1073758224,
					167772160: 1073741824,
					184549376: 540688,
					201326592: 524304,
					218103808: 0,
					234881024: 16400,
					251658240: 1074266112,
					8388608: 1073758208,
					25165824: 540688,
					41943040: 16,
					58720256: 1073758224,
					75497472: 1074282512,
					92274688: 1073741824,
					109051904: 524288,
					125829120: 1074266128,
					142606336: 524304,
					159383552: 0,
					176160768: 16384,
					192937984: 1074266112,
					209715200: 1073741840,
					226492416: 540672,
					243269632: 1074282496,
					260046848: 16400,
					268435456: 0,
					285212672: 1074266128,
					301989888: 1073758224,
					318767104: 1074282496,
					335544320: 1074266112,
					352321536: 16,
					369098752: 540688,
					385875968: 16384,
					402653184: 16400,
					419430400: 524288,
					436207616: 524304,
					452984832: 1073741840,
					469762048: 540672,
					486539264: 1073758208,
					503316480: 1073741824,
					520093696: 1074282512,
					276824064: 540688,
					293601280: 524288,
					310378496: 1074266112,
					327155712: 16384,
					343932928: 1073758208,
					360710144: 1074282512,
					377487360: 16,
					394264576: 1073741824,
					411041792: 1074282496,
					427819008: 1073741840,
					444596224: 1073758224,
					461373440: 524304,
					478150656: 0,
					494927872: 16400,
					511705088: 1074266128,
					528482304: 540672
				},
				{
					0: 260,
					1048576: 0,
					2097152: 67109120,
					3145728: 65796,
					4194304: 65540,
					5242880: 67108868,
					6291456: 67174660,
					7340032: 67174400,
					8388608: 67108864,
					9437184: 67174656,
					10485760: 65792,
					11534336: 67174404,
					12582912: 67109124,
					13631488: 65536,
					14680064: 4,
					15728640: 256,
					524288: 67174656,
					1572864: 67174404,
					2621440: 0,
					3670016: 67109120,
					4718592: 67108868,
					5767168: 65536,
					6815744: 65540,
					7864320: 260,
					8912896: 4,
					9961472: 256,
					11010048: 67174400,
					12058624: 65796,
					13107200: 65792,
					14155776: 67109124,
					15204352: 67174660,
					16252928: 67108864,
					16777216: 67174656,
					17825792: 65540,
					18874368: 65536,
					19922944: 67109120,
					20971520: 256,
					22020096: 67174660,
					23068672: 67108868,
					24117248: 0,
					25165824: 67109124,
					26214400: 67108864,
					27262976: 4,
					28311552: 65792,
					29360128: 67174400,
					30408704: 260,
					31457280: 65796,
					32505856: 67174404,
					17301504: 67108864,
					18350080: 260,
					19398656: 67174656,
					20447232: 0,
					21495808: 65540,
					22544384: 67109120,
					23592960: 256,
					24641536: 67174404,
					25690112: 65536,
					26738688: 67174660,
					27787264: 65796,
					28835840: 67108868,
					29884416: 67109124,
					30932992: 67174400,
					31981568: 4,
					33030144: 65792
				},
				{
					0: 2151682048,
					65536: 2147487808,
					131072: 4198464,
					196608: 2151677952,
					262144: 0,
					327680: 4198400,
					393216: 2147483712,
					458752: 4194368,
					524288: 2147483648,
					589824: 4194304,
					655360: 64,
					720896: 2147487744,
					786432: 2151678016,
					851968: 4160,
					917504: 4096,
					983040: 2151682112,
					32768: 2147487808,
					98304: 64,
					163840: 2151678016,
					229376: 2147487744,
					294912: 4198400,
					360448: 2151682112,
					425984: 0,
					491520: 2151677952,
					557056: 4096,
					622592: 2151682048,
					688128: 4194304,
					753664: 4160,
					819200: 2147483648,
					884736: 4194368,
					950272: 4198464,
					1015808: 2147483712,
					1048576: 4194368,
					1114112: 4198400,
					1179648: 2147483712,
					1245184: 0,
					1310720: 4160,
					1376256: 2151678016,
					1441792: 2151682048,
					1507328: 2147487808,
					1572864: 2151682112,
					1638400: 2147483648,
					1703936: 2151677952,
					1769472: 4198464,
					1835008: 2147487744,
					1900544: 4194304,
					1966080: 64,
					2031616: 4096,
					1081344: 2151677952,
					1146880: 2151682112,
					1212416: 0,
					1277952: 4198400,
					1343488: 4194368,
					1409024: 2147483648,
					1474560: 2147487808,
					1540096: 64,
					1605632: 2147483712,
					1671168: 4096,
					1736704: 2147487744,
					1802240: 2151678016,
					1867776: 4160,
					1933312: 2151682048,
					1998848: 4194304,
					2064384: 4198464
				},
				{
					0: 128,
					4096: 17039360,
					8192: 262144,
					12288: 536870912,
					16384: 537133184,
					20480: 16777344,
					24576: 553648256,
					28672: 262272,
					32768: 16777216,
					36864: 537133056,
					40960: 536871040,
					45056: 553910400,
					49152: 553910272,
					53248: 0,
					57344: 17039488,
					61440: 553648128,
					2048: 17039488,
					6144: 553648256,
					10240: 128,
					14336: 17039360,
					18432: 262144,
					22528: 537133184,
					26624: 553910272,
					30720: 536870912,
					34816: 537133056,
					38912: 0,
					43008: 553910400,
					47104: 16777344,
					51200: 536871040,
					55296: 553648128,
					59392: 16777216,
					63488: 262272,
					65536: 262144,
					69632: 128,
					73728: 536870912,
					77824: 553648256,
					81920: 16777344,
					86016: 553910272,
					90112: 537133184,
					94208: 16777216,
					98304: 553910400,
					102400: 553648128,
					106496: 17039360,
					110592: 537133056,
					114688: 262272,
					118784: 536871040,
					122880: 0,
					126976: 17039488,
					67584: 553648256,
					71680: 16777216,
					75776: 17039360,
					79872: 537133184,
					83968: 536870912,
					88064: 17039488,
					92160: 128,
					96256: 553910272,
					100352: 262272,
					104448: 553910400,
					108544: 0,
					112640: 553648128,
					116736: 16777344,
					120832: 262144,
					124928: 537133056,
					129024: 536871040
				},
				{
					0: 268435464,
					256: 8192,
					512: 270532608,
					768: 270540808,
					1024: 268443648,
					1280: 2097152,
					1536: 2097160,
					1792: 268435456,
					2048: 0,
					2304: 268443656,
					2560: 2105344,
					2816: 8,
					3072: 270532616,
					3328: 2105352,
					3584: 8200,
					3840: 270540800,
					128: 270532608,
					384: 270540808,
					640: 8,
					896: 2097152,
					1152: 2105352,
					1408: 268435464,
					1664: 268443648,
					1920: 8200,
					2176: 2097160,
					2432: 8192,
					2688: 268443656,
					2944: 270532616,
					3200: 0,
					3456: 270540800,
					3712: 2105344,
					3968: 268435456,
					4096: 268443648,
					4352: 270532616,
					4608: 270540808,
					4864: 8200,
					5120: 2097152,
					5376: 268435456,
					5632: 268435464,
					5888: 2105344,
					6144: 2105352,
					6400: 0,
					6656: 8,
					6912: 270532608,
					7168: 8192,
					7424: 268443656,
					7680: 270540800,
					7936: 2097160,
					4224: 8,
					4480: 2105344,
					4736: 2097152,
					4992: 268435464,
					5248: 268443648,
					5504: 8200,
					5760: 270540808,
					6016: 270532608,
					6272: 270540800,
					6528: 270532616,
					6784: 8192,
					7040: 2105352,
					7296: 2097160,
					7552: 0,
					7808: 268435456,
					8064: 268443656
				},
				{
					0: 1048576,
					16: 33555457,
					32: 1024,
					48: 1049601,
					64: 34604033,
					80: 0,
					96: 1,
					112: 34603009,
					128: 33555456,
					144: 1048577,
					160: 33554433,
					176: 34604032,
					192: 34603008,
					208: 1025,
					224: 1049600,
					240: 33554432,
					8: 34603009,
					24: 0,
					40: 33555457,
					56: 34604032,
					72: 1048576,
					88: 33554433,
					104: 33554432,
					120: 1025,
					136: 1049601,
					152: 33555456,
					168: 34603008,
					184: 1048577,
					200: 1024,
					216: 34604033,
					232: 1,
					248: 1049600,
					256: 33554432,
					272: 1048576,
					288: 33555457,
					304: 34603009,
					320: 1048577,
					336: 33555456,
					352: 34604032,
					368: 1049601,
					384: 1025,
					400: 34604033,
					416: 1049600,
					432: 1,
					448: 0,
					464: 34603008,
					480: 33554433,
					496: 1024,
					264: 1049600,
					280: 33555457,
					296: 34603009,
					312: 1,
					328: 33554432,
					344: 1048576,
					360: 1025,
					376: 34604032,
					392: 33554433,
					408: 34603008,
					424: 0,
					440: 34604033,
					456: 1049601,
					472: 1024,
					488: 33555456,
					504: 1048577
				},
				{
					0: 134219808,
					1: 131072,
					2: 134217728,
					3: 32,
					4: 131104,
					5: 134350880,
					6: 134350848,
					7: 2048,
					8: 134348800,
					9: 134219776,
					10: 133120,
					11: 134348832,
					12: 2080,
					13: 0,
					14: 134217760,
					15: 133152,
					2147483648: 2048,
					2147483649: 134350880,
					2147483650: 134219808,
					2147483651: 134217728,
					2147483652: 134348800,
					2147483653: 133120,
					2147483654: 133152,
					2147483655: 32,
					2147483656: 134217760,
					2147483657: 2080,
					2147483658: 131104,
					2147483659: 134350848,
					2147483660: 0,
					2147483661: 134348832,
					2147483662: 134219776,
					2147483663: 131072,
					16: 133152,
					17: 134350848,
					18: 32,
					19: 2048,
					20: 134219776,
					21: 134217760,
					22: 134348832,
					23: 131072,
					24: 0,
					25: 131104,
					26: 134348800,
					27: 134219808,
					28: 134350880,
					29: 133120,
					30: 2080,
					31: 134217728,
					2147483664: 131072,
					2147483665: 2048,
					2147483666: 134348832,
					2147483667: 133152,
					2147483668: 32,
					2147483669: 134348800,
					2147483670: 134217728,
					2147483671: 134219808,
					2147483672: 134350880,
					2147483673: 134217760,
					2147483674: 134219776,
					2147483675: 0,
					2147483676: 133120,
					2147483677: 2080,
					2147483678: 131104,
					2147483679: 134350848
				}
			];
			var SBOX_MASK = [
				4160749569,
				528482304,
				33030144,
				2064384,
				129024,
				8064,
				504,
				2147483679
			];
			/**
			* DES block cipher algorithm.
			*/
			var DES = C_algo.DES = BlockCipher.extend({
				_doReset: function() {
					var keyWords = this._key.words;
					var keyBits = [];
					for (var i = 0; i < 56; i++) {
						var keyBitPos = PC1[i] - 1;
						keyBits[i] = keyWords[keyBitPos >>> 5] >>> 31 - keyBitPos % 32 & 1;
					}
					var subKeys = this._subKeys = [];
					for (var nSubKey = 0; nSubKey < 16; nSubKey++) {
						var subKey = subKeys[nSubKey] = [];
						var bitShift = BIT_SHIFTS[nSubKey];
						for (var i = 0; i < 24; i++) {
							subKey[i / 6 | 0] |= keyBits[(PC2[i] - 1 + bitShift) % 28] << 31 - i % 6;
							subKey[4 + (i / 6 | 0)] |= keyBits[28 + (PC2[i + 24] - 1 + bitShift) % 28] << 31 - i % 6;
						}
						subKey[0] = subKey[0] << 1 | subKey[0] >>> 31;
						for (var i = 1; i < 7; i++) {subKey[i] = subKey[i] >>> (i - 1) * 4 + 3;}
						subKey[7] = subKey[7] << 5 | subKey[7] >>> 27;
					}
					var invSubKeys = this._invSubKeys = [];
					for (var i = 0; i < 16; i++) {invSubKeys[i] = subKeys[15 - i];}
				},
				encryptBlock: function(M, offset) {
					this._doCryptBlock(M, offset, this._subKeys);
				},
				decryptBlock: function(M, offset) {
					this._doCryptBlock(M, offset, this._invSubKeys);
				},
				_doCryptBlock: function(M, offset, subKeys) {
					this._lBlock = M[offset];
					this._rBlock = M[offset + 1];
					exchangeLR.call(this, 4, 252645135);
					exchangeLR.call(this, 16, 65535);
					exchangeRL.call(this, 2, 858993459);
					exchangeRL.call(this, 8, 16711935);
					exchangeLR.call(this, 1, 1431655765);
					for (var round = 0; round < 16; round++) {
						var subKey = subKeys[round];
						var lBlock = this._lBlock;
						var rBlock = this._rBlock;
						var f = 0;
						for (var i = 0; i < 8; i++) {f |= SBOX_P[i][((rBlock ^ subKey[i]) & SBOX_MASK[i]) >>> 0];}
						this._lBlock = rBlock;
						this._rBlock = lBlock ^ f;
					}
					var t = this._lBlock;
					this._lBlock = this._rBlock;
					this._rBlock = t;
					exchangeLR.call(this, 1, 1431655765);
					exchangeRL.call(this, 8, 16711935);
					exchangeRL.call(this, 2, 858993459);
					exchangeLR.call(this, 16, 65535);
					exchangeLR.call(this, 4, 252645135);
					M[offset] = this._lBlock;
					M[offset + 1] = this._rBlock;
				},
				keySize: 64 / 32,
				ivSize: 64 / 32,
				blockSize: 64 / 32
			});
			function exchangeLR(offset, mask) {
				var t = (this._lBlock >>> offset ^ this._rBlock) & mask;
				this._rBlock ^= t;
				this._lBlock ^= t << offset;
			}
			function exchangeRL(offset, mask) {
				var t = (this._rBlock >>> offset ^ this._lBlock) & mask;
				this._lBlock ^= t;
				this._rBlock ^= t << offset;
			}
			/**
			* Shortcut functions to the cipher's object interface.
			*
			* @example
			*
			*     var ciphertext = CryptoJS.DES.encrypt(message, key, cfg);
			*     var plaintext  = CryptoJS.DES.decrypt(ciphertext, key, cfg);
			*/
			C.DES = BlockCipher._createHelper(DES);
			/**
			* Triple-DES block cipher algorithm.
			*/
			var TripleDES = C_algo.TripleDES = BlockCipher.extend({
				_doReset: function() {
					var keyWords = this._key.words;
					if (keyWords.length !== 2 && keyWords.length !== 4 && keyWords.length < 6) {throw new Error("Invalid key length - 3DES requires the key length to be 64, 128, 192 or >192.");}
					var key1 = keyWords.slice(0, 2);
					var key2 = keyWords.length < 4 ? keyWords.slice(0, 2) : keyWords.slice(2, 4);
					var key3 = keyWords.length < 6 ? keyWords.slice(0, 2) : keyWords.slice(4, 6);
					this._des1 = DES.createEncryptor(WordArray.create(key1));
					this._des2 = DES.createEncryptor(WordArray.create(key2));
					this._des3 = DES.createEncryptor(WordArray.create(key3));
				},
				encryptBlock: function(M, offset) {
					this._des1.encryptBlock(M, offset);
					this._des2.decryptBlock(M, offset);
					this._des3.encryptBlock(M, offset);
				},
				decryptBlock: function(M, offset) {
					this._des3.decryptBlock(M, offset);
					this._des2.encryptBlock(M, offset);
					this._des1.decryptBlock(M, offset);
				},
				keySize: 192 / 32,
				ivSize: 64 / 32,
				blockSize: 64 / 32
			});
			/**
			* Shortcut functions to the cipher's object interface.
			*
			* @example
			*
			*     var ciphertext = CryptoJS.TripleDES.encrypt(message, key, cfg);
			*     var plaintext  = CryptoJS.TripleDES.decrypt(ciphertext, key, cfg);
			*/
			C.TripleDES = BlockCipher._createHelper(TripleDES);
		})();
		return CryptoJS.TripleDES;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/rc4.js
var require_rc4 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./enc-base64",
			"./md5",
			"./evpkdf",
			"./cipher-core"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var StreamCipher = C.lib.StreamCipher;
			var C_algo = C.algo;
			/**
			* RC4 stream cipher algorithm.
			*/
			var RC4 = C_algo.RC4 = StreamCipher.extend({
				_doReset: function() {
					var key = this._key;
					var keyWords = key.words;
					var keySigBytes = key.sigBytes;
					var S = this._S = [];
					for (var i = 0; i < 256; i++) {S[i] = i;}
					for (var i = 0, j = 0; i < 256; i++) {
						var keyByteIndex = i % keySigBytes;
						var keyByte = keyWords[keyByteIndex >>> 2] >>> 24 - keyByteIndex % 4 * 8 & 255;
						j = (j + S[i] + keyByte) % 256;
						var t = S[i];
						S[i] = S[j];
						S[j] = t;
					}
					this._i = this._j = 0;
				},
				_doProcessBlock: function(M, offset) {
					M[offset] ^= generateKeystreamWord.call(this);
				},
				keySize: 256 / 32,
				ivSize: 0
			});
			function generateKeystreamWord() {
				var S = this._S;
				var i = this._i;
				var j = this._j;
				var keystreamWord = 0;
				for (var n = 0; n < 4; n++) {
					i = (i + 1) % 256;
					j = (j + S[i]) % 256;
					var t = S[i];
					S[i] = S[j];
					S[j] = t;
					keystreamWord |= S[(S[i] + S[j]) % 256] << 24 - n * 8;
				}
				this._i = i;
				this._j = j;
				return keystreamWord;
			}
			/**
			* Shortcut functions to the cipher's object interface.
			*
			* @example
			*
			*     var ciphertext = CryptoJS.RC4.encrypt(message, key, cfg);
			*     var plaintext  = CryptoJS.RC4.decrypt(ciphertext, key, cfg);
			*/
			C.RC4 = StreamCipher._createHelper(RC4);
			/**
			* Modified RC4 stream cipher algorithm.
			*/
			var RC4Drop = C_algo.RC4Drop = RC4.extend({
				cfg: RC4.cfg.extend({ drop: 192 }),
				_doReset: function() {
					RC4._doReset.call(this);
					for (var i = this.cfg.drop; i > 0; i--) {generateKeystreamWord.call(this);}
				}
			});
			/**
			* Shortcut functions to the cipher's object interface.
			*
			* @example
			*
			*     var ciphertext = CryptoJS.RC4Drop.encrypt(message, key, cfg);
			*     var plaintext  = CryptoJS.RC4Drop.decrypt(ciphertext, key, cfg);
			*/
			C.RC4Drop = StreamCipher._createHelper(RC4Drop);
		})();
		return CryptoJS.RC4;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/rabbit.js
var require_rabbit = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./enc-base64",
			"./md5",
			"./evpkdf",
			"./cipher-core"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var StreamCipher = C.lib.StreamCipher;
			var C_algo = C.algo;
			var S = [];
			var C_ = [];
			var G = [];
			/**
			* Rabbit stream cipher algorithm
			*/
			var Rabbit = C_algo.Rabbit = StreamCipher.extend({
				_doReset: function() {
					var K = this._key.words;
					var iv = this.cfg.iv;
					for (var i = 0; i < 4; i++) {K[i] = (K[i] << 8 | K[i] >>> 24) & 16711935 | (K[i] << 24 | K[i] >>> 8) & 4278255360;}
					var X = this._X = [
						K[0],
						K[3] << 16 | K[2] >>> 16,
						K[1],
						K[0] << 16 | K[3] >>> 16,
						K[2],
						K[1] << 16 | K[0] >>> 16,
						K[3],
						K[2] << 16 | K[1] >>> 16
					];
					var C = this._C = [
						K[2] << 16 | K[2] >>> 16,
						K[0] & 4294901760 | K[1] & 65535,
						K[3] << 16 | K[3] >>> 16,
						K[1] & 4294901760 | K[2] & 65535,
						K[0] << 16 | K[0] >>> 16,
						K[2] & 4294901760 | K[3] & 65535,
						K[1] << 16 | K[1] >>> 16,
						K[3] & 4294901760 | K[0] & 65535
					];
					this._b = 0;
					for (var i = 0; i < 4; i++) {nextState.call(this);}
					for (var i = 0; i < 8; i++) {C[i] ^= X[i + 4 & 7];}
					if (iv) {
						var IV = iv.words;
						var IV_0 = IV[0];
						var IV_1 = IV[1];
						var i0 = (IV_0 << 8 | IV_0 >>> 24) & 16711935 | (IV_0 << 24 | IV_0 >>> 8) & 4278255360;
						var i2 = (IV_1 << 8 | IV_1 >>> 24) & 16711935 | (IV_1 << 24 | IV_1 >>> 8) & 4278255360;
						var i1 = i0 >>> 16 | i2 & 4294901760;
						var i3 = i2 << 16 | i0 & 65535;
						C[0] ^= i0;
						C[1] ^= i1;
						C[2] ^= i2;
						C[3] ^= i3;
						C[4] ^= i0;
						C[5] ^= i1;
						C[6] ^= i2;
						C[7] ^= i3;
						for (var i = 0; i < 4; i++) {nextState.call(this);}
					}
				},
				_doProcessBlock: function(M, offset) {
					var X = this._X;
					nextState.call(this);
					S[0] = X[0] ^ X[5] >>> 16 ^ X[3] << 16;
					S[1] = X[2] ^ X[7] >>> 16 ^ X[5] << 16;
					S[2] = X[4] ^ X[1] >>> 16 ^ X[7] << 16;
					S[3] = X[6] ^ X[3] >>> 16 ^ X[1] << 16;
					for (var i = 0; i < 4; i++) {
						S[i] = (S[i] << 8 | S[i] >>> 24) & 16711935 | (S[i] << 24 | S[i] >>> 8) & 4278255360;
						M[offset + i] ^= S[i];
					}
				},
				blockSize: 128 / 32,
				ivSize: 64 / 32
			});
			function nextState() {
				var X = this._X;
				var C = this._C;
				for (var i = 0; i < 8; i++) {C_[i] = C[i];}
				C[0] = C[0] + 1295307597 + this._b | 0;
				C[1] = C[1] + 3545052371 + (C[0] >>> 0 < C_[0] >>> 0 ? 1 : 0) | 0;
				C[2] = C[2] + 886263092 + (C[1] >>> 0 < C_[1] >>> 0 ? 1 : 0) | 0;
				C[3] = C[3] + 1295307597 + (C[2] >>> 0 < C_[2] >>> 0 ? 1 : 0) | 0;
				C[4] = C[4] + 3545052371 + (C[3] >>> 0 < C_[3] >>> 0 ? 1 : 0) | 0;
				C[5] = C[5] + 886263092 + (C[4] >>> 0 < C_[4] >>> 0 ? 1 : 0) | 0;
				C[6] = C[6] + 1295307597 + (C[5] >>> 0 < C_[5] >>> 0 ? 1 : 0) | 0;
				C[7] = C[7] + 3545052371 + (C[6] >>> 0 < C_[6] >>> 0 ? 1 : 0) | 0;
				this._b = C[7] >>> 0 < C_[7] >>> 0 ? 1 : 0;
				for (var i = 0; i < 8; i++) {
					var gx = X[i] + C[i];
					var ga = gx & 65535;
					var gb = gx >>> 16;
					G[i] = ((ga * ga >>> 17) + ga * gb >>> 15) + gb * gb ^ ((gx & 4294901760) * gx | 0) + ((gx & 65535) * gx | 0);
				}
				X[0] = G[0] + (G[7] << 16 | G[7] >>> 16) + (G[6] << 16 | G[6] >>> 16) | 0;
				X[1] = G[1] + (G[0] << 8 | G[0] >>> 24) + G[7] | 0;
				X[2] = G[2] + (G[1] << 16 | G[1] >>> 16) + (G[0] << 16 | G[0] >>> 16) | 0;
				X[3] = G[3] + (G[2] << 8 | G[2] >>> 24) + G[1] | 0;
				X[4] = G[4] + (G[3] << 16 | G[3] >>> 16) + (G[2] << 16 | G[2] >>> 16) | 0;
				X[5] = G[5] + (G[4] << 8 | G[4] >>> 24) + G[3] | 0;
				X[6] = G[6] + (G[5] << 16 | G[5] >>> 16) + (G[4] << 16 | G[4] >>> 16) | 0;
				X[7] = G[7] + (G[6] << 8 | G[6] >>> 24) + G[5] | 0;
			}
			/**
			* Shortcut functions to the cipher's object interface.
			*
			* @example
			*
			*     var ciphertext = CryptoJS.Rabbit.encrypt(message, key, cfg);
			*     var plaintext  = CryptoJS.Rabbit.decrypt(ciphertext, key, cfg);
			*/
			C.Rabbit = StreamCipher._createHelper(Rabbit);
		})();
		return CryptoJS.Rabbit;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/rabbit-legacy.js
var require_rabbit_legacy = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./enc-base64",
			"./md5",
			"./evpkdf",
			"./cipher-core"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var StreamCipher = C.lib.StreamCipher;
			var C_algo = C.algo;
			var S = [];
			var C_ = [];
			var G = [];
			/**
			* Rabbit stream cipher algorithm.
			*
			* This is a legacy version that neglected to convert the key to little-endian.
			* This error doesn't affect the cipher's security,
			* but it does affect its compatibility with other implementations.
			*/
			var RabbitLegacy = C_algo.RabbitLegacy = StreamCipher.extend({
				_doReset: function() {
					var K = this._key.words;
					var iv = this.cfg.iv;
					var X = this._X = [
						K[0],
						K[3] << 16 | K[2] >>> 16,
						K[1],
						K[0] << 16 | K[3] >>> 16,
						K[2],
						K[1] << 16 | K[0] >>> 16,
						K[3],
						K[2] << 16 | K[1] >>> 16
					];
					var C = this._C = [
						K[2] << 16 | K[2] >>> 16,
						K[0] & 4294901760 | K[1] & 65535,
						K[3] << 16 | K[3] >>> 16,
						K[1] & 4294901760 | K[2] & 65535,
						K[0] << 16 | K[0] >>> 16,
						K[2] & 4294901760 | K[3] & 65535,
						K[1] << 16 | K[1] >>> 16,
						K[3] & 4294901760 | K[0] & 65535
					];
					this._b = 0;
					for (var i = 0; i < 4; i++) {nextState.call(this);}
					for (var i = 0; i < 8; i++) {C[i] ^= X[i + 4 & 7];}
					if (iv) {
						var IV = iv.words;
						var IV_0 = IV[0];
						var IV_1 = IV[1];
						var i0 = (IV_0 << 8 | IV_0 >>> 24) & 16711935 | (IV_0 << 24 | IV_0 >>> 8) & 4278255360;
						var i2 = (IV_1 << 8 | IV_1 >>> 24) & 16711935 | (IV_1 << 24 | IV_1 >>> 8) & 4278255360;
						var i1 = i0 >>> 16 | i2 & 4294901760;
						var i3 = i2 << 16 | i0 & 65535;
						C[0] ^= i0;
						C[1] ^= i1;
						C[2] ^= i2;
						C[3] ^= i3;
						C[4] ^= i0;
						C[5] ^= i1;
						C[6] ^= i2;
						C[7] ^= i3;
						for (var i = 0; i < 4; i++) {nextState.call(this);}
					}
				},
				_doProcessBlock: function(M, offset) {
					var X = this._X;
					nextState.call(this);
					S[0] = X[0] ^ X[5] >>> 16 ^ X[3] << 16;
					S[1] = X[2] ^ X[7] >>> 16 ^ X[5] << 16;
					S[2] = X[4] ^ X[1] >>> 16 ^ X[7] << 16;
					S[3] = X[6] ^ X[3] >>> 16 ^ X[1] << 16;
					for (var i = 0; i < 4; i++) {
						S[i] = (S[i] << 8 | S[i] >>> 24) & 16711935 | (S[i] << 24 | S[i] >>> 8) & 4278255360;
						M[offset + i] ^= S[i];
					}
				},
				blockSize: 128 / 32,
				ivSize: 64 / 32
			});
			function nextState() {
				var X = this._X;
				var C = this._C;
				for (var i = 0; i < 8; i++) {C_[i] = C[i];}
				C[0] = C[0] + 1295307597 + this._b | 0;
				C[1] = C[1] + 3545052371 + (C[0] >>> 0 < C_[0] >>> 0 ? 1 : 0) | 0;
				C[2] = C[2] + 886263092 + (C[1] >>> 0 < C_[1] >>> 0 ? 1 : 0) | 0;
				C[3] = C[3] + 1295307597 + (C[2] >>> 0 < C_[2] >>> 0 ? 1 : 0) | 0;
				C[4] = C[4] + 3545052371 + (C[3] >>> 0 < C_[3] >>> 0 ? 1 : 0) | 0;
				C[5] = C[5] + 886263092 + (C[4] >>> 0 < C_[4] >>> 0 ? 1 : 0) | 0;
				C[6] = C[6] + 1295307597 + (C[5] >>> 0 < C_[5] >>> 0 ? 1 : 0) | 0;
				C[7] = C[7] + 3545052371 + (C[6] >>> 0 < C_[6] >>> 0 ? 1 : 0) | 0;
				this._b = C[7] >>> 0 < C_[7] >>> 0 ? 1 : 0;
				for (var i = 0; i < 8; i++) {
					var gx = X[i] + C[i];
					var ga = gx & 65535;
					var gb = gx >>> 16;
					G[i] = ((ga * ga >>> 17) + ga * gb >>> 15) + gb * gb ^ ((gx & 4294901760) * gx | 0) + ((gx & 65535) * gx | 0);
				}
				X[0] = G[0] + (G[7] << 16 | G[7] >>> 16) + (G[6] << 16 | G[6] >>> 16) | 0;
				X[1] = G[1] + (G[0] << 8 | G[0] >>> 24) + G[7] | 0;
				X[2] = G[2] + (G[1] << 16 | G[1] >>> 16) + (G[0] << 16 | G[0] >>> 16) | 0;
				X[3] = G[3] + (G[2] << 8 | G[2] >>> 24) + G[1] | 0;
				X[4] = G[4] + (G[3] << 16 | G[3] >>> 16) + (G[2] << 16 | G[2] >>> 16) | 0;
				X[5] = G[5] + (G[4] << 8 | G[4] >>> 24) + G[3] | 0;
				X[6] = G[6] + (G[5] << 16 | G[5] >>> 16) + (G[4] << 16 | G[4] >>> 16) | 0;
				X[7] = G[7] + (G[6] << 8 | G[6] >>> 24) + G[5] | 0;
			}
			/**
			* Shortcut functions to the cipher's object interface.
			*
			* @example
			*
			*     var ciphertext = CryptoJS.RabbitLegacy.encrypt(message, key, cfg);
			*     var plaintext  = CryptoJS.RabbitLegacy.decrypt(ciphertext, key, cfg);
			*/
			C.RabbitLegacy = StreamCipher._createHelper(RabbitLegacy);
		})();
		return CryptoJS.RabbitLegacy;
	});
}));
//#endregion
//#region node_modules/.pnpm/crypto-js@4.2.0/node_modules/crypto-js/blowfish.js
var require_blowfish = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_enc_base64(), require_md5(), require_evpkdf(), require_cipher_core());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./enc-base64",
			"./md5",
			"./evpkdf",
			"./cipher-core"
		], factory);}
		else {factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		(function() {
			var C = CryptoJS;
			var BlockCipher = C.lib.BlockCipher;
			var C_algo = C.algo;
			const N = 16;
			const ORIG_P = [
				608135816,
				2242054355,
				320440878,
				57701188,
				2752067618,
				698298832,
				137296536,
				3964562569,
				1160258022,
				953160567,
				3193202383,
				887688300,
				3232508343,
				3380367581,
				1065670069,
				3041331479,
				2450970073,
				2306472731
			];
			const ORIG_S = [
				[
					3509652390,
					2564797868,
					805139163,
					3491422135,
					3101798381,
					1780907670,
					3128725573,
					4046225305,
					614570311,
					3012652279,
					134345442,
					2240740374,
					1667834072,
					1901547113,
					2757295779,
					4103290238,
					227898511,
					1921955416,
					1904987480,
					2182433518,
					2069144605,
					3260701109,
					2620446009,
					720527379,
					3318853667,
					677414384,
					3393288472,
					3101374703,
					2390351024,
					1614419982,
					1822297739,
					2954791486,
					3608508353,
					3174124327,
					2024746970,
					1432378464,
					3864339955,
					2857741204,
					1464375394,
					1676153920,
					1439316330,
					715854006,
					3033291828,
					289532110,
					2706671279,
					2087905683,
					3018724369,
					1668267050,
					732546397,
					1947742710,
					3462151702,
					2609353502,
					2950085171,
					1814351708,
					2050118529,
					680887927,
					999245976,
					1800124847,
					3300911131,
					1713906067,
					1641548236,
					4213287313,
					1216130144,
					1575780402,
					4018429277,
					3917837745,
					3693486850,
					3949271944,
					596196993,
					3549867205,
					258830323,
					2213823033,
					772490370,
					2760122372,
					1774776394,
					2652871518,
					566650946,
					4142492826,
					1728879713,
					2882767088,
					1783734482,
					3629395816,
					2517608232,
					2874225571,
					1861159788,
					326777828,
					3124490320,
					2130389656,
					2716951837,
					967770486,
					1724537150,
					2185432712,
					2364442137,
					1164943284,
					2105845187,
					998989502,
					3765401048,
					2244026483,
					1075463327,
					1455516326,
					1322494562,
					910128902,
					469688178,
					1117454909,
					936433444,
					3490320968,
					3675253459,
					1240580251,
					122909385,
					2157517691,
					634681816,
					4142456567,
					3825094682,
					3061402683,
					2540495037,
					79693498,
					3249098678,
					1084186820,
					1583128258,
					426386531,
					1761308591,
					1047286709,
					322548459,
					995290223,
					1845252383,
					2603652396,
					3431023940,
					2942221577,
					3202600964,
					3727903485,
					1712269319,
					422464435,
					3234572375,
					1170764815,
					3523960633,
					3117677531,
					1434042557,
					442511882,
					3600875718,
					1076654713,
					1738483198,
					4213154764,
					2393238008,
					3677496056,
					1014306527,
					4251020053,
					793779912,
					2902807211,
					842905082,
					4246964064,
					1395751752,
					1040244610,
					2656851899,
					3396308128,
					445077038,
					3742853595,
					3577915638,
					679411651,
					2892444358,
					2354009459,
					1767581616,
					3150600392,
					3791627101,
					3102740896,
					284835224,
					4246832056,
					1258075500,
					768725851,
					2589189241,
					3069724005,
					3532540348,
					1274779536,
					3789419226,
					2764799539,
					1660621633,
					3471099624,
					4011903706,
					913787905,
					3497959166,
					737222580,
					2514213453,
					2928710040,
					3937242737,
					1804850592,
					3499020752,
					2949064160,
					2386320175,
					2390070455,
					2415321851,
					4061277028,
					2290661394,
					2416832540,
					1336762016,
					1754252060,
					3520065937,
					3014181293,
					791618072,
					3188594551,
					3933548030,
					2332172193,
					3852520463,
					3043980520,
					413987798,
					3465142937,
					3030929376,
					4245938359,
					2093235073,
					3534596313,
					375366246,
					2157278981,
					2479649556,
					555357303,
					3870105701,
					2008414854,
					3344188149,
					4221384143,
					3956125452,
					2067696032,
					3594591187,
					2921233993,
					2428461,
					544322398,
					577241275,
					1471733935,
					610547355,
					4027169054,
					1432588573,
					1507829418,
					2025931657,
					3646575487,
					545086370,
					48609733,
					2200306550,
					1653985193,
					298326376,
					1316178497,
					3007786442,
					2064951626,
					458293330,
					2589141269,
					3591329599,
					3164325604,
					727753846,
					2179363840,
					146436021,
					1461446943,
					4069977195,
					705550613,
					3059967265,
					3887724982,
					4281599278,
					3313849956,
					1404054877,
					2845806497,
					146425753,
					1854211946
				],
				[
					1266315497,
					3048417604,
					3681880366,
					3289982499,
					290971e4,
					1235738493,
					2632868024,
					2414719590,
					3970600049,
					1771706367,
					1449415276,
					3266420449,
					422970021,
					1963543593,
					2690192192,
					3826793022,
					1062508698,
					1531092325,
					1804592342,
					2583117782,
					2714934279,
					4024971509,
					1294809318,
					4028980673,
					1289560198,
					2221992742,
					1669523910,
					35572830,
					157838143,
					1052438473,
					1016535060,
					1802137761,
					1753167236,
					1386275462,
					3080475397,
					2857371447,
					1040679964,
					2145300060,
					2390574316,
					1461121720,
					2956646967,
					4031777805,
					4028374788,
					33600511,
					2920084762,
					1018524850,
					629373528,
					3691585981,
					3515945977,
					2091462646,
					2486323059,
					586499841,
					988145025,
					935516892,
					3367335476,
					2599673255,
					2839830854,
					265290510,
					3972581182,
					2759138881,
					3795373465,
					1005194799,
					847297441,
					406762289,
					1314163512,
					1332590856,
					1866599683,
					4127851711,
					750260880,
					613907577,
					1450815602,
					3165620655,
					3734664991,
					3650291728,
					3012275730,
					3704569646,
					1427272223,
					778793252,
					1343938022,
					2676280711,
					2052605720,
					1946737175,
					3164576444,
					3914038668,
					3967478842,
					3682934266,
					1661551462,
					3294938066,
					4011595847,
					840292616,
					3712170807,
					616741398,
					312560963,
					711312465,
					1351876610,
					322626781,
					1910503582,
					271666773,
					2175563734,
					1594956187,
					70604529,
					3617834859,
					1007753275,
					1495573769,
					4069517037,
					2549218298,
					2663038764,
					504708206,
					2263041392,
					3941167025,
					2249088522,
					1514023603,
					1998579484,
					1312622330,
					694541497,
					2582060303,
					2151582166,
					1382467621,
					776784248,
					2618340202,
					3323268794,
					2497899128,
					2784771155,
					503983604,
					4076293799,
					907881277,
					423175695,
					432175456,
					1378068232,
					4145222326,
					3954048622,
					3938656102,
					3820766613,
					2793130115,
					2977904593,
					26017576,
					3274890735,
					3194772133,
					1700274565,
					1756076034,
					4006520079,
					3677328699,
					720338349,
					1533947780,
					354530856,
					688349552,
					3973924725,
					1637815568,
					332179504,
					3949051286,
					53804574,
					2852348879,
					3044236432,
					1282449977,
					3583942155,
					3416972820,
					4006381244,
					1617046695,
					2628476075,
					3002303598,
					1686838959,
					431878346,
					2686675385,
					1700445008,
					1080580658,
					1009431731,
					832498133,
					3223435511,
					2605976345,
					2271191193,
					2516031870,
					1648197032,
					4164389018,
					2548247927,
					300782431,
					375919233,
					238389289,
					3353747414,
					2531188641,
					2019080857,
					1475708069,
					455242339,
					2609103871,
					448939670,
					3451063019,
					1395535956,
					2413381860,
					1841049896,
					1491858159,
					885456874,
					4264095073,
					4001119347,
					1565136089,
					3898914787,
					1108368660,
					540939232,
					1173283510,
					2745871338,
					3681308437,
					4207628240,
					3343053890,
					4016749493,
					1699691293,
					1103962373,
					3625875870,
					2256883143,
					3830138730,
					1031889488,
					3479347698,
					1535977030,
					4236805024,
					3251091107,
					2132092099,
					1774941330,
					1199868427,
					1452454533,
					157007616,
					2904115357,
					342012276,
					595725824,
					1480756522,
					206960106,
					497939518,
					591360097,
					863170706,
					2375253569,
					3596610801,
					1814182875,
					2094937945,
					3421402208,
					1082520231,
					3463918190,
					2785509508,
					435703966,
					3908032597,
					1641649973,
					2842273706,
					3305899714,
					1510255612,
					2148256476,
					2655287854,
					3276092548,
					4258621189,
					236887753,
					3681803219,
					274041037,
					1734335097,
					3815195456,
					3317970021,
					1899903192,
					1026095262,
					4050517792,
					356393447,
					2410691914,
					3873677099,
					3682840055
				],
				[
					3913112168,
					2491498743,
					4132185628,
					2489919796,
					1091903735,
					1979897079,
					3170134830,
					3567386728,
					3557303409,
					857797738,
					1136121015,
					1342202287,
					507115054,
					2535736646,
					337727348,
					3213592640,
					1301675037,
					2528481711,
					1895095763,
					1721773893,
					3216771564,
					62756741,
					2142006736,
					835421444,
					2531993523,
					1442658625,
					3659876326,
					2882144922,
					676362277,
					1392781812,
					170690266,
					3921047035,
					1759253602,
					3611846912,
					1745797284,
					664899054,
					1329594018,
					3901205900,
					3045908486,
					2062866102,
					2865634940,
					3543621612,
					3464012697,
					1080764994,
					553557557,
					3656615353,
					3996768171,
					991055499,
					499776247,
					1265440854,
					648242737,
					3940784050,
					980351604,
					3713745714,
					1749149687,
					3396870395,
					4211799374,
					3640570775,
					1161844396,
					3125318951,
					1431517754,
					545492359,
					4268468663,
					3499529547,
					1437099964,
					2702547544,
					3433638243,
					2581715763,
					2787789398,
					1060185593,
					1593081372,
					2418618748,
					4260947970,
					69676912,
					2159744348,
					86519011,
					2512459080,
					3838209314,
					1220612927,
					3339683548,
					133810670,
					1090789135,
					1078426020,
					1569222167,
					845107691,
					3583754449,
					4072456591,
					1091646820,
					628848692,
					1613405280,
					3757631651,
					526609435,
					236106946,
					48312990,
					2942717905,
					3402727701,
					1797494240,
					859738849,
					992217954,
					4005476642,
					2243076622,
					3870952857,
					3732016268,
					765654824,
					3490871365,
					2511836413,
					1685915746,
					3888969200,
					1414112111,
					2273134842,
					3281911079,
					4080962846,
					172450625,
					2569994100,
					980381355,
					4109958455,
					2819808352,
					2716589560,
					2568741196,
					3681446669,
					3329971472,
					1835478071,
					660984891,
					3704678404,
					4045999559,
					3422617507,
					3040415634,
					1762651403,
					1719377915,
					3470491036,
					2693910283,
					3642056355,
					3138596744,
					1364962596,
					2073328063,
					1983633131,
					926494387,
					3423689081,
					2150032023,
					4096667949,
					1749200295,
					3328846651,
					309677260,
					2016342300,
					1779581495,
					3079819751,
					111262694,
					1274766160,
					443224088,
					298511866,
					1025883608,
					3806446537,
					1145181785,
					168956806,
					3641502830,
					3584813610,
					1689216846,
					3666258015,
					3200248200,
					1692713982,
					2646376535,
					4042768518,
					1618508792,
					1610833997,
					3523052358,
					4130873264,
					2001055236,
					3610705100,
					2202168115,
					4028541809,
					2961195399,
					1006657119,
					2006996926,
					3186142756,
					1430667929,
					3210227297,
					1314452623,
					4074634658,
					4101304120,
					2273951170,
					1399257539,
					3367210612,
					3027628629,
					1190975929,
					2062231137,
					2333990788,
					2221543033,
					2438960610,
					1181637006,
					548689776,
					2362791313,
					3372408396,
					3104550113,
					3145860560,
					296247880,
					1970579870,
					3078560182,
					3769228297,
					1714227617,
					3291629107,
					3898220290,
					166772364,
					1251581989,
					493813264,
					448347421,
					195405023,
					2709975567,
					677966185,
					3703036547,
					1463355134,
					2715995803,
					1338867538,
					1343315457,
					2802222074,
					2684532164,
					233230375,
					2599980071,
					2000651841,
					3277868038,
					1638401717,
					4028070440,
					3237316320,
					6314154,
					819756386,
					300326615,
					590932579,
					1405279636,
					3267499572,
					3150704214,
					2428286686,
					3959192993,
					3461946742,
					1862657033,
					1266418056,
					963775037,
					2089974820,
					2263052895,
					1917689273,
					448879540,
					3550394620,
					3981727096,
					150775221,
					3627908307,
					1303187396,
					508620638,
					2975983352,
					2726630617,
					1817252668,
					1876281319,
					1457606340,
					908771278,
					3720792119,
					3617206836,
					2455994898,
					1729034894,
					1080033504
				],
				[
					976866871,
					3556439503,
					2881648439,
					1522871579,
					1555064734,
					1336096578,
					3548522304,
					2579274686,
					3574697629,
					3205460757,
					3593280638,
					3338716283,
					3079412587,
					564236357,
					2993598910,
					1781952180,
					1464380207,
					3163844217,
					3332601554,
					1699332808,
					1393555694,
					1183702653,
					3581086237,
					1288719814,
					691649499,
					2847557200,
					2895455976,
					3193889540,
					2717570544,
					1781354906,
					1676643554,
					2592534050,
					3230253752,
					1126444790,
					2770207658,
					2633158820,
					2210423226,
					2615765581,
					2414155088,
					3127139286,
					673620729,
					2805611233,
					1269405062,
					4015350505,
					3341807571,
					4149409754,
					1057255273,
					2012875353,
					2162469141,
					2276492801,
					2601117357,
					993977747,
					3918593370,
					2654263191,
					753973209,
					36408145,
					2530585658,
					25011837,
					3520020182,
					2088578344,
					530523599,
					2918365339,
					1524020338,
					1518925132,
					3760827505,
					3759777254,
					1202760957,
					3985898139,
					3906192525,
					674977740,
					4174734889,
					2031300136,
					2019492241,
					3983892565,
					4153806404,
					3822280332,
					352677332,
					2297720250,
					60907813,
					90501309,
					3286998549,
					1016092578,
					2535922412,
					2839152426,
					457141659,
					509813237,
					4120667899,
					652014361,
					1966332200,
					2975202805,
					55981186,
					2327461051,
					676427537,
					3255491064,
					2882294119,
					3433927263,
					1307055953,
					942726286,
					933058658,
					2468411793,
					3933900994,
					4215176142,
					1361170020,
					2001714738,
					2830558078,
					3274259782,
					1222529897,
					1679025792,
					2729314320,
					3714953764,
					1770335741,
					151462246,
					3013232138,
					1682292957,
					1483529935,
					471910574,
					1539241949,
					458788160,
					3436315007,
					1807016891,
					3718408830,
					978976581,
					1043663428,
					3165965781,
					1927990952,
					4200891579,
					2372276910,
					3208408903,
					3533431907,
					1412390302,
					2931980059,
					4132332400,
					1947078029,
					3881505623,
					4168226417,
					2941484381,
					1077988104,
					1320477388,
					886195818,
					18198404,
					3786409e3,
					2509781533,
					112762804,
					3463356488,
					1866414978,
					891333506,
					18488651,
					661792760,
					1628790961,
					3885187036,
					3141171499,
					876946877,
					2693282273,
					1372485963,
					791857591,
					2686433993,
					3759982718,
					3167212022,
					3472953795,
					2716379847,
					445679433,
					3561995674,
					3504004811,
					3574258232,
					54117162,
					3331405415,
					2381918588,
					3769707343,
					4154350007,
					1140177722,
					4074052095,
					668550556,
					3214352940,
					367459370,
					261225585,
					2610173221,
					4209349473,
					3468074219,
					3265815641,
					314222801,
					3066103646,
					3808782860,
					282218597,
					3406013506,
					3773591054,
					379116347,
					1285071038,
					846784868,
					2669647154,
					3771962079,
					3550491691,
					2305946142,
					453669953,
					1268987020,
					3317592352,
					3279303384,
					3744833421,
					2610507566,
					3859509063,
					266596637,
					3847019092,
					517658769,
					3462560207,
					3443424879,
					370717030,
					4247526661,
					2224018117,
					4143653529,
					4112773975,
					2788324899,
					2477274417,
					1456262402,
					2901442914,
					1517677493,
					1846949527,
					2295493580,
					3734397586,
					2176403920,
					1280348187,
					1908823572,
					3871786941,
					846861322,
					1172426758,
					3287448474,
					3383383037,
					1655181056,
					3139813346,
					901632758,
					1897031941,
					2986607138,
					3066810236,
					3447102507,
					1393639104,
					373351379,
					950779232,
					625454576,
					3124240540,
					4148612726,
					2007998917,
					544563296,
					2244738638,
					2330496472,
					2058025392,
					1291430526,
					424198748,
					50039436,
					29584100,
					3605783033,
					2429876329,
					2791104160,
					1057563949,
					3255363231,
					3075367218,
					3463963227,
					1469046755,
					985887462
				]
			];
			var BLOWFISH_CTX = {
				pbox: [],
				sbox: []
			};
			function F(ctx, x) {
				let a = x >> 24 & 255;
				let b = x >> 16 & 255;
				let c = x >> 8 & 255;
				let d = x & 255;
				let y = ctx.sbox[0][a] + ctx.sbox[1][b];
				y = y ^ ctx.sbox[2][c];
				y = y + ctx.sbox[3][d];
				return y;
			}
			function BlowFish_Encrypt(ctx, left, right) {
				let Xl = left;
				let Xr = right;
				let temp;
				for (let i = 0; i < N; ++i) {
					Xl = Xl ^ ctx.pbox[i];
					Xr = F(ctx, Xl) ^ Xr;
					temp = Xl;
					Xl = Xr;
					Xr = temp;
				}
				temp = Xl;
				Xl = Xr;
				Xr = temp;
				Xr = Xr ^ ctx.pbox[N];
				Xl = Xl ^ ctx.pbox[N + 1];
				return {
					left: Xl,
					right: Xr
				};
			}
			function BlowFish_Decrypt(ctx, left, right) {
				let Xl = left;
				let Xr = right;
				let temp;
				for (let i = N + 1; i > 1; --i) {
					Xl = Xl ^ ctx.pbox[i];
					Xr = F(ctx, Xl) ^ Xr;
					temp = Xl;
					Xl = Xr;
					Xr = temp;
				}
				temp = Xl;
				Xl = Xr;
				Xr = temp;
				Xr = Xr ^ ctx.pbox[1];
				Xl = Xl ^ ctx.pbox[0];
				return {
					left: Xl,
					right: Xr
				};
			}
			/**
			* Initialization ctx's pbox and sbox.
			*
			* @param {Object} ctx The object has pbox and sbox.
			* @param {Array} key An array of 32-bit words.
			* @param {int} keysize The length of the key.
			*
			* @example
			*
			*     BlowFishInit(BLOWFISH_CTX, key, 128/32);
			*/
			function BlowFishInit(ctx, key, keysize) {
				for (let Row = 0; Row < 4; Row++) {
					ctx.sbox[Row] = [];
					for (let Col = 0; Col < 256; Col++) {ctx.sbox[Row][Col] = ORIG_S[Row][Col];}
				}
				let keyIndex = 0;
				for (let index = 0; index < N + 2; index++) {
					ctx.pbox[index] = ORIG_P[index] ^ key[keyIndex];
					keyIndex++;
					if (keyIndex >= keysize) {keyIndex = 0;}
				}
				let Data1 = 0;
				let Data2 = 0;
				let res = 0;
				for (let i = 0; i < N + 2; i += 2) {
					res = BlowFish_Encrypt(ctx, Data1, Data2);
					Data1 = res.left;
					Data2 = res.right;
					ctx.pbox[i] = Data1;
					ctx.pbox[i + 1] = Data2;
				}
				for (let i = 0; i < 4; i++) {for (let j = 0; j < 256; j += 2) {
					res = BlowFish_Encrypt(ctx, Data1, Data2);
					Data1 = res.left;
					Data2 = res.right;
					ctx.sbox[i][j] = Data1;
					ctx.sbox[i][j + 1] = Data2;
				}}
				return true;
			}
			/**
			* Blowfish block cipher algorithm.
			*/
			var Blowfish = C_algo.Blowfish = BlockCipher.extend({
				_doReset: function() {
					if (this._keyPriorReset === this._key) {return;}
					var key = this._keyPriorReset = this._key;
					var keyWords = key.words;
					BlowFishInit(BLOWFISH_CTX, keyWords, key.sigBytes / 4);
				},
				encryptBlock: function(M, offset) {
					var res = BlowFish_Encrypt(BLOWFISH_CTX, M[offset], M[offset + 1]);
					M[offset] = res.left;
					M[offset + 1] = res.right;
				},
				decryptBlock: function(M, offset) {
					var res = BlowFish_Decrypt(BLOWFISH_CTX, M[offset], M[offset + 1]);
					M[offset] = res.left;
					M[offset + 1] = res.right;
				},
				blockSize: 64 / 32,
				keySize: 128 / 32,
				ivSize: 64 / 32
			});
			/**
			* Shortcut functions to the cipher's object interface.
			*
			* @example
			*
			*     var ciphertext = CryptoJS.Blowfish.encrypt(message, key, cfg);
			*     var plaintext  = CryptoJS.Blowfish.decrypt(ciphertext, key, cfg);
			*/
			C.Blowfish = BlockCipher._createHelper(Blowfish);
		})();
		return CryptoJS.Blowfish;
	});
}));
//#endregion
//#region node_modules/.pnpm/pako@2.1.0/node_modules/pako/dist/pako.esm.mjs
var import_crypto_js = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(root, factory, undef) {
		if (typeof exports === "object") {module.exports = exports = factory(require_core(), require_x64_core(), require_lib_typedarrays(), require_enc_utf16(), require_enc_base64(), require_enc_base64url(), require_md5(), require_sha1(), require_sha256(), require_sha224(), require_sha512(), require_sha384(), require_sha3(), require_ripemd160(), require_hmac(), require_pbkdf2(), require_evpkdf(), require_cipher_core(), require_mode_cfb(), require_mode_ctr(), require_mode_ctr_gladman(), require_mode_ofb(), require_mode_ecb(), require_pad_ansix923(), require_pad_iso10126(), require_pad_iso97971(), require_pad_zeropadding(), require_pad_nopadding(), require_format_hex(), require_aes(), require_tripledes(), require_rc4(), require_rabbit(), require_rabbit_legacy(), require_blowfish());}
		else if (typeof define === "function" && define.amd) {define([
			"./core",
			"./x64-core",
			"./lib-typedarrays",
			"./enc-utf16",
			"./enc-base64",
			"./enc-base64url",
			"./md5",
			"./sha1",
			"./sha256",
			"./sha224",
			"./sha512",
			"./sha384",
			"./sha3",
			"./ripemd160",
			"./hmac",
			"./pbkdf2",
			"./evpkdf",
			"./cipher-core",
			"./mode-cfb",
			"./mode-ctr",
			"./mode-ctr-gladman",
			"./mode-ofb",
			"./mode-ecb",
			"./pad-ansix923",
			"./pad-iso10126",
			"./pad-iso97971",
			"./pad-zeropadding",
			"./pad-nopadding",
			"./format-hex",
			"./aes",
			"./tripledes",
			"./rc4",
			"./rabbit",
			"./rabbit-legacy",
			"./blowfish"
		], factory);}
		else {root.CryptoJS = factory(root.CryptoJS);}
	})(exports, function(CryptoJS) {
		return CryptoJS;
	});
})))(), 1);
var import_cookie = /* @__PURE__ */ __toESM(require_cookie(), 1);
/*! pako 2.1.0 https://github.com/nodeca/pako @license (MIT AND Zlib) */
const Z_FIXED$1 = 4;
const Z_BINARY = 0;
const Z_TEXT = 1;
const Z_UNKNOWN$1 = 2;
function zero$1(buf) {
	let len = buf.length;
	while (--len >= 0) {buf[len] = 0;}
}
const STORED_BLOCK = 0;
const STATIC_TREES = 1;
const DYN_TREES = 2;
const MIN_MATCH$1 = 3;
const MAX_MATCH$1 = 258;
const LENGTH_CODES$1 = 29;
const LITERALS$1 = 256;
const L_CODES$1 = LITERALS$1 + 1 + LENGTH_CODES$1;
const D_CODES$1 = 30;
const BL_CODES$1 = 19;
const HEAP_SIZE$1 = 2 * L_CODES$1 + 1;
const MAX_BITS$1 = 15;
const Buf_size = 16;
const MAX_BL_BITS = 7;
const END_BLOCK = 256;
const REP_3_6 = 16;
const REPZ_3_10 = 17;
const REPZ_11_138 = 18;
const extra_lbits = new Uint8Array([
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	1,
	1,
	1,
	1,
	2,
	2,
	2,
	2,
	3,
	3,
	3,
	3,
	4,
	4,
	4,
	4,
	5,
	5,
	5,
	5,
	0
]);
const extra_dbits = new Uint8Array([
	0,
	0,
	0,
	0,
	1,
	1,
	2,
	2,
	3,
	3,
	4,
	4,
	5,
	5,
	6,
	6,
	7,
	7,
	8,
	8,
	9,
	9,
	10,
	10,
	11,
	11,
	12,
	12,
	13,
	13
]);
const extra_blbits = new Uint8Array([
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	2,
	3,
	7
]);
const bl_order = new Uint8Array([
	16,
	17,
	18,
	0,
	8,
	7,
	9,
	6,
	10,
	5,
	11,
	4,
	12,
	3,
	13,
	2,
	14,
	1,
	15
]);
const DIST_CODE_LEN = 512;
const static_ltree = new Array((L_CODES$1 + 2) * 2);
zero$1(static_ltree);
const static_dtree = new Array(D_CODES$1 * 2);
zero$1(static_dtree);
const _dist_code = new Array(DIST_CODE_LEN);
zero$1(_dist_code);
const _length_code = new Array(MAX_MATCH$1 - MIN_MATCH$1 + 1);
zero$1(_length_code);
const base_length = new Array(LENGTH_CODES$1);
zero$1(base_length);
const base_dist = new Array(D_CODES$1);
zero$1(base_dist);
function StaticTreeDesc(static_tree, extra_bits, extra_base, elems, max_length) {
	this.static_tree = static_tree;
	this.extra_bits = extra_bits;
	this.extra_base = extra_base;
	this.elems = elems;
	this.max_length = max_length;
	this.has_stree = static_tree && static_tree.length;
}
let static_l_desc;
let static_d_desc;
let static_bl_desc;
function TreeDesc(dyn_tree, stat_desc) {
	this.dyn_tree = dyn_tree;
	this.max_code = 0;
	this.stat_desc = stat_desc;
}
const d_code = (dist) => {
	return dist < 256 ? _dist_code[dist] : _dist_code[256 + (dist >>> 7)];
};
const put_short = (s, w) => {
	s.pending_buf[s.pending++] = w & 255;
	s.pending_buf[s.pending++] = w >>> 8 & 255;
};
const send_bits = (s, value, length) => {
	if (s.bi_valid > Buf_size - length) {
		s.bi_buf |= value << s.bi_valid & 65535;
		put_short(s, s.bi_buf);
		s.bi_buf = value >> Buf_size - s.bi_valid;
		s.bi_valid += length - Buf_size;
	} else {
		s.bi_buf |= value << s.bi_valid & 65535;
		s.bi_valid += length;
	}
};
const send_code = (s, c, tree) => {
	send_bits(s, tree[c * 2], tree[c * 2 + 1]);
};
const bi_reverse = (code, len) => {
	let res = 0;
	do {
		res |= code & 1;
		code >>>= 1;
		res <<= 1;
	} while (--len > 0);
	return res >>> 1;
};
const bi_flush = (s) => {
	if (s.bi_valid === 16) {
		put_short(s, s.bi_buf);
		s.bi_buf = 0;
		s.bi_valid = 0;
	} else if (s.bi_valid >= 8) {
		s.pending_buf[s.pending++] = s.bi_buf & 255;
		s.bi_buf >>= 8;
		s.bi_valid -= 8;
	}
};
const gen_bitlen = (s, desc) => {
	const tree = desc.dyn_tree;
	const max_code = desc.max_code;
	const stree = desc.stat_desc.static_tree;
	const has_stree = desc.stat_desc.has_stree;
	const extra = desc.stat_desc.extra_bits;
	const base = desc.stat_desc.extra_base;
	const max_length = desc.stat_desc.max_length;
	let h;
	let n, m;
	let bits;
	let xbits;
	let f;
	let overflow = 0;
	for (bits = 0; bits <= MAX_BITS$1; bits++) {s.bl_count[bits] = 0;}
	tree[s.heap[s.heap_max] * 2 + 1] = 0;
	for (h = s.heap_max + 1; h < HEAP_SIZE$1; h++) {
		n = s.heap[h];
		bits = tree[tree[n * 2 + 1] * 2 + 1] + 1;
		if (bits > max_length) {
			bits = max_length;
			overflow++;
		}
		tree[n * 2 + 1] = bits;
		if (n > max_code) {continue;}
		s.bl_count[bits]++;
		xbits = 0;
		if (n >= base) {xbits = extra[n - base];}
		f = tree[n * 2];
		s.opt_len += f * (bits + xbits);
		if (has_stree) {s.static_len += f * (stree[n * 2 + 1] + xbits);}
	}
	if (overflow === 0) {return;}
	do {
		bits = max_length - 1;
		while (s.bl_count[bits] === 0) {bits--;}
		s.bl_count[bits]--;
		s.bl_count[bits + 1] += 2;
		s.bl_count[max_length]--;
		overflow -= 2;
	} while (overflow > 0);
	for (bits = max_length; bits !== 0; bits--) {
		n = s.bl_count[bits];
		while (n !== 0) {
			m = s.heap[--h];
			if (m > max_code) {continue;}
			if (tree[m * 2 + 1] !== bits) {
				s.opt_len += (bits - tree[m * 2 + 1]) * tree[m * 2];
				tree[m * 2 + 1] = bits;
			}
			n--;
		}
	}
};
const gen_codes = (tree, max_code, bl_count) => {
	const next_code = new Array(MAX_BITS$1 + 1);
	let code = 0;
	let bits;
	let n;
	for (bits = 1; bits <= MAX_BITS$1; bits++) {
		code = code + bl_count[bits - 1] << 1;
		next_code[bits] = code;
	}
	for (n = 0; n <= max_code; n++) {
		let len = tree[n * 2 + 1];
		if (len === 0) {continue;}
		tree[n * 2] = bi_reverse(next_code[len]++, len);
	}
};
const tr_static_init = () => {
	let n;
	let bits;
	let length;
	let code;
	let dist;
	const bl_count = new Array(MAX_BITS$1 + 1);
	length = 0;
	for (code = 0; code < LENGTH_CODES$1 - 1; code++) {
		base_length[code] = length;
		for (n = 0; n < 1 << extra_lbits[code]; n++) {_length_code[length++] = code;}
	}
	_length_code[length - 1] = code;
	dist = 0;
	for (code = 0; code < 16; code++) {
		base_dist[code] = dist;
		for (n = 0; n < 1 << extra_dbits[code]; n++) {_dist_code[dist++] = code;}
	}
	dist >>= 7;
	for (; code < D_CODES$1; code++) {
		base_dist[code] = dist << 7;
		for (n = 0; n < 1 << extra_dbits[code] - 7; n++) {_dist_code[256 + dist++] = code;}
	}
	for (bits = 0; bits <= MAX_BITS$1; bits++) {bl_count[bits] = 0;}
	n = 0;
	while (n <= 143) {
		static_ltree[n * 2 + 1] = 8;
		n++;
		bl_count[8]++;
	}
	while (n <= 255) {
		static_ltree[n * 2 + 1] = 9;
		n++;
		bl_count[9]++;
	}
	while (n <= 279) {
		static_ltree[n * 2 + 1] = 7;
		n++;
		bl_count[7]++;
	}
	while (n <= 287) {
		static_ltree[n * 2 + 1] = 8;
		n++;
		bl_count[8]++;
	}
	gen_codes(static_ltree, L_CODES$1 + 1, bl_count);
	for (n = 0; n < D_CODES$1; n++) {
		static_dtree[n * 2 + 1] = 5;
		static_dtree[n * 2] = bi_reverse(n, 5);
	}
	static_l_desc = new StaticTreeDesc(static_ltree, extra_lbits, LITERALS$1 + 1, L_CODES$1, MAX_BITS$1);
	static_d_desc = new StaticTreeDesc(static_dtree, extra_dbits, 0, D_CODES$1, MAX_BITS$1);
	static_bl_desc = new StaticTreeDesc(new Array(0), extra_blbits, 0, BL_CODES$1, MAX_BL_BITS);
};
const init_block = (s) => {
	let n;
	for (n = 0; n < L_CODES$1; n++) {s.dyn_ltree[n * 2] = 0;}
	for (n = 0; n < D_CODES$1; n++) {s.dyn_dtree[n * 2] = 0;}
	for (n = 0; n < BL_CODES$1; n++) {s.bl_tree[n * 2] = 0;}
	s.dyn_ltree[END_BLOCK * 2] = 1;
	s.opt_len = s.static_len = 0;
	s.sym_next = s.matches = 0;
};
const bi_windup = (s) => {
	if (s.bi_valid > 8) {put_short(s, s.bi_buf);}
	else if (s.bi_valid > 0) {s.pending_buf[s.pending++] = s.bi_buf;}
	s.bi_buf = 0;
	s.bi_valid = 0;
};
const smaller = (tree, n, m, depth) => {
	const _n2 = n * 2;
	const _m2 = m * 2;
	return tree[_n2] < tree[_m2] || tree[_n2] === tree[_m2] && depth[n] <= depth[m];
};
const pqdownheap = (s, tree, k) => {
	const v = s.heap[k];
	let j = k << 1;
	while (j <= s.heap_len) {
		if (j < s.heap_len && smaller(tree, s.heap[j + 1], s.heap[j], s.depth)) {j++;}
		if (smaller(tree, v, s.heap[j], s.depth)) {break;}
		s.heap[k] = s.heap[j];
		k = j;
		j <<= 1;
	}
	s.heap[k] = v;
};
const compress_block = (s, ltree, dtree) => {
	let dist;
	let lc;
	let sx = 0;
	let code;
	let extra;
	if (s.sym_next !== 0) {do {
		dist = s.pending_buf[s.sym_buf + sx++] & 255;
		dist += (s.pending_buf[s.sym_buf + sx++] & 255) << 8;
		lc = s.pending_buf[s.sym_buf + sx++];
		if (dist === 0) send_code(s, lc, ltree);
		else {
			code = _length_code[lc];
			send_code(s, code + LITERALS$1 + 1, ltree);
			extra = extra_lbits[code];
			if (extra !== 0) {
				lc -= base_length[code];
				send_bits(s, lc, extra);
			}
			dist--;
			code = d_code(dist);
			send_code(s, code, dtree);
			extra = extra_dbits[code];
			if (extra !== 0) {
				dist -= base_dist[code];
				send_bits(s, dist, extra);
			}
		}
	} while (sx < s.sym_next);}
	send_code(s, END_BLOCK, ltree);
};
const build_tree = (s, desc) => {
	const tree = desc.dyn_tree;
	const stree = desc.stat_desc.static_tree;
	const has_stree = desc.stat_desc.has_stree;
	const elems = desc.stat_desc.elems;
	let n, m;
	let max_code = -1;
	let node;
	s.heap_len = 0;
	s.heap_max = HEAP_SIZE$1;
	for (n = 0; n < elems; n++) {if (tree[n * 2] !== 0) {
		s.heap[++s.heap_len] = max_code = n;
		s.depth[n] = 0;
	} else tree[n * 2 + 1] = 0;}
	while (s.heap_len < 2) {
		node = s.heap[++s.heap_len] = max_code < 2 ? ++max_code : 0;
		tree[node * 2] = 1;
		s.depth[node] = 0;
		s.opt_len--;
		if (has_stree) {s.static_len -= stree[node * 2 + 1];}
	}
	desc.max_code = max_code;
	for (n = s.heap_len >> 1; n >= 1; n--) {pqdownheap(s, tree, n);}
	node = elems;
	do {
		/*** pqremove ***/
		n = s.heap[1];
		s.heap[1] = s.heap[s.heap_len--];
		pqdownheap(s, tree, 1);
		m = s.heap[1];
		s.heap[--s.heap_max] = n;
		s.heap[--s.heap_max] = m;
		tree[node * 2] = tree[n * 2] + tree[m * 2];
		s.depth[node] = (s.depth[n] >= s.depth[m] ? s.depth[n] : s.depth[m]) + 1;
		tree[n * 2 + 1] = tree[m * 2 + 1] = node;
		s.heap[1] = node++;
		pqdownheap(s, tree, 1);
	} while (s.heap_len >= 2);
	s.heap[--s.heap_max] = s.heap[1];
	gen_bitlen(s, desc);
	gen_codes(tree, max_code, s.bl_count);
};
const scan_tree = (s, tree, max_code) => {
	let n;
	let prevlen = -1;
	let curlen;
	let nextlen = tree[1];
	let count = 0;
	let max_count = 7;
	let min_count = 4;
	if (nextlen === 0) {
		max_count = 138;
		min_count = 3;
	}
	tree[(max_code + 1) * 2 + 1] = 65535;
	for (n = 0; n <= max_code; n++) {
		curlen = nextlen;
		nextlen = tree[(n + 1) * 2 + 1];
		if (++count < max_count && curlen === nextlen) {continue;}
		else if (count < min_count) {s.bl_tree[curlen * 2] += count;}
		else if (curlen !== 0) {
			if (curlen !== prevlen) {s.bl_tree[curlen * 2]++;}
			s.bl_tree[REP_3_6 * 2]++;
		} else if (count <= 10) {s.bl_tree[REPZ_3_10 * 2]++;}
		else {s.bl_tree[REPZ_11_138 * 2]++;}
		count = 0;
		prevlen = curlen;
		if (nextlen === 0) {
			max_count = 138;
			min_count = 3;
		} else if (curlen === nextlen) {
			max_count = 6;
			min_count = 3;
		} else {
			max_count = 7;
			min_count = 4;
		}
	}
};
const send_tree = (s, tree, max_code) => {
	let n;
	let prevlen = -1;
	let curlen;
	let nextlen = tree[1];
	let count = 0;
	let max_count = 7;
	let min_count = 4;
	if (nextlen === 0) {
		max_count = 138;
		min_count = 3;
	}
	for (n = 0; n <= max_code; n++) {
		curlen = nextlen;
		nextlen = tree[(n + 1) * 2 + 1];
		if (++count < max_count && curlen === nextlen) {continue;}
		else if (count < min_count) {do
			send_code(s, curlen, s.bl_tree);
		while (--count !== 0);}
		else if (curlen !== 0) {
			if (curlen !== prevlen) {
				send_code(s, curlen, s.bl_tree);
				count--;
			}
			send_code(s, REP_3_6, s.bl_tree);
			send_bits(s, count - 3, 2);
		} else if (count <= 10) {
			send_code(s, REPZ_3_10, s.bl_tree);
			send_bits(s, count - 3, 3);
		} else {
			send_code(s, REPZ_11_138, s.bl_tree);
			send_bits(s, count - 11, 7);
		}
		count = 0;
		prevlen = curlen;
		if (nextlen === 0) {
			max_count = 138;
			min_count = 3;
		} else if (curlen === nextlen) {
			max_count = 6;
			min_count = 3;
		} else {
			max_count = 7;
			min_count = 4;
		}
	}
};
const build_bl_tree = (s) => {
	let max_blindex;
	scan_tree(s, s.dyn_ltree, s.l_desc.max_code);
	scan_tree(s, s.dyn_dtree, s.d_desc.max_code);
	build_tree(s, s.bl_desc);
	for (max_blindex = BL_CODES$1 - 1; max_blindex >= 3; max_blindex--) {if (s.bl_tree[bl_order[max_blindex] * 2 + 1] !== 0) break;}
	s.opt_len += 3 * (max_blindex + 1) + 5 + 5 + 4;
	return max_blindex;
};
const send_all_trees = (s, lcodes, dcodes, blcodes) => {
	let rank;
	send_bits(s, lcodes - 257, 5);
	send_bits(s, dcodes - 1, 5);
	send_bits(s, blcodes - 4, 4);
	for (rank = 0; rank < blcodes; rank++) {send_bits(s, s.bl_tree[bl_order[rank] * 2 + 1], 3);}
	send_tree(s, s.dyn_ltree, lcodes - 1);
	send_tree(s, s.dyn_dtree, dcodes - 1);
};
const detect_data_type = (s) => {
	let block_mask = 4093624447;
	let n;
	for (n = 0; n <= 31; n++, block_mask >>>= 1) {if (block_mask & 1 && s.dyn_ltree[n * 2] !== 0) return Z_BINARY;}
	if (s.dyn_ltree[18] !== 0 || s.dyn_ltree[20] !== 0 || s.dyn_ltree[26] !== 0) {return Z_TEXT;}
	for (n = 32; n < LITERALS$1; n++) {if (s.dyn_ltree[n * 2] !== 0) return Z_TEXT;}
	return Z_BINARY;
};
let static_init_done = false;
const _tr_init$1 = (s) => {
	if (!static_init_done) {
		tr_static_init();
		static_init_done = true;
	}
	s.l_desc = new TreeDesc(s.dyn_ltree, static_l_desc);
	s.d_desc = new TreeDesc(s.dyn_dtree, static_d_desc);
	s.bl_desc = new TreeDesc(s.bl_tree, static_bl_desc);
	s.bi_buf = 0;
	s.bi_valid = 0;
	init_block(s);
};
const _tr_stored_block$1 = (s, buf, stored_len, last) => {
	send_bits(s, (STORED_BLOCK << 1) + (last ? 1 : 0), 3);
	bi_windup(s);
	put_short(s, stored_len);
	put_short(s, ~stored_len);
	if (stored_len) {s.pending_buf.set(s.window.subarray(buf, buf + stored_len), s.pending);}
	s.pending += stored_len;
};
const _tr_align$1 = (s) => {
	send_bits(s, STATIC_TREES << 1, 3);
	send_code(s, END_BLOCK, static_ltree);
	bi_flush(s);
};
const _tr_flush_block$1 = (s, buf, stored_len, last) => {
	let opt_lenb, static_lenb;
	let max_blindex = 0;
	if (s.level > 0) {
		if (s.strm.data_type === Z_UNKNOWN$1) {s.strm.data_type = detect_data_type(s);}
		build_tree(s, s.l_desc);
		build_tree(s, s.d_desc);
		max_blindex = build_bl_tree(s);
		opt_lenb = s.opt_len + 3 + 7 >>> 3;
		static_lenb = s.static_len + 3 + 7 >>> 3;
		if (static_lenb <= opt_lenb) {opt_lenb = static_lenb;}
	} else {opt_lenb = static_lenb = stored_len + 5;}
	if (stored_len + 4 <= opt_lenb && buf !== -1) {_tr_stored_block$1(s, buf, stored_len, last);}
	else if (s.strategy === Z_FIXED$1 || static_lenb === opt_lenb) {
		send_bits(s, (STATIC_TREES << 1) + (last ? 1 : 0), 3);
		compress_block(s, static_ltree, static_dtree);
	} else {
		send_bits(s, (DYN_TREES << 1) + (last ? 1 : 0), 3);
		send_all_trees(s, s.l_desc.max_code + 1, s.d_desc.max_code + 1, max_blindex + 1);
		compress_block(s, s.dyn_ltree, s.dyn_dtree);
	}
	init_block(s);
	if (last) {bi_windup(s);}
};
const _tr_tally$1 = (s, dist, lc) => {
	s.pending_buf[s.sym_buf + s.sym_next++] = dist;
	s.pending_buf[s.sym_buf + s.sym_next++] = dist >> 8;
	s.pending_buf[s.sym_buf + s.sym_next++] = lc;
	if (dist === 0) {s.dyn_ltree[lc * 2]++;}
	else {
		s.matches++;
		dist--;
		s.dyn_ltree[(_length_code[lc] + LITERALS$1 + 1) * 2]++;
		s.dyn_dtree[d_code(dist) * 2]++;
	}
	return s.sym_next === s.sym_end;
};
var trees = {
	_tr_init: _tr_init$1,
	_tr_stored_block: _tr_stored_block$1,
	_tr_flush_block: _tr_flush_block$1,
	_tr_tally: _tr_tally$1,
	_tr_align: _tr_align$1
};
const adler32 = (adler, buf, len, pos) => {
	let s1 = adler & 65535 | 0, s2 = adler >>> 16 & 65535 | 0, n = 0;
	while (len !== 0) {
		n = len > 2e3 ? 2e3 : len;
		len -= n;
		do {
			s1 = s1 + buf[pos++] | 0;
			s2 = s2 + s1 | 0;
		} while (--n);
		s1 %= 65521;
		s2 %= 65521;
	}
	return s1 | s2 << 16 | 0;
};
var adler32_1 = adler32;
const makeTable = () => {
	let c, table = [];
	for (var n = 0; n < 256; n++) {
		c = n;
		for (var k = 0; k < 8; k++) {c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;}
		table[n] = c;
	}
	return table;
};
const crcTable = new Uint32Array(makeTable());
const crc32 = (crc, buf, len, pos) => {
	const t = crcTable;
	const end = pos + len;
	crc ^= -1;
	for (let i = pos; i < end; i++) {crc = crc >>> 8 ^ t[(crc ^ buf[i]) & 255];}
	return crc ^ -1;
};
var crc32_1 = crc32;
var messages = {
	2: "need dictionary",
	1: "stream end",
	0: "",
	"-1": "file error",
	"-2": "stream error",
	"-3": "data error",
	"-4": "insufficient memory",
	"-5": "buffer error",
	"-6": "incompatible version"
};
var constants$2 = {
	Z_NO_FLUSH: 0,
	Z_PARTIAL_FLUSH: 1,
	Z_SYNC_FLUSH: 2,
	Z_FULL_FLUSH: 3,
	Z_FINISH: 4,
	Z_BLOCK: 5,
	Z_TREES: 6,
	Z_OK: 0,
	Z_STREAM_END: 1,
	Z_NEED_DICT: 2,
	Z_ERRNO: -1,
	Z_STREAM_ERROR: -2,
	Z_DATA_ERROR: -3,
	Z_MEM_ERROR: -4,
	Z_BUF_ERROR: -5,
	Z_NO_COMPRESSION: 0,
	Z_BEST_SPEED: 1,
	Z_BEST_COMPRESSION: 9,
	Z_DEFAULT_COMPRESSION: -1,
	Z_FILTERED: 1,
	Z_HUFFMAN_ONLY: 2,
	Z_RLE: 3,
	Z_FIXED: 4,
	Z_DEFAULT_STRATEGY: 0,
	Z_BINARY: 0,
	Z_TEXT: 1,
	Z_UNKNOWN: 2,
	Z_DEFLATED: 8
};
const { _tr_init, _tr_stored_block, _tr_flush_block, _tr_tally, _tr_align } = trees;
const { Z_NO_FLUSH: Z_NO_FLUSH$2, Z_PARTIAL_FLUSH, Z_FULL_FLUSH: Z_FULL_FLUSH$1, Z_FINISH: Z_FINISH$3, Z_BLOCK: Z_BLOCK$1, Z_OK: Z_OK$3, Z_STREAM_END: Z_STREAM_END$3, Z_STREAM_ERROR: Z_STREAM_ERROR$2, Z_DATA_ERROR: Z_DATA_ERROR$2, Z_BUF_ERROR: Z_BUF_ERROR$1, Z_DEFAULT_COMPRESSION: Z_DEFAULT_COMPRESSION$1, Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_DEFAULT_STRATEGY: Z_DEFAULT_STRATEGY$1, Z_UNKNOWN, Z_DEFLATED: Z_DEFLATED$2 } = constants$2;
const MAX_MEM_LEVEL = 9;
const MAX_WBITS$1 = 15;
const DEF_MEM_LEVEL = 8;
const L_CODES = 286;
const D_CODES = 30;
const BL_CODES = 19;
const HEAP_SIZE = 2 * L_CODES + 1;
const MAX_BITS = 15;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const PRESET_DICT = 32;
const INIT_STATE = 42;
const GZIP_STATE = 57;
const EXTRA_STATE = 69;
const NAME_STATE = 73;
const COMMENT_STATE = 91;
const HCRC_STATE = 103;
const BUSY_STATE = 113;
const FINISH_STATE = 666;
const BS_NEED_MORE = 1;
const BS_BLOCK_DONE = 2;
const BS_FINISH_STARTED = 3;
const BS_FINISH_DONE = 4;
const OS_CODE = 3;
const err = (strm, errorCode) => {
	strm.msg = messages[errorCode];
	return errorCode;
};
const rank = (f) => {
	return f * 2 - (f > 4 ? 9 : 0);
};
const zero = (buf) => {
	let len = buf.length;
	while (--len >= 0) {buf[len] = 0;}
};
const slide_hash = (s) => {
	let n, m;
	let p;
	let wsize = s.w_size;
	n = s.hash_size;
	p = n;
	do {
		m = s.head[--p];
		s.head[p] = m >= wsize ? m - wsize : 0;
	} while (--n);
	n = wsize;
	p = n;
	do {
		m = s.prev[--p];
		s.prev[p] = m >= wsize ? m - wsize : 0;
	} while (--n);
};
let HASH_ZLIB = (s, prev, data) => (prev << s.hash_shift ^ data) & s.hash_mask;
let HASH = HASH_ZLIB;
const flush_pending = (strm) => {
	const s = strm.state;
	let len = s.pending;
	if (len > strm.avail_out) {len = strm.avail_out;}
	if (len === 0) {return;}
	strm.output.set(s.pending_buf.subarray(s.pending_out, s.pending_out + len), strm.next_out);
	strm.next_out += len;
	s.pending_out += len;
	strm.total_out += len;
	strm.avail_out -= len;
	s.pending -= len;
	if (s.pending === 0) {s.pending_out = 0;}
};
const flush_block_only = (s, last) => {
	_tr_flush_block(s, s.block_start >= 0 ? s.block_start : -1, s.strstart - s.block_start, last);
	s.block_start = s.strstart;
	flush_pending(s.strm);
};
const put_byte = (s, b) => {
	s.pending_buf[s.pending++] = b;
};
const putShortMSB = (s, b) => {
	s.pending_buf[s.pending++] = b >>> 8 & 255;
	s.pending_buf[s.pending++] = b & 255;
};
const read_buf = (strm, buf, start, size) => {
	let len = strm.avail_in;
	if (len > size) {len = size;}
	if (len === 0) {return 0;}
	strm.avail_in -= len;
	buf.set(strm.input.subarray(strm.next_in, strm.next_in + len), start);
	if (strm.state.wrap === 1) {strm.adler = adler32_1(strm.adler, buf, len, start);}
	else if (strm.state.wrap === 2) {strm.adler = crc32_1(strm.adler, buf, len, start);}
	strm.next_in += len;
	strm.total_in += len;
	return len;
};
const longest_match = (s, cur_match) => {
	let chain_length = s.max_chain_length;
	let scan = s.strstart;
	let match;
	let len;
	let best_len = s.prev_length;
	let nice_match = s.nice_match;
	const limit = s.strstart > s.w_size - MIN_LOOKAHEAD ? s.strstart - (s.w_size - MIN_LOOKAHEAD) : 0;
	const _win = s.window;
	const wmask = s.w_mask;
	const prev = s.prev;
	const strend = s.strstart + MAX_MATCH;
	let scan_end1 = _win[scan + best_len - 1];
	let scan_end = _win[scan + best_len];
	if (s.prev_length >= s.good_match) {chain_length >>= 2;}
	if (nice_match > s.lookahead) {nice_match = s.lookahead;}
	do {
		match = cur_match;
		if (_win[match + best_len] !== scan_end || _win[match + best_len - 1] !== scan_end1 || _win[match] !== _win[scan] || _win[++match] !== _win[scan + 1]) {continue;}
		scan += 2;
		match++;
		do		{;}
while (_win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && scan < strend);
		len = MAX_MATCH - (strend - scan);
		scan = strend - MAX_MATCH;
		if (len > best_len) {
			s.match_start = cur_match;
			best_len = len;
			if (len >= nice_match) {break;}
			scan_end1 = _win[scan + best_len - 1];
			scan_end = _win[scan + best_len];
		}
	} while ((cur_match = prev[cur_match & wmask]) > limit && --chain_length !== 0);
	if (best_len <= s.lookahead) {return best_len;}
	return s.lookahead;
};
const fill_window = (s) => {
	const _w_size = s.w_size;
	let n, more, str;
	do {
		more = s.window_size - s.lookahead - s.strstart;
		if (s.strstart >= _w_size + (_w_size - MIN_LOOKAHEAD)) {
			s.window.set(s.window.subarray(_w_size, _w_size + _w_size - more), 0);
			s.match_start -= _w_size;
			s.strstart -= _w_size;
			s.block_start -= _w_size;
			if (s.insert > s.strstart) {s.insert = s.strstart;}
			slide_hash(s);
			more += _w_size;
		}
		if (s.strm.avail_in === 0) {break;}
		n = read_buf(s.strm, s.window, s.strstart + s.lookahead, more);
		s.lookahead += n;
		if (s.lookahead + s.insert >= MIN_MATCH) {
			str = s.strstart - s.insert;
			s.ins_h = s.window[str];
			s.ins_h = HASH(s, s.ins_h, s.window[str + 1]);
			while (s.insert) {
				s.ins_h = HASH(s, s.ins_h, s.window[str + MIN_MATCH - 1]);
				s.prev[str & s.w_mask] = s.head[s.ins_h];
				s.head[s.ins_h] = str;
				str++;
				s.insert--;
				if (s.lookahead + s.insert < MIN_MATCH) {break;}
			}
		}
	} while (s.lookahead < MIN_LOOKAHEAD && s.strm.avail_in !== 0);
};
const deflate_stored = (s, flush) => {
	let min_block = s.pending_buf_size - 5 > s.w_size ? s.w_size : s.pending_buf_size - 5;
	let len, left, have, last = 0;
	let used = s.strm.avail_in;
	do {
		len = 65535;
		have = s.bi_valid + 42 >> 3;
		if (s.strm.avail_out < have) {break;}
		have = s.strm.avail_out - have;
		left = s.strstart - s.block_start;
		if (len > left + s.strm.avail_in) {len = left + s.strm.avail_in;}
		if (len > have) {len = have;}
		if (len < min_block && (len === 0 && flush !== Z_FINISH$3 || flush === Z_NO_FLUSH$2 || len !== left + s.strm.avail_in)) {break;}
		last = flush === Z_FINISH$3 && len === left + s.strm.avail_in ? 1 : 0;
		_tr_stored_block(s, 0, 0, last);
		s.pending_buf[s.pending - 4] = len;
		s.pending_buf[s.pending - 3] = len >> 8;
		s.pending_buf[s.pending - 2] = ~len;
		s.pending_buf[s.pending - 1] = ~len >> 8;
		flush_pending(s.strm);
		if (left) {
			if (left > len) {left = len;}
			s.strm.output.set(s.window.subarray(s.block_start, s.block_start + left), s.strm.next_out);
			s.strm.next_out += left;
			s.strm.avail_out -= left;
			s.strm.total_out += left;
			s.block_start += left;
			len -= left;
		}
		if (len) {
			read_buf(s.strm, s.strm.output, s.strm.next_out, len);
			s.strm.next_out += len;
			s.strm.avail_out -= len;
			s.strm.total_out += len;
		}
	} while (last === 0);
	used -= s.strm.avail_in;
	if (used) {
		if (used >= s.w_size) {
			s.matches = 2;
			s.window.set(s.strm.input.subarray(s.strm.next_in - s.w_size, s.strm.next_in), 0);
			s.strstart = s.w_size;
			s.insert = s.strstart;
		} else {
			if (s.window_size - s.strstart <= used) {
				s.strstart -= s.w_size;
				s.window.set(s.window.subarray(s.w_size, s.w_size + s.strstart), 0);
				if (s.matches < 2) {s.matches++;}
				if (s.insert > s.strstart) {s.insert = s.strstart;}
			}
			s.window.set(s.strm.input.subarray(s.strm.next_in - used, s.strm.next_in), s.strstart);
			s.strstart += used;
			s.insert += used > s.w_size - s.insert ? s.w_size - s.insert : used;
		}
		s.block_start = s.strstart;
	}
	if (s.high_water < s.strstart) {s.high_water = s.strstart;}
	if (last) {return BS_FINISH_DONE;}
	if (flush !== Z_NO_FLUSH$2 && flush !== Z_FINISH$3 && s.strm.avail_in === 0 && s.strstart === s.block_start) {return BS_BLOCK_DONE;}
	have = s.window_size - s.strstart;
	if (s.strm.avail_in > have && s.block_start >= s.w_size) {
		s.block_start -= s.w_size;
		s.strstart -= s.w_size;
		s.window.set(s.window.subarray(s.w_size, s.w_size + s.strstart), 0);
		if (s.matches < 2) {s.matches++;}
		have += s.w_size;
		if (s.insert > s.strstart) {s.insert = s.strstart;}
	}
	if (have > s.strm.avail_in) {have = s.strm.avail_in;}
	if (have) {
		read_buf(s.strm, s.window, s.strstart, have);
		s.strstart += have;
		s.insert += have > s.w_size - s.insert ? s.w_size - s.insert : have;
	}
	if (s.high_water < s.strstart) {s.high_water = s.strstart;}
	have = s.bi_valid + 42 >> 3;
	have = s.pending_buf_size - have > 65535 ? 65535 : s.pending_buf_size - have;
	min_block = have > s.w_size ? s.w_size : have;
	left = s.strstart - s.block_start;
	if (left >= min_block || (left || flush === Z_FINISH$3) && flush !== Z_NO_FLUSH$2 && s.strm.avail_in === 0 && left <= have) {
		len = left > have ? have : left;
		last = flush === Z_FINISH$3 && s.strm.avail_in === 0 && len === left ? 1 : 0;
		_tr_stored_block(s, s.block_start, len, last);
		s.block_start += len;
		flush_pending(s.strm);
	}
	return last ? BS_FINISH_STARTED : BS_NEED_MORE;
};
const deflate_fast = (s, flush) => {
	let hash_head;
	let bflush;
	for (;;) {
		if (s.lookahead < MIN_LOOKAHEAD) {
			fill_window(s);
			if (s.lookahead < MIN_LOOKAHEAD && flush === Z_NO_FLUSH$2) {return BS_NEED_MORE;}
			if (s.lookahead === 0) {break;}
		}
		hash_head = 0;
		if (s.lookahead >= MIN_MATCH) {
			/*** INSERT_STRING(s, s.strstart, hash_head); ***/
			s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + MIN_MATCH - 1]);
			hash_head = s.prev[s.strstart & s.w_mask] = s.head[s.ins_h];
			s.head[s.ins_h] = s.strstart;
		}
		if (hash_head !== 0 && s.strstart - hash_head <= s.w_size - MIN_LOOKAHEAD) {s.match_length = longest_match(s, hash_head);}
		if (s.match_length >= MIN_MATCH) {
			/*** _tr_tally_dist(s, s.strstart - s.match_start,
			s.match_length - MIN_MATCH, bflush); ***/
			bflush = _tr_tally(s, s.strstart - s.match_start, s.match_length - MIN_MATCH);
			s.lookahead -= s.match_length;
			if (s.match_length <= s.max_lazy_match && s.lookahead >= MIN_MATCH) {
				s.match_length--;
				do {
					s.strstart++;
					/*** INSERT_STRING(s, s.strstart, hash_head); ***/
					s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + MIN_MATCH - 1]);
					hash_head = s.prev[s.strstart & s.w_mask] = s.head[s.ins_h];
					s.head[s.ins_h] = s.strstart;
				} while (--s.match_length !== 0);
				s.strstart++;
			} else {
				s.strstart += s.match_length;
				s.match_length = 0;
				s.ins_h = s.window[s.strstart];
				s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + 1]);
			}
		} else {
			/*** _tr_tally_lit(s, s.window[s.strstart], bflush); ***/
			bflush = _tr_tally(s, 0, s.window[s.strstart]);
			s.lookahead--;
			s.strstart++;
		}
		if (bflush) {
			/*** FLUSH_BLOCK(s, 0); ***/
			flush_block_only(s, false);
			if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
		}
	}
	s.insert = s.strstart < MIN_MATCH - 1 ? s.strstart : MIN_MATCH - 1;
	if (flush === Z_FINISH$3) {
		/*** FLUSH_BLOCK(s, 1); ***/
		flush_block_only(s, true);
		if (s.strm.avail_out === 0) {return BS_FINISH_STARTED;}
		return BS_FINISH_DONE;
	}
	if (s.sym_next) {
		/*** FLUSH_BLOCK(s, 0); ***/
		flush_block_only(s, false);
		if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
	}
	return BS_BLOCK_DONE;
};
const deflate_slow = (s, flush) => {
	let hash_head;
	let bflush;
	let max_insert;
	for (;;) {
		if (s.lookahead < MIN_LOOKAHEAD) {
			fill_window(s);
			if (s.lookahead < MIN_LOOKAHEAD && flush === Z_NO_FLUSH$2) {return BS_NEED_MORE;}
			if (s.lookahead === 0) {break;}
		}
		hash_head = 0;
		if (s.lookahead >= MIN_MATCH) {
			/*** INSERT_STRING(s, s.strstart, hash_head); ***/
			s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + MIN_MATCH - 1]);
			hash_head = s.prev[s.strstart & s.w_mask] = s.head[s.ins_h];
			s.head[s.ins_h] = s.strstart;
		}
		s.prev_length = s.match_length;
		s.prev_match = s.match_start;
		s.match_length = MIN_MATCH - 1;
		if (hash_head !== 0 && s.prev_length < s.max_lazy_match && s.strstart - hash_head <= s.w_size - MIN_LOOKAHEAD) {
			s.match_length = longest_match(s, hash_head);
			if (s.match_length <= 5 && (s.strategy === Z_FILTERED || s.match_length === MIN_MATCH && s.strstart - s.match_start > 4096)) {s.match_length = MIN_MATCH - 1;}
		}
		if (s.prev_length >= MIN_MATCH && s.match_length <= s.prev_length) {
			max_insert = s.strstart + s.lookahead - MIN_MATCH;
			/***_tr_tally_dist(s, s.strstart - 1 - s.prev_match,
			s.prev_length - MIN_MATCH, bflush);***/
			bflush = _tr_tally(s, s.strstart - 1 - s.prev_match, s.prev_length - MIN_MATCH);
			s.lookahead -= s.prev_length - 1;
			s.prev_length -= 2;
			do
				{if (++s.strstart <= max_insert) {
					/*** INSERT_STRING(s, s.strstart, hash_head); ***/
					s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + MIN_MATCH - 1]);
					hash_head = s.prev[s.strstart & s.w_mask] = s.head[s.ins_h];
					s.head[s.ins_h] = s.strstart;
				}}
			while (--s.prev_length !== 0);
			s.match_available = 0;
			s.match_length = MIN_MATCH - 1;
			s.strstart++;
			if (bflush) {
				/*** FLUSH_BLOCK(s, 0); ***/
				flush_block_only(s, false);
				if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
			}
		} else if (s.match_available) {
			/*** _tr_tally_lit(s, s.window[s.strstart-1], bflush); ***/
			bflush = _tr_tally(s, 0, s.window[s.strstart - 1]);
			if (bflush)
 /*** FLUSH_BLOCK_ONLY(s, 0) ***/
			{flush_block_only(s, false);}
			s.strstart++;
			s.lookahead--;
			if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
		} else {
			s.match_available = 1;
			s.strstart++;
			s.lookahead--;
		}
	}
	if (s.match_available) {
		/*** _tr_tally_lit(s, s.window[s.strstart-1], bflush); ***/
		bflush = _tr_tally(s, 0, s.window[s.strstart - 1]);
		s.match_available = 0;
	}
	s.insert = s.strstart < MIN_MATCH - 1 ? s.strstart : MIN_MATCH - 1;
	if (flush === Z_FINISH$3) {
		/*** FLUSH_BLOCK(s, 1); ***/
		flush_block_only(s, true);
		if (s.strm.avail_out === 0) {return BS_FINISH_STARTED;}
		return BS_FINISH_DONE;
	}
	if (s.sym_next) {
		/*** FLUSH_BLOCK(s, 0); ***/
		flush_block_only(s, false);
		if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
	}
	return BS_BLOCK_DONE;
};
const deflate_rle = (s, flush) => {
	let bflush;
	let prev;
	let scan, strend;
	const _win = s.window;
	for (;;) {
		if (s.lookahead <= MAX_MATCH) {
			fill_window(s);
			if (s.lookahead <= MAX_MATCH && flush === Z_NO_FLUSH$2) {return BS_NEED_MORE;}
			if (s.lookahead === 0) {break;}
		}
		s.match_length = 0;
		if (s.lookahead >= MIN_MATCH && s.strstart > 0) {
			scan = s.strstart - 1;
			prev = _win[scan];
			if (prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan]) {
				strend = s.strstart + MAX_MATCH;
				do				{;}
while (prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && scan < strend);
				s.match_length = MAX_MATCH - (strend - scan);
				if (s.match_length > s.lookahead) {s.match_length = s.lookahead;}
			}
		}
		if (s.match_length >= MIN_MATCH) {
			/*** _tr_tally_dist(s, 1, s.match_length - MIN_MATCH, bflush); ***/
			bflush = _tr_tally(s, 1, s.match_length - MIN_MATCH);
			s.lookahead -= s.match_length;
			s.strstart += s.match_length;
			s.match_length = 0;
		} else {
			/*** _tr_tally_lit(s, s.window[s.strstart], bflush); ***/
			bflush = _tr_tally(s, 0, s.window[s.strstart]);
			s.lookahead--;
			s.strstart++;
		}
		if (bflush) {
			/*** FLUSH_BLOCK(s, 0); ***/
			flush_block_only(s, false);
			if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
		}
	}
	s.insert = 0;
	if (flush === Z_FINISH$3) {
		/*** FLUSH_BLOCK(s, 1); ***/
		flush_block_only(s, true);
		if (s.strm.avail_out === 0) {return BS_FINISH_STARTED;}
		return BS_FINISH_DONE;
	}
	if (s.sym_next) {
		/*** FLUSH_BLOCK(s, 0); ***/
		flush_block_only(s, false);
		if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
	}
	return BS_BLOCK_DONE;
};
const deflate_huff = (s, flush) => {
	let bflush;
	for (;;) {
		if (s.lookahead === 0) {
			fill_window(s);
			if (s.lookahead === 0) {
				if (flush === Z_NO_FLUSH$2) {return BS_NEED_MORE;}
				break;
			}
		}
		s.match_length = 0;
		/*** _tr_tally_lit(s, s.window[s.strstart], bflush); ***/
		bflush = _tr_tally(s, 0, s.window[s.strstart]);
		s.lookahead--;
		s.strstart++;
		if (bflush) {
			/*** FLUSH_BLOCK(s, 0); ***/
			flush_block_only(s, false);
			if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
		}
	}
	s.insert = 0;
	if (flush === Z_FINISH$3) {
		/*** FLUSH_BLOCK(s, 1); ***/
		flush_block_only(s, true);
		if (s.strm.avail_out === 0) {return BS_FINISH_STARTED;}
		return BS_FINISH_DONE;
	}
	if (s.sym_next) {
		/*** FLUSH_BLOCK(s, 0); ***/
		flush_block_only(s, false);
		if (s.strm.avail_out === 0) {return BS_NEED_MORE;}
	}
	return BS_BLOCK_DONE;
};
function Config(good_length, max_lazy, nice_length, max_chain, func) {
	this.good_length = good_length;
	this.max_lazy = max_lazy;
	this.nice_length = nice_length;
	this.max_chain = max_chain;
	this.func = func;
}
const configuration_table = [
	new Config(0, 0, 0, 0, deflate_stored),
	new Config(4, 4, 8, 4, deflate_fast),
	new Config(4, 5, 16, 8, deflate_fast),
	new Config(4, 6, 32, 32, deflate_fast),
	new Config(4, 4, 16, 16, deflate_slow),
	new Config(8, 16, 32, 32, deflate_slow),
	new Config(8, 16, 128, 128, deflate_slow),
	new Config(8, 32, 128, 256, deflate_slow),
	new Config(32, 128, 258, 1024, deflate_slow),
	new Config(32, 258, 258, 4096, deflate_slow)
];
const lm_init = (s) => {
	s.window_size = 2 * s.w_size;
	/*** CLEAR_HASH(s); ***/
	zero(s.head);
	s.max_lazy_match = configuration_table[s.level].max_lazy;
	s.good_match = configuration_table[s.level].good_length;
	s.nice_match = configuration_table[s.level].nice_length;
	s.max_chain_length = configuration_table[s.level].max_chain;
	s.strstart = 0;
	s.block_start = 0;
	s.lookahead = 0;
	s.insert = 0;
	s.match_length = s.prev_length = MIN_MATCH - 1;
	s.match_available = 0;
	s.ins_h = 0;
};
function DeflateState() {
	this.strm = null;
	this.status = 0;
	this.pending_buf = null;
	this.pending_buf_size = 0;
	this.pending_out = 0;
	this.pending = 0;
	this.wrap = 0;
	this.gzhead = null;
	this.gzindex = 0;
	this.method = Z_DEFLATED$2;
	this.last_flush = -1;
	this.w_size = 0;
	this.w_bits = 0;
	this.w_mask = 0;
	this.window = null;
	this.window_size = 0;
	this.prev = null;
	this.head = null;
	this.ins_h = 0;
	this.hash_size = 0;
	this.hash_bits = 0;
	this.hash_mask = 0;
	this.hash_shift = 0;
	this.block_start = 0;
	this.match_length = 0;
	this.prev_match = 0;
	this.match_available = 0;
	this.strstart = 0;
	this.match_start = 0;
	this.lookahead = 0;
	this.prev_length = 0;
	this.max_chain_length = 0;
	this.max_lazy_match = 0;
	this.level = 0;
	this.strategy = 0;
	this.good_match = 0;
	this.nice_match = 0;
	this.dyn_ltree = new Uint16Array(HEAP_SIZE * 2);
	this.dyn_dtree = new Uint16Array((2 * D_CODES + 1) * 2);
	this.bl_tree = new Uint16Array((2 * BL_CODES + 1) * 2);
	zero(this.dyn_ltree);
	zero(this.dyn_dtree);
	zero(this.bl_tree);
	this.l_desc = null;
	this.d_desc = null;
	this.bl_desc = null;
	this.bl_count = new Uint16Array(MAX_BITS + 1);
	this.heap = new Uint16Array(2 * L_CODES + 1);
	zero(this.heap);
	this.heap_len = 0;
	this.heap_max = 0;
	this.depth = new Uint16Array(2 * L_CODES + 1);
	zero(this.depth);
	this.sym_buf = 0;
	this.lit_bufsize = 0;
	this.sym_next = 0;
	this.sym_end = 0;
	this.opt_len = 0;
	this.static_len = 0;
	this.matches = 0;
	this.insert = 0;
	this.bi_buf = 0;
	this.bi_valid = 0;
}
const deflateStateCheck = (strm) => {
	if (!strm) {return 1;}
	const s = strm.state;
	if (!s || s.strm !== strm || s.status !== INIT_STATE && s.status !== GZIP_STATE && s.status !== EXTRA_STATE && s.status !== NAME_STATE && s.status !== COMMENT_STATE && s.status !== HCRC_STATE && s.status !== BUSY_STATE && s.status !== FINISH_STATE) {return 1;}
	return 0;
};
const deflateResetKeep = (strm) => {
	if (deflateStateCheck(strm)) {return err(strm, Z_STREAM_ERROR$2);}
	strm.total_in = strm.total_out = 0;
	strm.data_type = Z_UNKNOWN;
	const s = strm.state;
	s.pending = 0;
	s.pending_out = 0;
	if (s.wrap < 0) {s.wrap = -s.wrap;}
	s.status = s.wrap === 2 ? GZIP_STATE : s.wrap ? INIT_STATE : BUSY_STATE;
	strm.adler = s.wrap === 2 ? 0 : 1;
	s.last_flush = -2;
	_tr_init(s);
	return Z_OK$3;
};
const deflateReset = (strm) => {
	const ret = deflateResetKeep(strm);
	if (ret === Z_OK$3) {lm_init(strm.state);}
	return ret;
};
const deflateSetHeader = (strm, head) => {
	if (deflateStateCheck(strm) || strm.state.wrap !== 2) {return Z_STREAM_ERROR$2;}
	strm.state.gzhead = head;
	return Z_OK$3;
};
const deflateInit2 = (strm, level, method, windowBits, memLevel, strategy) => {
	if (!strm) {return Z_STREAM_ERROR$2;}
	let wrap = 1;
	if (level === Z_DEFAULT_COMPRESSION$1) {level = 6;}
	if (windowBits < 0) {
		wrap = 0;
		windowBits = -windowBits;
	} else if (windowBits > 15) {
		wrap = 2;
		windowBits -= 16;
	}
	if (memLevel < 1 || memLevel > MAX_MEM_LEVEL || method !== Z_DEFLATED$2 || windowBits < 8 || windowBits > 15 || level < 0 || level > 9 || strategy < 0 || strategy > Z_FIXED || windowBits === 8 && wrap !== 1) {return err(strm, Z_STREAM_ERROR$2);}
	if (windowBits === 8) {windowBits = 9;}
	const s = new DeflateState();
	strm.state = s;
	s.strm = strm;
	s.status = INIT_STATE;
	s.wrap = wrap;
	s.gzhead = null;
	s.w_bits = windowBits;
	s.w_size = 1 << s.w_bits;
	s.w_mask = s.w_size - 1;
	s.hash_bits = memLevel + 7;
	s.hash_size = 1 << s.hash_bits;
	s.hash_mask = s.hash_size - 1;
	s.hash_shift = ~~((s.hash_bits + MIN_MATCH - 1) / MIN_MATCH);
	s.window = new Uint8Array(s.w_size * 2);
	s.head = new Uint16Array(s.hash_size);
	s.prev = new Uint16Array(s.w_size);
	s.lit_bufsize = 1 << memLevel + 6;
	s.pending_buf_size = s.lit_bufsize * 4;
	s.pending_buf = new Uint8Array(s.pending_buf_size);
	s.sym_buf = s.lit_bufsize;
	s.sym_end = (s.lit_bufsize - 1) * 3;
	s.level = level;
	s.strategy = strategy;
	s.method = method;
	return deflateReset(strm);
};
const deflateInit = (strm, level) => {
	return deflateInit2(strm, level, Z_DEFLATED$2, MAX_WBITS$1, DEF_MEM_LEVEL, Z_DEFAULT_STRATEGY$1);
};
const deflate$2 = (strm, flush) => {
	if (deflateStateCheck(strm) || flush > Z_BLOCK$1 || flush < 0) {return strm ? err(strm, Z_STREAM_ERROR$2) : Z_STREAM_ERROR$2;}
	const s = strm.state;
	if (!strm.output || strm.avail_in !== 0 && !strm.input || s.status === FINISH_STATE && flush !== Z_FINISH$3) {return err(strm, strm.avail_out === 0 ? Z_BUF_ERROR$1 : Z_STREAM_ERROR$2);}
	const old_flush = s.last_flush;
	s.last_flush = flush;
	if (s.pending !== 0) {
		flush_pending(strm);
		if (strm.avail_out === 0) {
			s.last_flush = -1;
			return Z_OK$3;
		}
	} else if (strm.avail_in === 0 && rank(flush) <= rank(old_flush) && flush !== Z_FINISH$3) {return err(strm, Z_BUF_ERROR$1);}
	if (s.status === FINISH_STATE && strm.avail_in !== 0) {return err(strm, Z_BUF_ERROR$1);}
	if (s.status === INIT_STATE && s.wrap === 0) {s.status = BUSY_STATE;}
	if (s.status === INIT_STATE) {
		let header = Z_DEFLATED$2 + (s.w_bits - 8 << 4) << 8;
		let level_flags = -1;
		if (s.strategy >= Z_HUFFMAN_ONLY || s.level < 2) {level_flags = 0;}
		else if (s.level < 6) {level_flags = 1;}
		else if (s.level === 6) {level_flags = 2;}
		else {level_flags = 3;}
		header |= level_flags << 6;
		if (s.strstart !== 0) {header |= PRESET_DICT;}
		header += 31 - header % 31;
		putShortMSB(s, header);
		if (s.strstart !== 0) {
			putShortMSB(s, strm.adler >>> 16);
			putShortMSB(s, strm.adler & 65535);
		}
		strm.adler = 1;
		s.status = BUSY_STATE;
		flush_pending(strm);
		if (s.pending !== 0) {
			s.last_flush = -1;
			return Z_OK$3;
		}
	}
	if (s.status === GZIP_STATE) {
		strm.adler = 0;
		put_byte(s, 31);
		put_byte(s, 139);
		put_byte(s, 8);
		if (!s.gzhead) {
			put_byte(s, 0);
			put_byte(s, 0);
			put_byte(s, 0);
			put_byte(s, 0);
			put_byte(s, 0);
			put_byte(s, s.level === 9 ? 2 : s.strategy >= Z_HUFFMAN_ONLY || s.level < 2 ? 4 : 0);
			put_byte(s, OS_CODE);
			s.status = BUSY_STATE;
			flush_pending(strm);
			if (s.pending !== 0) {
				s.last_flush = -1;
				return Z_OK$3;
			}
		} else {
			put_byte(s, (s.gzhead.text ? 1 : 0) + (s.gzhead.hcrc ? 2 : 0) + (!s.gzhead.extra ? 0 : 4) + (!s.gzhead.name ? 0 : 8) + (!s.gzhead.comment ? 0 : 16));
			put_byte(s, s.gzhead.time & 255);
			put_byte(s, s.gzhead.time >> 8 & 255);
			put_byte(s, s.gzhead.time >> 16 & 255);
			put_byte(s, s.gzhead.time >> 24 & 255);
			put_byte(s, s.level === 9 ? 2 : s.strategy >= Z_HUFFMAN_ONLY || s.level < 2 ? 4 : 0);
			put_byte(s, s.gzhead.os & 255);
			if (s.gzhead.extra && s.gzhead.extra.length) {
				put_byte(s, s.gzhead.extra.length & 255);
				put_byte(s, s.gzhead.extra.length >> 8 & 255);
			}
			if (s.gzhead.hcrc) {strm.adler = crc32_1(strm.adler, s.pending_buf, s.pending, 0);}
			s.gzindex = 0;
			s.status = EXTRA_STATE;
		}
	}
	if (s.status === EXTRA_STATE) {
		if (s.gzhead.extra) {
			let beg = s.pending;
			let left = (s.gzhead.extra.length & 65535) - s.gzindex;
			while (s.pending + left > s.pending_buf_size) {
				let copy = s.pending_buf_size - s.pending;
				s.pending_buf.set(s.gzhead.extra.subarray(s.gzindex, s.gzindex + copy), s.pending);
				s.pending = s.pending_buf_size;
				if (s.gzhead.hcrc && s.pending > beg) {strm.adler = crc32_1(strm.adler, s.pending_buf, s.pending - beg, beg);}
				s.gzindex += copy;
				flush_pending(strm);
				if (s.pending !== 0) {
					s.last_flush = -1;
					return Z_OK$3;
				}
				beg = 0;
				left -= copy;
			}
			let gzhead_extra = new Uint8Array(s.gzhead.extra);
			s.pending_buf.set(gzhead_extra.subarray(s.gzindex, s.gzindex + left), s.pending);
			s.pending += left;
			if (s.gzhead.hcrc && s.pending > beg) {strm.adler = crc32_1(strm.adler, s.pending_buf, s.pending - beg, beg);}
			s.gzindex = 0;
		}
		s.status = NAME_STATE;
	}
	if (s.status === NAME_STATE) {
		if (s.gzhead.name) {
			let beg = s.pending;
			let val;
			do {
				if (s.pending === s.pending_buf_size) {
					if (s.gzhead.hcrc && s.pending > beg) {strm.adler = crc32_1(strm.adler, s.pending_buf, s.pending - beg, beg);}
					flush_pending(strm);
					if (s.pending !== 0) {
						s.last_flush = -1;
						return Z_OK$3;
					}
					beg = 0;
				}
				if (s.gzindex < s.gzhead.name.length) {val = s.gzhead.name.charCodeAt(s.gzindex++) & 255;}
				else {val = 0;}
				put_byte(s, val);
			} while (val !== 0);
			if (s.gzhead.hcrc && s.pending > beg) {strm.adler = crc32_1(strm.adler, s.pending_buf, s.pending - beg, beg);}
			s.gzindex = 0;
		}
		s.status = COMMENT_STATE;
	}
	if (s.status === COMMENT_STATE) {
		if (s.gzhead.comment) {
			let beg = s.pending;
			let val;
			do {
				if (s.pending === s.pending_buf_size) {
					if (s.gzhead.hcrc && s.pending > beg) {strm.adler = crc32_1(strm.adler, s.pending_buf, s.pending - beg, beg);}
					flush_pending(strm);
					if (s.pending !== 0) {
						s.last_flush = -1;
						return Z_OK$3;
					}
					beg = 0;
				}
				if (s.gzindex < s.gzhead.comment.length) {val = s.gzhead.comment.charCodeAt(s.gzindex++) & 255;}
				else {val = 0;}
				put_byte(s, val);
			} while (val !== 0);
			if (s.gzhead.hcrc && s.pending > beg) {strm.adler = crc32_1(strm.adler, s.pending_buf, s.pending - beg, beg);}
		}
		s.status = HCRC_STATE;
	}
	if (s.status === HCRC_STATE) {
		if (s.gzhead.hcrc) {
			if (s.pending + 2 > s.pending_buf_size) {
				flush_pending(strm);
				if (s.pending !== 0) {
					s.last_flush = -1;
					return Z_OK$3;
				}
			}
			put_byte(s, strm.adler & 255);
			put_byte(s, strm.adler >> 8 & 255);
			strm.adler = 0;
		}
		s.status = BUSY_STATE;
		flush_pending(strm);
		if (s.pending !== 0) {
			s.last_flush = -1;
			return Z_OK$3;
		}
	}
	if (strm.avail_in !== 0 || s.lookahead !== 0 || flush !== Z_NO_FLUSH$2 && s.status !== FINISH_STATE) {
		let bstate = s.level === 0 ? deflate_stored(s, flush) : s.strategy === Z_HUFFMAN_ONLY ? deflate_huff(s, flush) : s.strategy === Z_RLE ? deflate_rle(s, flush) : configuration_table[s.level].func(s, flush);
		if (bstate === BS_FINISH_STARTED || bstate === BS_FINISH_DONE) {s.status = FINISH_STATE;}
		if (bstate === BS_NEED_MORE || bstate === BS_FINISH_STARTED) {
			if (strm.avail_out === 0) {s.last_flush = -1;}
			return Z_OK$3;
		}
		if (bstate === BS_BLOCK_DONE) {
			if (flush === Z_PARTIAL_FLUSH) {_tr_align(s);}
			else if (flush !== Z_BLOCK$1) {
				_tr_stored_block(s, 0, 0, false);
				if (flush === Z_FULL_FLUSH$1) {
					/*** CLEAR_HASH(s); ***/ zero(s.head);
					if (s.lookahead === 0) {
						s.strstart = 0;
						s.block_start = 0;
						s.insert = 0;
					}
				}
			}
			flush_pending(strm);
			if (strm.avail_out === 0) {
				s.last_flush = -1;
				return Z_OK$3;
			}
		}
	}
	if (flush !== Z_FINISH$3) {return Z_OK$3;}
	if (s.wrap <= 0) {return Z_STREAM_END$3;}
	if (s.wrap === 2) {
		put_byte(s, strm.adler & 255);
		put_byte(s, strm.adler >> 8 & 255);
		put_byte(s, strm.adler >> 16 & 255);
		put_byte(s, strm.adler >> 24 & 255);
		put_byte(s, strm.total_in & 255);
		put_byte(s, strm.total_in >> 8 & 255);
		put_byte(s, strm.total_in >> 16 & 255);
		put_byte(s, strm.total_in >> 24 & 255);
	} else {
		putShortMSB(s, strm.adler >>> 16);
		putShortMSB(s, strm.adler & 65535);
	}
	flush_pending(strm);
	if (s.wrap > 0) {s.wrap = -s.wrap;}
	return s.pending !== 0 ? Z_OK$3 : Z_STREAM_END$3;
};
const deflateEnd = (strm) => {
	if (deflateStateCheck(strm)) {return Z_STREAM_ERROR$2;}
	const status = strm.state.status;
	strm.state = null;
	return status === BUSY_STATE ? err(strm, Z_DATA_ERROR$2) : Z_OK$3;
};
const deflateSetDictionary = (strm, dictionary) => {
	let dictLength = dictionary.length;
	if (deflateStateCheck(strm)) {return Z_STREAM_ERROR$2;}
	const s = strm.state;
	const wrap = s.wrap;
	if (wrap === 2 || wrap === 1 && s.status !== INIT_STATE || s.lookahead) {return Z_STREAM_ERROR$2;}
	if (wrap === 1) {strm.adler = adler32_1(strm.adler, dictionary, dictLength, 0);}
	s.wrap = 0;
	if (dictLength >= s.w_size) {
		if (wrap === 0) {
			/*** CLEAR_HASH(s); ***/
			zero(s.head);
			s.strstart = 0;
			s.block_start = 0;
			s.insert = 0;
		}
		let tmpDict = new Uint8Array(s.w_size);
		tmpDict.set(dictionary.subarray(dictLength - s.w_size, dictLength), 0);
		dictionary = tmpDict;
		dictLength = s.w_size;
	}
	const avail = strm.avail_in;
	const next = strm.next_in;
	const input = strm.input;
	strm.avail_in = dictLength;
	strm.next_in = 0;
	strm.input = dictionary;
	fill_window(s);
	while (s.lookahead >= MIN_MATCH) {
		let str = s.strstart;
		let n = s.lookahead - (MIN_MATCH - 1);
		do {
			s.ins_h = HASH(s, s.ins_h, s.window[str + MIN_MATCH - 1]);
			s.prev[str & s.w_mask] = s.head[s.ins_h];
			s.head[s.ins_h] = str;
			str++;
		} while (--n);
		s.strstart = str;
		s.lookahead = MIN_MATCH - 1;
		fill_window(s);
	}
	s.strstart += s.lookahead;
	s.block_start = s.strstart;
	s.insert = s.lookahead;
	s.lookahead = 0;
	s.match_length = s.prev_length = MIN_MATCH - 1;
	s.match_available = 0;
	strm.next_in = next;
	strm.input = input;
	strm.avail_in = avail;
	s.wrap = wrap;
	return Z_OK$3;
};
var deflate_1$2 = {
	deflateInit,
	deflateInit2,
	deflateReset,
	deflateResetKeep,
	deflateSetHeader,
	deflate: deflate$2,
	deflateEnd,
	deflateSetDictionary,
	deflateInfo: "pako deflate (from Nodeca project)"
};
const _has = (obj, key) => {
	return Object.prototype.hasOwnProperty.call(obj, key);
};
var assign = function(obj) {
	const sources = Array.prototype.slice.call(arguments, 1);
	while (sources.length) {
		const source = sources.shift();
		if (!source) {continue;}
		if (typeof source !== "object") {throw new TypeError(source + "must be non-object");}
		for (const p in source) {if (_has(source, p)) obj[p] = source[p];}
	}
	return obj;
};
var flattenChunks = (chunks) => {
	let len = 0;
	for (let i = 0, l = chunks.length; i < l; i++) {len += chunks[i].length;}
	const result = new Uint8Array(len);
	for (let i = 0, pos = 0, l = chunks.length; i < l; i++) {
		let chunk = chunks[i];
		result.set(chunk, pos);
		pos += chunk.length;
	}
	return result;
};
var common = {
	assign,
	flattenChunks
};
let STR_APPLY_UIA_OK = true;
try {
	String.fromCharCode.apply(null, new Uint8Array(1));
} catch (__) {
	STR_APPLY_UIA_OK = false;
}
const _utf8len = new Uint8Array(256);
for (let q = 0; q < 256; q++) {_utf8len[q] = q >= 252 ? 6 : q >= 248 ? 5 : q >= 240 ? 4 : q >= 224 ? 3 : q >= 192 ? 2 : 1;}
_utf8len[254] = _utf8len[254] = 1;
var string2buf = (str) => {
	if (typeof TextEncoder === "function" && TextEncoder.prototype.encode) {return new TextEncoder().encode(str);}
	let buf, c, c2, m_pos, i, str_len = str.length, buf_len = 0;
	for (m_pos = 0; m_pos < str_len; m_pos++) {
		c = str.charCodeAt(m_pos);
		if ((c & 64512) === 55296 && m_pos + 1 < str_len) {
			c2 = str.charCodeAt(m_pos + 1);
			if ((c2 & 64512) === 56320) {
				c = 65536 + (c - 55296 << 10) + (c2 - 56320);
				m_pos++;
			}
		}
		buf_len += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : 4;
	}
	buf = new Uint8Array(buf_len);
	for (i = 0, m_pos = 0; i < buf_len; m_pos++) {
		c = str.charCodeAt(m_pos);
		if ((c & 64512) === 55296 && m_pos + 1 < str_len) {
			c2 = str.charCodeAt(m_pos + 1);
			if ((c2 & 64512) === 56320) {
				c = 65536 + (c - 55296 << 10) + (c2 - 56320);
				m_pos++;
			}
		}
		if (c < 128) {buf[i++] = c;}
		else if (c < 2048) {
			buf[i++] = 192 | c >>> 6;
			buf[i++] = 128 | c & 63;
		} else if (c < 65536) {
			buf[i++] = 224 | c >>> 12;
			buf[i++] = 128 | c >>> 6 & 63;
			buf[i++] = 128 | c & 63;
		} else {
			buf[i++] = 240 | c >>> 18;
			buf[i++] = 128 | c >>> 12 & 63;
			buf[i++] = 128 | c >>> 6 & 63;
			buf[i++] = 128 | c & 63;
		}
	}
	return buf;
};
const buf2binstring = (buf, len) => {
	if (len < 65534) {
		if (buf.subarray && STR_APPLY_UIA_OK) {return String.fromCharCode.apply(null, buf.length === len ? buf : buf.subarray(0, len));}
	}
	let result = "";
	for (let i = 0; i < len; i++) {result += String.fromCharCode(buf[i]);}
	return result;
};
var buf2string = (buf, max) => {
	const len = max || buf.length;
	if (typeof TextDecoder === "function" && TextDecoder.prototype.decode) {return new TextDecoder().decode(buf.subarray(0, max));}
	let i, out;
	const utf16buf = new Array(len * 2);
	for (out = 0, i = 0; i < len;) {
		let c = buf[i++];
		if (c < 128) {
			utf16buf[out++] = c;
			continue;
		}
		let c_len = _utf8len[c];
		if (c_len > 4) {
			utf16buf[out++] = 65533;
			i += c_len - 1;
			continue;
		}
		c &= c_len === 2 ? 31 : c_len === 3 ? 15 : 7;
		while (c_len > 1 && i < len) {
			c = c << 6 | buf[i++] & 63;
			c_len--;
		}
		if (c_len > 1) {
			utf16buf[out++] = 65533;
			continue;
		}
		if (c < 65536) {utf16buf[out++] = c;}
		else {
			c -= 65536;
			utf16buf[out++] = 55296 | c >> 10 & 1023;
			utf16buf[out++] = 56320 | c & 1023;
		}
	}
	return buf2binstring(utf16buf, out);
};
var utf8border = (buf, max) => {
	max = max || buf.length;
	if (max > buf.length) {max = buf.length;}
	let pos = max - 1;
	while (pos >= 0 && (buf[pos] & 192) === 128) {pos--;}
	if (pos < 0) {return max;}
	if (pos === 0) {return max;}
	return pos + _utf8len[buf[pos]] > max ? pos : max;
};
var strings = {
	string2buf,
	buf2string,
	utf8border
};
function ZStream() {
	this.input = null;
	this.next_in = 0;
	this.avail_in = 0;
	this.total_in = 0;
	this.output = null;
	this.next_out = 0;
	this.avail_out = 0;
	this.total_out = 0;
	this.msg = "";
	this.state = null;
	this.data_type = 2;
	this.adler = 0;
}
var zstream = ZStream;
const toString$1 = Object.prototype.toString;
const { Z_NO_FLUSH: Z_NO_FLUSH$1, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH: Z_FINISH$2, Z_OK: Z_OK$2, Z_STREAM_END: Z_STREAM_END$2, Z_DEFAULT_COMPRESSION, Z_DEFAULT_STRATEGY, Z_DEFLATED: Z_DEFLATED$1 } = constants$2;
/**
* class Deflate
*
* Generic JS-style wrapper for zlib calls. If you don't need
* streaming behaviour - use more simple functions: [[deflate]],
* [[deflateRaw]] and [[gzip]].
**/
/**
* Deflate.result -> Uint8Array
*
* Compressed result, generated by default [[Deflate#onData]]
* and [[Deflate#onEnd]] handlers. Filled after you push last chunk
* (call [[Deflate#push]] with `Z_FINISH` / `true` param).
**/
/**
* Deflate.err -> Number
*
* Error code after deflate finished. 0 (Z_OK) on success.
* You will not need it in real life, because deflate errors
* are possible only on wrong options or bad `onData` / `onEnd`
* custom handlers.
**/
/**
* Deflate.msg -> String
*
* Error message, if [[Deflate.err]] != 0
**/
/**
* new Deflate(options)
* - options (Object): zlib deflate options.
*
* Creates new deflator instance with specified params. Throws exception
* on bad params. Supported options:
*
* - `level`
* - `windowBits`
* - `memLevel`
* - `strategy`
* - `dictionary`
*
* [http://zlib.net/manual.html#Advanced](http://zlib.net/manual.html#Advanced)
* for more information on these.
*
* Additional options, for internal needs:
*
* - `chunkSize` - size of generated data chunks (16K by default)
* - `raw` (Boolean) - do raw deflate
* - `gzip` (Boolean) - create gzip wrapper
* - `header` (Object) - custom header for gzip
*   - `text` (Boolean) - true if compressed data believed to be text
*   - `time` (Number) - modification time, unix timestamp
*   - `os` (Number) - operation system code
*   - `extra` (Array) - array of bytes with extra data (max 65536)
*   - `name` (String) - file name (binary string)
*   - `comment` (String) - comment (binary string)
*   - `hcrc` (Boolean) - true if header crc should be added
*
* ##### Example:
*
* ```javascript
* const pako = require('pako')
*   , chunk1 = new Uint8Array([1,2,3,4,5,6,7,8,9])
*   , chunk2 = new Uint8Array([10,11,12,13,14,15,16,17,18,19]);
*
* const deflate = new pako.Deflate({ level: 3});
*
* deflate.push(chunk1, false);
* deflate.push(chunk2, true);  // true -> last chunk
*
* if (deflate.err) { throw new Error(deflate.err); }
*
* console.log(deflate.result);
* ```
**/
function Deflate$1(options) {
	this.options = common.assign({
		level: Z_DEFAULT_COMPRESSION,
		method: Z_DEFLATED$1,
		chunkSize: 16384,
		windowBits: 15,
		memLevel: 8,
		strategy: Z_DEFAULT_STRATEGY
	}, options || {});
	let opt = this.options;
	if (opt.raw && opt.windowBits > 0) {opt.windowBits = -opt.windowBits;}
	else if (opt.gzip && opt.windowBits > 0 && opt.windowBits < 16) {opt.windowBits += 16;}
	this.err = 0;
	this.msg = "";
	this.ended = false;
	this.chunks = [];
	this.strm = new zstream();
	this.strm.avail_out = 0;
	let status = deflate_1$2.deflateInit2(this.strm, opt.level, opt.method, opt.windowBits, opt.memLevel, opt.strategy);
	if (status !== Z_OK$2) {throw new Error(messages[status]);}
	if (opt.header) {deflate_1$2.deflateSetHeader(this.strm, opt.header);}
	if (opt.dictionary) {
		let dict;
		if (typeof opt.dictionary === "string") {dict = strings.string2buf(opt.dictionary);}
		else if (toString$1.call(opt.dictionary) === "[object ArrayBuffer]") {dict = new Uint8Array(opt.dictionary);}
		else {dict = opt.dictionary;}
		status = deflate_1$2.deflateSetDictionary(this.strm, dict);
		if (status !== Z_OK$2) {throw new Error(messages[status]);}
		this._dict_set = true;
	}
}
/**
* Deflate#push(data[, flush_mode]) -> Boolean
* - data (Uint8Array|ArrayBuffer|String): input data. Strings will be
*   converted to utf8 byte sequence.
* - flush_mode (Number|Boolean): 0..6 for corresponding Z_NO_FLUSH..Z_TREE modes.
*   See constants. Skipped or `false` means Z_NO_FLUSH, `true` means Z_FINISH.
*
* Sends input data to deflate pipe, generating [[Deflate#onData]] calls with
* new compressed chunks. Returns `true` on success. The last data block must
* have `flush_mode` Z_FINISH (or `true`). That will flush internal pending
* buffers and call [[Deflate#onEnd]].
*
* On fail call [[Deflate#onEnd]] with error code and return false.
*
* ##### Example
*
* ```javascript
* push(chunk, false); // push one of data chunks
* ...
* push(chunk, true);  // push last chunk
* ```
**/
Deflate$1.prototype.push = function(data, flush_mode) {
	const strm = this.strm;
	const chunkSize = this.options.chunkSize;
	let status, _flush_mode;
	if (this.ended) {return false;}
	if (flush_mode === ~~flush_mode) {_flush_mode = flush_mode;}
	else {_flush_mode = flush_mode === true ? Z_FINISH$2 : Z_NO_FLUSH$1;}
	if (typeof data === "string") {strm.input = strings.string2buf(data);}
	else if (toString$1.call(data) === "[object ArrayBuffer]") {strm.input = new Uint8Array(data);}
	else {strm.input = data;}
	strm.next_in = 0;
	strm.avail_in = strm.input.length;
	for (;;) {
		if (strm.avail_out === 0) {
			strm.output = new Uint8Array(chunkSize);
			strm.next_out = 0;
			strm.avail_out = chunkSize;
		}
		if ((_flush_mode === Z_SYNC_FLUSH || _flush_mode === Z_FULL_FLUSH) && strm.avail_out <= 6) {
			this.onData(strm.output.subarray(0, strm.next_out));
			strm.avail_out = 0;
			continue;
		}
		status = deflate_1$2.deflate(strm, _flush_mode);
		if (status === Z_STREAM_END$2) {
			if (strm.next_out > 0) {this.onData(strm.output.subarray(0, strm.next_out));}
			status = deflate_1$2.deflateEnd(this.strm);
			this.onEnd(status);
			this.ended = true;
			return status === Z_OK$2;
		}
		if (strm.avail_out === 0) {
			this.onData(strm.output);
			continue;
		}
		if (_flush_mode > 0 && strm.next_out > 0) {
			this.onData(strm.output.subarray(0, strm.next_out));
			strm.avail_out = 0;
			continue;
		}
		if (strm.avail_in === 0) {break;}
	}
	return true;
};
/**
* Deflate#onData(chunk) -> Void
* - chunk (Uint8Array): output data.
*
* By default, stores data blocks in `chunks[]` property and glue
* those in `onEnd`. Override this handler, if you need another behaviour.
**/
Deflate$1.prototype.onData = function(chunk) {
	this.chunks.push(chunk);
};
/**
* Deflate#onEnd(status) -> Void
* - status (Number): deflate status. 0 (Z_OK) on success,
*   other if not.
*
* Called once after you tell deflate that the input stream is
* complete (Z_FINISH). By default - join collected chunks,
* free memory and fill `results` / `err` properties.
**/
Deflate$1.prototype.onEnd = function(status) {
	if (status === Z_OK$2) {this.result = common.flattenChunks(this.chunks);}
	this.chunks = [];
	this.err = status;
	this.msg = this.strm.msg;
};
/**
* deflate(data[, options]) -> Uint8Array
* - data (Uint8Array|ArrayBuffer|String): input data to compress.
* - options (Object): zlib deflate options.
*
* Compress `data` with deflate algorithm and `options`.
*
* Supported options are:
*
* - level
* - windowBits
* - memLevel
* - strategy
* - dictionary
*
* [http://zlib.net/manual.html#Advanced](http://zlib.net/manual.html#Advanced)
* for more information on these.
*
* Sugar (options):
*
* - `raw` (Boolean) - say that we work with raw stream, if you don't wish to specify
*   negative windowBits implicitly.
*
* ##### Example:
*
* ```javascript
* const pako = require('pako')
* const data = new Uint8Array([1,2,3,4,5,6,7,8,9]);
*
* console.log(pako.deflate(data));
* ```
**/
function deflate$1(input, options) {
	const deflator = new Deflate$1(options);
	deflator.push(input, true);
	if (deflator.err) {throw deflator.msg || messages[deflator.err];}
	return deflator.result;
}
/**
* deflateRaw(data[, options]) -> Uint8Array
* - data (Uint8Array|ArrayBuffer|String): input data to compress.
* - options (Object): zlib deflate options.
*
* The same as [[deflate]], but creates raw data, without wrapper
* (header and adler32 crc).
**/
function deflateRaw$1(input, options) {
	options = options || {};
	options.raw = true;
	return deflate$1(input, options);
}
/**
* gzip(data[, options]) -> Uint8Array
* - data (Uint8Array|ArrayBuffer|String): input data to compress.
* - options (Object): zlib deflate options.
*
* The same as [[deflate]], but create gzip wrapper instead of
* deflate one.
**/
function gzip$1(input, options) {
	options = options || {};
	options.gzip = true;
	return deflate$1(input, options);
}
var deflate_1$1 = {
	Deflate: Deflate$1,
	deflate: deflate$1,
	deflateRaw: deflateRaw$1,
	gzip: gzip$1,
	constants: constants$2
};
const BAD$1 = 16209;
const TYPE$1 = 16191;
var inffast = function inflate_fast(strm, start) {
	let _in;
	let last;
	let _out;
	let beg;
	let end;
	let dmax;
	let wsize;
	let whave;
	let wnext;
	let s_window;
	let hold;
	let bits;
	let lcode;
	let dcode;
	let lmask;
	let dmask;
	let here;
	let op;
	let len;
	let dist;
	let from;
	let from_source;
	let input, output;
	const state = strm.state;
	_in = strm.next_in;
	input = strm.input;
	last = _in + (strm.avail_in - 5);
	_out = strm.next_out;
	output = strm.output;
	beg = _out - (start - strm.avail_out);
	end = _out + (strm.avail_out - 257);
	dmax = state.dmax;
	wsize = state.wsize;
	whave = state.whave;
	wnext = state.wnext;
	s_window = state.window;
	hold = state.hold;
	bits = state.bits;
	lcode = state.lencode;
	dcode = state.distcode;
	lmask = (1 << state.lenbits) - 1;
	dmask = (1 << state.distbits) - 1;
	top: do {
		if (bits < 15) {
			hold += input[_in++] << bits;
			bits += 8;
			hold += input[_in++] << bits;
			bits += 8;
		}
		here = lcode[hold & lmask];
		dolen: for (;;) {
			op = here >>> 24;
			hold >>>= op;
			bits -= op;
			op = here >>> 16 & 255;
			if (op === 0) {output[_out++] = here & 65535;}
			else if (op & 16) {
				len = here & 65535;
				op &= 15;
				if (op) {
					if (bits < op) {
						hold += input[_in++] << bits;
						bits += 8;
					}
					len += hold & (1 << op) - 1;
					hold >>>= op;
					bits -= op;
				}
				if (bits < 15) {
					hold += input[_in++] << bits;
					bits += 8;
					hold += input[_in++] << bits;
					bits += 8;
				}
				here = dcode[hold & dmask];
				dodist: for (;;) {
					op = here >>> 24;
					hold >>>= op;
					bits -= op;
					op = here >>> 16 & 255;
					if (op & 16) {
						dist = here & 65535;
						op &= 15;
						if (bits < op) {
							hold += input[_in++] << bits;
							bits += 8;
							if (bits < op) {
								hold += input[_in++] << bits;
								bits += 8;
							}
						}
						dist += hold & (1 << op) - 1;
						if (dist > dmax) {
							strm.msg = "invalid distance too far back";
							state.mode = BAD$1;
							break top;
						}
						hold >>>= op;
						bits -= op;
						op = _out - beg;
						if (dist > op) {
							op = dist - op;
							if (op > whave) {
								if (state.sane) {
									strm.msg = "invalid distance too far back";
									state.mode = BAD$1;
									break top;
								}
							}
							from = 0;
							from_source = s_window;
							if (wnext === 0) {
								from += wsize - op;
								if (op < len) {
									len -= op;
									do
										{output[_out++] = s_window[from++];}
									while (--op);
									from = _out - dist;
									from_source = output;
								}
							} else if (wnext < op) {
								from += wsize + wnext - op;
								op -= wnext;
								if (op < len) {
									len -= op;
									do
										{output[_out++] = s_window[from++];}
									while (--op);
									from = 0;
									if (wnext < len) {
										op = wnext;
										len -= op;
										do
											{output[_out++] = s_window[from++];}
										while (--op);
										from = _out - dist;
										from_source = output;
									}
								}
							} else {
								from += wnext - op;
								if (op < len) {
									len -= op;
									do
										{output[_out++] = s_window[from++];}
									while (--op);
									from = _out - dist;
									from_source = output;
								}
							}
							while (len > 2) {
								output[_out++] = from_source[from++];
								output[_out++] = from_source[from++];
								output[_out++] = from_source[from++];
								len -= 3;
							}
							if (len) {
								output[_out++] = from_source[from++];
								if (len > 1) {output[_out++] = from_source[from++];}
							}
						} else {
							from = _out - dist;
							do {
								output[_out++] = output[from++];
								output[_out++] = output[from++];
								output[_out++] = output[from++];
								len -= 3;
							} while (len > 2);
							if (len) {
								output[_out++] = output[from++];
								if (len > 1) {output[_out++] = output[from++];}
							}
						}
					} else if ((op & 64) === 0) {
						here = dcode[(here & 65535) + (hold & (1 << op) - 1)];
						continue dodist;
					} else {
						strm.msg = "invalid distance code";
						state.mode = BAD$1;
						break top;
					}
					break;
				}
			} else if ((op & 64) === 0) {
				here = lcode[(here & 65535) + (hold & (1 << op) - 1)];
				continue dolen;
			} else if (op & 32) {
				state.mode = TYPE$1;
				break top;
			} else {
				strm.msg = "invalid literal/length code";
				state.mode = BAD$1;
				break top;
			}
			break;
		}
	} while (_in < last && _out < end);
	len = bits >> 3;
	_in -= len;
	bits -= len << 3;
	hold &= (1 << bits) - 1;
	strm.next_in = _in;
	strm.next_out = _out;
	strm.avail_in = _in < last ? 5 + (last - _in) : 5 - (_in - last);
	strm.avail_out = _out < end ? 257 + (end - _out) : 257 - (_out - end);
	state.hold = hold;
	state.bits = bits;
};
const MAXBITS = 15;
const ENOUGH_LENS$1 = 852;
const ENOUGH_DISTS$1 = 592;
const CODES$1 = 0;
const LENS$1 = 1;
const DISTS$1 = 2;
const lbase = new Uint16Array([
	3,
	4,
	5,
	6,
	7,
	8,
	9,
	10,
	11,
	13,
	15,
	17,
	19,
	23,
	27,
	31,
	35,
	43,
	51,
	59,
	67,
	83,
	99,
	115,
	131,
	163,
	195,
	227,
	258,
	0,
	0
]);
const lext = new Uint8Array([
	16,
	16,
	16,
	16,
	16,
	16,
	16,
	16,
	17,
	17,
	17,
	17,
	18,
	18,
	18,
	18,
	19,
	19,
	19,
	19,
	20,
	20,
	20,
	20,
	21,
	21,
	21,
	21,
	16,
	72,
	78
]);
const dbase = new Uint16Array([
	1,
	2,
	3,
	4,
	5,
	7,
	9,
	13,
	17,
	25,
	33,
	49,
	65,
	97,
	129,
	193,
	257,
	385,
	513,
	769,
	1025,
	1537,
	2049,
	3073,
	4097,
	6145,
	8193,
	12289,
	16385,
	24577,
	0,
	0
]);
const dext = new Uint8Array([
	16,
	16,
	16,
	16,
	17,
	17,
	18,
	18,
	19,
	19,
	20,
	20,
	21,
	21,
	22,
	22,
	23,
	23,
	24,
	24,
	25,
	25,
	26,
	26,
	27,
	27,
	28,
	28,
	29,
	29,
	64,
	64
]);
const inflate_table = (type, lens, lens_index, codes, table, table_index, work, opts) => {
	const bits = opts.bits;
	let len = 0;
	let sym = 0;
	let min = 0, max = 0;
	let root = 0;
	let curr = 0;
	let drop = 0;
	let left = 0;
	let used = 0;
	let huff = 0;
	let incr;
	let fill;
	let low;
	let mask;
	let next;
	let base = null;
	let match;
	const count = new Uint16Array(MAXBITS + 1);
	const offs = new Uint16Array(MAXBITS + 1);
	let extra = null;
	let here_bits, here_op, here_val;
	for (len = 0; len <= MAXBITS; len++) {count[len] = 0;}
	for (sym = 0; sym < codes; sym++) {count[lens[lens_index + sym]]++;}
	root = bits;
	for (max = MAXBITS; max >= 1; max--) {if (count[max] !== 0) break;}
	if (root > max) {root = max;}
	if (max === 0) {
		table[table_index++] = 20971520;
		table[table_index++] = 20971520;
		opts.bits = 1;
		return 0;
	}
	for (min = 1; min < max; min++) {if (count[min] !== 0) break;}
	if (root < min) {root = min;}
	left = 1;
	for (len = 1; len <= MAXBITS; len++) {
		left <<= 1;
		left -= count[len];
		if (left < 0) {return -1;}
	}
	if (left > 0 && (type === CODES$1 || max !== 1)) {return -1;}
	offs[1] = 0;
	for (len = 1; len < MAXBITS; len++) {offs[len + 1] = offs[len] + count[len];}
	for (sym = 0; sym < codes; sym++) {if (lens[lens_index + sym] !== 0) work[offs[lens[lens_index + sym]]++] = sym;}
	if (type === CODES$1) {
		base = extra = work;
		match = 20;
	} else if (type === LENS$1) {
		base = lbase;
		extra = lext;
		match = 257;
	} else {
		base = dbase;
		extra = dext;
		match = 0;
	}
	huff = 0;
	sym = 0;
	len = min;
	next = table_index;
	curr = root;
	drop = 0;
	low = -1;
	used = 1 << root;
	mask = used - 1;
	if (type === LENS$1 && used > ENOUGH_LENS$1 || type === DISTS$1 && used > ENOUGH_DISTS$1) {return 1;}
	for (;;) {
		here_bits = len - drop;
		if (work[sym] + 1 < match) {
			here_op = 0;
			here_val = work[sym];
		} else if (work[sym] >= match) {
			here_op = extra[work[sym] - match];
			here_val = base[work[sym] - match];
		} else {
			here_op = 96;
			here_val = 0;
		}
		incr = 1 << len - drop;
		fill = 1 << curr;
		min = fill;
		do {
			fill -= incr;
			table[next + (huff >> drop) + fill] = here_bits << 24 | here_op << 16 | here_val | 0;
		} while (fill !== 0);
		incr = 1 << len - 1;
		while (huff & incr) {incr >>= 1;}
		if (incr !== 0) {
			huff &= incr - 1;
			huff += incr;
		} else {huff = 0;}
		sym++;
		if (--count[len] === 0) {
			if (len === max) {break;}
			len = lens[lens_index + work[sym]];
		}
		if (len > root && (huff & mask) !== low) {
			if (drop === 0) {drop = root;}
			next += min;
			curr = len - drop;
			left = 1 << curr;
			while (curr + drop < max) {
				left -= count[curr + drop];
				if (left <= 0) {break;}
				curr++;
				left <<= 1;
			}
			used += 1 << curr;
			if (type === LENS$1 && used > ENOUGH_LENS$1 || type === DISTS$1 && used > ENOUGH_DISTS$1) {return 1;}
			low = huff & mask;
			table[low] = root << 24 | curr << 16 | next - table_index | 0;
		}
	}
	if (huff !== 0) {table[next + huff] = len - drop << 24 | 4194304;}
	opts.bits = root;
	return 0;
};
var inftrees = inflate_table;
const CODES = 0;
const LENS = 1;
const DISTS = 2;
const { Z_FINISH: Z_FINISH$1, Z_BLOCK, Z_TREES, Z_OK: Z_OK$1, Z_STREAM_END: Z_STREAM_END$1, Z_NEED_DICT: Z_NEED_DICT$1, Z_STREAM_ERROR: Z_STREAM_ERROR$1, Z_DATA_ERROR: Z_DATA_ERROR$1, Z_MEM_ERROR: Z_MEM_ERROR$1, Z_BUF_ERROR, Z_DEFLATED } = constants$2;
const HEAD = 16180;
const FLAGS = 16181;
const TIME = 16182;
const OS = 16183;
const EXLEN = 16184;
const EXTRA = 16185;
const NAME = 16186;
const COMMENT = 16187;
const HCRC = 16188;
const DICTID = 16189;
const DICT = 16190;
const TYPE = 16191;
const TYPEDO = 16192;
const STORED = 16193;
const COPY_ = 16194;
const COPY = 16195;
const TABLE = 16196;
const LENLENS = 16197;
const CODELENS = 16198;
const LEN_ = 16199;
const LEN = 16200;
const LENEXT = 16201;
const DIST = 16202;
const DISTEXT = 16203;
const MATCH = 16204;
const LIT = 16205;
const CHECK = 16206;
const LENGTH = 16207;
const DONE = 16208;
const BAD = 16209;
const MEM = 16210;
const SYNC = 16211;
const ENOUGH_LENS = 852;
const ENOUGH_DISTS = 592;
const DEF_WBITS = 15;
const zswap32 = (q) => {
	return (q >>> 24 & 255) + (q >>> 8 & 65280) + ((q & 65280) << 8) + ((q & 255) << 24);
};
function InflateState() {
	this.strm = null;
	this.mode = 0;
	this.last = false;
	this.wrap = 0;
	this.havedict = false;
	this.flags = 0;
	this.dmax = 0;
	this.check = 0;
	this.total = 0;
	this.head = null;
	this.wbits = 0;
	this.wsize = 0;
	this.whave = 0;
	this.wnext = 0;
	this.window = null;
	this.hold = 0;
	this.bits = 0;
	this.length = 0;
	this.offset = 0;
	this.extra = 0;
	this.lencode = null;
	this.distcode = null;
	this.lenbits = 0;
	this.distbits = 0;
	this.ncode = 0;
	this.nlen = 0;
	this.ndist = 0;
	this.have = 0;
	this.next = null;
	this.lens = new Uint16Array(320);
	this.work = new Uint16Array(288);
	this.lendyn = null;
	this.distdyn = null;
	this.sane = 0;
	this.back = 0;
	this.was = 0;
}
const inflateStateCheck = (strm) => {
	if (!strm) {return 1;}
	const state = strm.state;
	if (!state || state.strm !== strm || state.mode < HEAD || state.mode > SYNC) {return 1;}
	return 0;
};
const inflateResetKeep = (strm) => {
	if (inflateStateCheck(strm)) {return Z_STREAM_ERROR$1;}
	const state = strm.state;
	strm.total_in = strm.total_out = state.total = 0;
	strm.msg = "";
	if (state.wrap) {strm.adler = state.wrap & 1;}
	state.mode = HEAD;
	state.last = 0;
	state.havedict = 0;
	state.flags = -1;
	state.dmax = 32768;
	state.head = null;
	state.hold = 0;
	state.bits = 0;
	state.lencode = state.lendyn = new Int32Array(ENOUGH_LENS);
	state.distcode = state.distdyn = new Int32Array(ENOUGH_DISTS);
	state.sane = 1;
	state.back = -1;
	return Z_OK$1;
};
const inflateReset = (strm) => {
	if (inflateStateCheck(strm)) {return Z_STREAM_ERROR$1;}
	const state = strm.state;
	state.wsize = 0;
	state.whave = 0;
	state.wnext = 0;
	return inflateResetKeep(strm);
};
const inflateReset2 = (strm, windowBits) => {
	let wrap;
	if (inflateStateCheck(strm)) {return Z_STREAM_ERROR$1;}
	const state = strm.state;
	if (windowBits < 0) {
		wrap = 0;
		windowBits = -windowBits;
	} else {
		wrap = (windowBits >> 4) + 5;
		if (windowBits < 48) {windowBits &= 15;}
	}
	if (windowBits && (windowBits < 8 || windowBits > 15)) {return Z_STREAM_ERROR$1;}
	if (state.window !== null && state.wbits !== windowBits) {state.window = null;}
	state.wrap = wrap;
	state.wbits = windowBits;
	return inflateReset(strm);
};
const inflateInit2 = (strm, windowBits) => {
	if (!strm) {return Z_STREAM_ERROR$1;}
	const state = new InflateState();
	strm.state = state;
	state.strm = strm;
	state.window = null;
	state.mode = HEAD;
	const ret = inflateReset2(strm, windowBits);
	if (ret !== Z_OK$1) {strm.state = null;}
	return ret;
};
const inflateInit = (strm) => {
	return inflateInit2(strm, DEF_WBITS);
};
let virgin = true;
let lenfix, distfix;
const fixedtables = (state) => {
	if (virgin) {
		lenfix = new Int32Array(512);
		distfix = new Int32Array(32);
		let sym = 0;
		while (sym < 144) {state.lens[sym++] = 8;}
		while (sym < 256) {state.lens[sym++] = 9;}
		while (sym < 280) {state.lens[sym++] = 7;}
		while (sym < 288) {state.lens[sym++] = 8;}
		inftrees(LENS, state.lens, 0, 288, lenfix, 0, state.work, { bits: 9 });
		sym = 0;
		while (sym < 32) {state.lens[sym++] = 5;}
		inftrees(DISTS, state.lens, 0, 32, distfix, 0, state.work, { bits: 5 });
		virgin = false;
	}
	state.lencode = lenfix;
	state.lenbits = 9;
	state.distcode = distfix;
	state.distbits = 5;
};
const updatewindow = (strm, src, end, copy) => {
	let dist;
	const state = strm.state;
	if (state.window === null) {
		state.wsize = 1 << state.wbits;
		state.wnext = 0;
		state.whave = 0;
		state.window = new Uint8Array(state.wsize);
	}
	if (copy >= state.wsize) {
		state.window.set(src.subarray(end - state.wsize, end), 0);
		state.wnext = 0;
		state.whave = state.wsize;
	} else {
		dist = state.wsize - state.wnext;
		if (dist > copy) {dist = copy;}
		state.window.set(src.subarray(end - copy, end - copy + dist), state.wnext);
		copy -= dist;
		if (copy) {
			state.window.set(src.subarray(end - copy, end), 0);
			state.wnext = copy;
			state.whave = state.wsize;
		} else {
			state.wnext += dist;
			if (state.wnext === state.wsize) {state.wnext = 0;}
			if (state.whave < state.wsize) {state.whave += dist;}
		}
	}
	return 0;
};
const inflate$2 = (strm, flush) => {
	let state;
	let input, output;
	let next;
	let put;
	let have, left;
	let hold;
	let bits;
	let _in, _out;
	let copy;
	let from;
	let from_source;
	let here = 0;
	let here_bits, here_op, here_val;
	let last_bits, last_op, last_val;
	let len;
	let ret;
	const hbuf = new Uint8Array(4);
	let opts;
	let n;
	const order = new Uint8Array([
		16,
		17,
		18,
		0,
		8,
		7,
		9,
		6,
		10,
		5,
		11,
		4,
		12,
		3,
		13,
		2,
		14,
		1,
		15
	]);
	if (inflateStateCheck(strm) || !strm.output || !strm.input && strm.avail_in !== 0) {return Z_STREAM_ERROR$1;}
	state = strm.state;
	if (state.mode === TYPE) {state.mode = TYPEDO;}
	put = strm.next_out;
	output = strm.output;
	left = strm.avail_out;
	next = strm.next_in;
	input = strm.input;
	have = strm.avail_in;
	hold = state.hold;
	bits = state.bits;
	_in = have;
	_out = left;
	ret = Z_OK$1;
	inf_leave: for (;;) {switch (state.mode) {
		case HEAD:
			if (state.wrap === 0) {
				state.mode = TYPEDO;
				break;
			}
			while (bits < 16) {
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			if (state.wrap & 2 && hold === 35615) {
				if (state.wbits === 0) state.wbits = 15;
				state.check = 0;
				hbuf[0] = hold & 255;
				hbuf[1] = hold >>> 8 & 255;
				state.check = crc32_1(state.check, hbuf, 2, 0);
				hold = 0;
				bits = 0;
				state.mode = FLAGS;
				break;
			}
			if (state.head) state.head.done = false;
			if (!(state.wrap & 1) || (((hold & 255) << 8) + (hold >> 8)) % 31) {
				strm.msg = "incorrect header check";
				state.mode = BAD;
				break;
			}
			if ((hold & 15) !== Z_DEFLATED) {
				strm.msg = "unknown compression method";
				state.mode = BAD;
				break;
			}
			hold >>>= 4;
			bits -= 4;
			len = (hold & 15) + 8;
			if (state.wbits === 0) state.wbits = len;
			if (len > 15 || len > state.wbits) {
				strm.msg = "invalid window size";
				state.mode = BAD;
				break;
			}
			state.dmax = 1 << state.wbits;
			state.flags = 0;
			strm.adler = state.check = 1;
			state.mode = hold & 512 ? DICTID : TYPE;
			hold = 0;
			bits = 0;
			break;
		case FLAGS:
			while (bits < 16) {
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			state.flags = hold;
			if ((state.flags & 255) !== Z_DEFLATED) {
				strm.msg = "unknown compression method";
				state.mode = BAD;
				break;
			}
			if (state.flags & 57344) {
				strm.msg = "unknown header flags set";
				state.mode = BAD;
				break;
			}
			if (state.head) state.head.text = hold >> 8 & 1;
			if (state.flags & 512 && state.wrap & 4) {
				hbuf[0] = hold & 255;
				hbuf[1] = hold >>> 8 & 255;
				state.check = crc32_1(state.check, hbuf, 2, 0);
			}
			hold = 0;
			bits = 0;
			state.mode = TIME;
		case TIME:
			while (bits < 32) {
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			if (state.head) state.head.time = hold;
			if (state.flags & 512 && state.wrap & 4) {
				hbuf[0] = hold & 255;
				hbuf[1] = hold >>> 8 & 255;
				hbuf[2] = hold >>> 16 & 255;
				hbuf[3] = hold >>> 24 & 255;
				state.check = crc32_1(state.check, hbuf, 4, 0);
			}
			hold = 0;
			bits = 0;
			state.mode = OS;
		case OS:
			while (bits < 16) {
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			if (state.head) {
				state.head.xflags = hold & 255;
				state.head.os = hold >> 8;
			}
			if (state.flags & 512 && state.wrap & 4) {
				hbuf[0] = hold & 255;
				hbuf[1] = hold >>> 8 & 255;
				state.check = crc32_1(state.check, hbuf, 2, 0);
			}
			hold = 0;
			bits = 0;
			state.mode = EXLEN;
		case EXLEN:
			if (state.flags & 1024) {
				while (bits < 16) {
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				state.length = hold;
				if (state.head) state.head.extra_len = hold;
				if (state.flags & 512 && state.wrap & 4) {
					hbuf[0] = hold & 255;
					hbuf[1] = hold >>> 8 & 255;
					state.check = crc32_1(state.check, hbuf, 2, 0);
				}
				hold = 0;
				bits = 0;
			} else if (state.head) state.head.extra = null;
			state.mode = EXTRA;
		case EXTRA:
			if (state.flags & 1024) {
				copy = state.length;
				if (copy > have) copy = have;
				if (copy) {
					if (state.head) {
						len = state.head.extra_len - state.length;
						if (!state.head.extra) state.head.extra = new Uint8Array(state.head.extra_len);
						state.head.extra.set(input.subarray(next, next + copy), len);
					}
					if (state.flags & 512 && state.wrap & 4) state.check = crc32_1(state.check, input, copy, next);
					have -= copy;
					next += copy;
					state.length -= copy;
				}
				if (state.length) break inf_leave;
			}
			state.length = 0;
			state.mode = NAME;
		case NAME:
			if (state.flags & 2048) {
				if (have === 0) break inf_leave;
				copy = 0;
				do {
					len = input[next + copy++];
					if (state.head && len && state.length < 65536) state.head.name += String.fromCharCode(len);
				} while (len && copy < have);
				if (state.flags & 512 && state.wrap & 4) state.check = crc32_1(state.check, input, copy, next);
				have -= copy;
				next += copy;
				if (len) break inf_leave;
			} else if (state.head) state.head.name = null;
			state.length = 0;
			state.mode = COMMENT;
		case COMMENT:
			if (state.flags & 4096) {
				if (have === 0) break inf_leave;
				copy = 0;
				do {
					len = input[next + copy++];
					if (state.head && len && state.length < 65536) state.head.comment += String.fromCharCode(len);
				} while (len && copy < have);
				if (state.flags & 512 && state.wrap & 4) state.check = crc32_1(state.check, input, copy, next);
				have -= copy;
				next += copy;
				if (len) break inf_leave;
			} else if (state.head) state.head.comment = null;
			state.mode = HCRC;
		case HCRC:
			if (state.flags & 512) {
				while (bits < 16) {
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				if (state.wrap & 4 && hold !== (state.check & 65535)) {
					strm.msg = "header crc mismatch";
					state.mode = BAD;
					break;
				}
				hold = 0;
				bits = 0;
			}
			if (state.head) {
				state.head.hcrc = state.flags >> 9 & 1;
				state.head.done = true;
			}
			strm.adler = state.check = 0;
			state.mode = TYPE;
			break;
		case DICTID:
			while (bits < 32) {
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			strm.adler = state.check = zswap32(hold);
			hold = 0;
			bits = 0;
			state.mode = DICT;
		case DICT:
			if (state.havedict === 0) {
				strm.next_out = put;
				strm.avail_out = left;
				strm.next_in = next;
				strm.avail_in = have;
				state.hold = hold;
				state.bits = bits;
				return Z_NEED_DICT$1;
			}
			strm.adler = state.check = 1;
			state.mode = TYPE;
		case TYPE: if (flush === Z_BLOCK || flush === Z_TREES) break inf_leave;
		case TYPEDO:
			if (state.last) {
				hold >>>= bits & 7;
				bits -= bits & 7;
				state.mode = CHECK;
				break;
			}
			while (bits < 3) {
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			state.last = hold & 1;
			hold >>>= 1;
			bits -= 1;
			switch (hold & 3) {
				case 0:
					state.mode = STORED;
					break;
				case 1:
					fixedtables(state);
					state.mode = LEN_;
					if (flush === Z_TREES) {
						hold >>>= 2;
						bits -= 2;
						break inf_leave;
					}
					break;
				case 2:
					state.mode = TABLE;
					break;
				case 3:
					strm.msg = "invalid block type";
					state.mode = BAD;
			}
			hold >>>= 2;
			bits -= 2;
			break;
		case STORED:
			hold >>>= bits & 7;
			bits -= bits & 7;
			while (bits < 32) {
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			if ((hold & 65535) !== (hold >>> 16 ^ 65535)) {
				strm.msg = "invalid stored block lengths";
				state.mode = BAD;
				break;
			}
			state.length = hold & 65535;
			hold = 0;
			bits = 0;
			state.mode = COPY_;
			if (flush === Z_TREES) break inf_leave;
		case COPY_: state.mode = COPY;
		case COPY:
			copy = state.length;
			if (copy) {
				if (copy > have) copy = have;
				if (copy > left) copy = left;
				if (copy === 0) break inf_leave;
				output.set(input.subarray(next, next + copy), put);
				have -= copy;
				next += copy;
				left -= copy;
				put += copy;
				state.length -= copy;
				break;
			}
			state.mode = TYPE;
			break;
		case TABLE:
			while (bits < 14) {
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			state.nlen = (hold & 31) + 257;
			hold >>>= 5;
			bits -= 5;
			state.ndist = (hold & 31) + 1;
			hold >>>= 5;
			bits -= 5;
			state.ncode = (hold & 15) + 4;
			hold >>>= 4;
			bits -= 4;
			if (state.nlen > 286 || state.ndist > 30) {
				strm.msg = "too many length or distance symbols";
				state.mode = BAD;
				break;
			}
			state.have = 0;
			state.mode = LENLENS;
		case LENLENS:
			while (state.have < state.ncode) {
				while (bits < 3) {
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				state.lens[order[state.have++]] = hold & 7;
				hold >>>= 3;
				bits -= 3;
			}
			while (state.have < 19) state.lens[order[state.have++]] = 0;
			state.lencode = state.lendyn;
			state.lenbits = 7;
			opts = { bits: state.lenbits };
			ret = inftrees(CODES, state.lens, 0, 19, state.lencode, 0, state.work, opts);
			state.lenbits = opts.bits;
			if (ret) {
				strm.msg = "invalid code lengths set";
				state.mode = BAD;
				break;
			}
			state.have = 0;
			state.mode = CODELENS;
		case CODELENS:
			while (state.have < state.nlen + state.ndist) {
				for (;;) {
					here = state.lencode[hold & (1 << state.lenbits) - 1];
					here_bits = here >>> 24;
					here_op = here >>> 16 & 255;
					here_val = here & 65535;
					if (here_bits <= bits) break;
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				if (here_val < 16) {
					hold >>>= here_bits;
					bits -= here_bits;
					state.lens[state.have++] = here_val;
				} else {
					if (here_val === 16) {
						n = here_bits + 2;
						while (bits < n) {
							if (have === 0) break inf_leave;
							have--;
							hold += input[next++] << bits;
							bits += 8;
						}
						hold >>>= here_bits;
						bits -= here_bits;
						if (state.have === 0) {
							strm.msg = "invalid bit length repeat";
							state.mode = BAD;
							break;
						}
						len = state.lens[state.have - 1];
						copy = 3 + (hold & 3);
						hold >>>= 2;
						bits -= 2;
					} else if (here_val === 17) {
						n = here_bits + 3;
						while (bits < n) {
							if (have === 0) break inf_leave;
							have--;
							hold += input[next++] << bits;
							bits += 8;
						}
						hold >>>= here_bits;
						bits -= here_bits;
						len = 0;
						copy = 3 + (hold & 7);
						hold >>>= 3;
						bits -= 3;
					} else {
						n = here_bits + 7;
						while (bits < n) {
							if (have === 0) break inf_leave;
							have--;
							hold += input[next++] << bits;
							bits += 8;
						}
						hold >>>= here_bits;
						bits -= here_bits;
						len = 0;
						copy = 11 + (hold & 127);
						hold >>>= 7;
						bits -= 7;
					}
					if (state.have + copy > state.nlen + state.ndist) {
						strm.msg = "invalid bit length repeat";
						state.mode = BAD;
						break;
					}
					while (copy--) state.lens[state.have++] = len;
				}
			}
			if (state.mode === BAD) break;
			if (state.lens[256] === 0) {
				strm.msg = "invalid code -- missing end-of-block";
				state.mode = BAD;
				break;
			}
			state.lenbits = 9;
			opts = { bits: state.lenbits };
			ret = inftrees(LENS, state.lens, 0, state.nlen, state.lencode, 0, state.work, opts);
			state.lenbits = opts.bits;
			if (ret) {
				strm.msg = "invalid literal/lengths set";
				state.mode = BAD;
				break;
			}
			state.distbits = 6;
			state.distcode = state.distdyn;
			opts = { bits: state.distbits };
			ret = inftrees(DISTS, state.lens, state.nlen, state.ndist, state.distcode, 0, state.work, opts);
			state.distbits = opts.bits;
			if (ret) {
				strm.msg = "invalid distances set";
				state.mode = BAD;
				break;
			}
			state.mode = LEN_;
			if (flush === Z_TREES) break inf_leave;
		case LEN_: state.mode = LEN;
		case LEN:
			if (have >= 6 && left >= 258) {
				strm.next_out = put;
				strm.avail_out = left;
				strm.next_in = next;
				strm.avail_in = have;
				state.hold = hold;
				state.bits = bits;
				inffast(strm, _out);
				put = strm.next_out;
				output = strm.output;
				left = strm.avail_out;
				next = strm.next_in;
				input = strm.input;
				have = strm.avail_in;
				hold = state.hold;
				bits = state.bits;
				if (state.mode === TYPE) state.back = -1;
				break;
			}
			state.back = 0;
			for (;;) {
				here = state.lencode[hold & (1 << state.lenbits) - 1];
				here_bits = here >>> 24;
				here_op = here >>> 16 & 255;
				here_val = here & 65535;
				if (here_bits <= bits) break;
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			if (here_op && (here_op & 240) === 0) {
				last_bits = here_bits;
				last_op = here_op;
				last_val = here_val;
				for (;;) {
					here = state.lencode[last_val + ((hold & (1 << last_bits + last_op) - 1) >> last_bits)];
					here_bits = here >>> 24;
					here_op = here >>> 16 & 255;
					here_val = here & 65535;
					if (last_bits + here_bits <= bits) break;
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				hold >>>= last_bits;
				bits -= last_bits;
				state.back += last_bits;
			}
			hold >>>= here_bits;
			bits -= here_bits;
			state.back += here_bits;
			state.length = here_val;
			if (here_op === 0) {
				state.mode = LIT;
				break;
			}
			if (here_op & 32) {
				state.back = -1;
				state.mode = TYPE;
				break;
			}
			if (here_op & 64) {
				strm.msg = "invalid literal/length code";
				state.mode = BAD;
				break;
			}
			state.extra = here_op & 15;
			state.mode = LENEXT;
		case LENEXT:
			if (state.extra) {
				n = state.extra;
				while (bits < n) {
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				state.length += hold & (1 << state.extra) - 1;
				hold >>>= state.extra;
				bits -= state.extra;
				state.back += state.extra;
			}
			state.was = state.length;
			state.mode = DIST;
		case DIST:
			for (;;) {
				here = state.distcode[hold & (1 << state.distbits) - 1];
				here_bits = here >>> 24;
				here_op = here >>> 16 & 255;
				here_val = here & 65535;
				if (here_bits <= bits) break;
				if (have === 0) break inf_leave;
				have--;
				hold += input[next++] << bits;
				bits += 8;
			}
			if ((here_op & 240) === 0) {
				last_bits = here_bits;
				last_op = here_op;
				last_val = here_val;
				for (;;) {
					here = state.distcode[last_val + ((hold & (1 << last_bits + last_op) - 1) >> last_bits)];
					here_bits = here >>> 24;
					here_op = here >>> 16 & 255;
					here_val = here & 65535;
					if (last_bits + here_bits <= bits) break;
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				hold >>>= last_bits;
				bits -= last_bits;
				state.back += last_bits;
			}
			hold >>>= here_bits;
			bits -= here_bits;
			state.back += here_bits;
			if (here_op & 64) {
				strm.msg = "invalid distance code";
				state.mode = BAD;
				break;
			}
			state.offset = here_val;
			state.extra = here_op & 15;
			state.mode = DISTEXT;
		case DISTEXT:
			if (state.extra) {
				n = state.extra;
				while (bits < n) {
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				state.offset += hold & (1 << state.extra) - 1;
				hold >>>= state.extra;
				bits -= state.extra;
				state.back += state.extra;
			}
			if (state.offset > state.dmax) {
				strm.msg = "invalid distance too far back";
				state.mode = BAD;
				break;
			}
			state.mode = MATCH;
		case MATCH:
			if (left === 0) break inf_leave;
			copy = _out - left;
			if (state.offset > copy) {
				copy = state.offset - copy;
				if (copy > state.whave) {
					if (state.sane) {
						strm.msg = "invalid distance too far back";
						state.mode = BAD;
						break;
					}
				}
				if (copy > state.wnext) {
					copy -= state.wnext;
					from = state.wsize - copy;
				} else from = state.wnext - copy;
				if (copy > state.length) copy = state.length;
				from_source = state.window;
			} else {
				from_source = output;
				from = put - state.offset;
				copy = state.length;
			}
			if (copy > left) copy = left;
			left -= copy;
			state.length -= copy;
			do
				output[put++] = from_source[from++];
			while (--copy);
			if (state.length === 0) state.mode = LEN;
			break;
		case LIT:
			if (left === 0) break inf_leave;
			output[put++] = state.length;
			left--;
			state.mode = LEN;
			break;
		case CHECK:
			if (state.wrap) {
				while (bits < 32) {
					if (have === 0) break inf_leave;
					have--;
					hold |= input[next++] << bits;
					bits += 8;
				}
				_out -= left;
				strm.total_out += _out;
				state.total += _out;
				if (state.wrap & 4 && _out) strm.adler = state.check = state.flags ? crc32_1(state.check, output, _out, put - _out) : adler32_1(state.check, output, _out, put - _out);
				_out = left;
				if (state.wrap & 4 && (state.flags ? hold : zswap32(hold)) !== state.check) {
					strm.msg = "incorrect data check";
					state.mode = BAD;
					break;
				}
				hold = 0;
				bits = 0;
			}
			state.mode = LENGTH;
		case LENGTH:
			if (state.wrap && state.flags) {
				while (bits < 32) {
					if (have === 0) break inf_leave;
					have--;
					hold += input[next++] << bits;
					bits += 8;
				}
				if (state.wrap & 4 && hold !== (state.total & 4294967295)) {
					strm.msg = "incorrect length check";
					state.mode = BAD;
					break;
				}
				hold = 0;
				bits = 0;
			}
			state.mode = DONE;
		case DONE:
			ret = Z_STREAM_END$1;
			break inf_leave;
		case BAD:
			ret = Z_DATA_ERROR$1;
			break inf_leave;
		case MEM: return Z_MEM_ERROR$1;
		case SYNC:
		default: return Z_STREAM_ERROR$1;
	}}
	strm.next_out = put;
	strm.avail_out = left;
	strm.next_in = next;
	strm.avail_in = have;
	state.hold = hold;
	state.bits = bits;
	if (state.wsize || _out !== strm.avail_out && state.mode < BAD && (state.mode < CHECK || flush !== Z_FINISH$1)) {
		if (updatewindow(strm, strm.output, strm.next_out, _out - strm.avail_out)){;}
	}
	_in -= strm.avail_in;
	_out -= strm.avail_out;
	strm.total_in += _in;
	strm.total_out += _out;
	state.total += _out;
	if (state.wrap & 4 && _out) {strm.adler = state.check = state.flags ? crc32_1(state.check, output, _out, strm.next_out - _out) : adler32_1(state.check, output, _out, strm.next_out - _out);}
	strm.data_type = state.bits + (state.last ? 64 : 0) + (state.mode === TYPE ? 128 : 0) + (state.mode === LEN_ || state.mode === COPY_ ? 256 : 0);
	if ((_in === 0 && _out === 0 || flush === Z_FINISH$1) && ret === Z_OK$1) {ret = Z_BUF_ERROR;}
	return ret;
};
const inflateEnd = (strm) => {
	if (inflateStateCheck(strm)) {return Z_STREAM_ERROR$1;}
	let state = strm.state;
	if (state.window) {state.window = null;}
	strm.state = null;
	return Z_OK$1;
};
const inflateGetHeader = (strm, head) => {
	if (inflateStateCheck(strm)) {return Z_STREAM_ERROR$1;}
	const state = strm.state;
	if ((state.wrap & 2) === 0) {return Z_STREAM_ERROR$1;}
	state.head = head;
	head.done = false;
	return Z_OK$1;
};
const inflateSetDictionary = (strm, dictionary) => {
	const dictLength = dictionary.length;
	let state;
	let dictid;
	let ret;
	if (inflateStateCheck(strm)) {return Z_STREAM_ERROR$1;}
	state = strm.state;
	if (state.wrap !== 0 && state.mode !== DICT) {return Z_STREAM_ERROR$1;}
	if (state.mode === DICT) {
		dictid = 1;
		dictid = adler32_1(dictid, dictionary, dictLength, 0);
		if (dictid !== state.check) {return Z_DATA_ERROR$1;}
	}
	ret = updatewindow(strm, dictionary, dictLength, dictLength);
	if (ret) {
		state.mode = MEM;
		return Z_MEM_ERROR$1;
	}
	state.havedict = 1;
	return Z_OK$1;
};
var inflate_1$2 = {
	inflateReset,
	inflateReset2,
	inflateResetKeep,
	inflateInit,
	inflateInit2,
	inflate: inflate$2,
	inflateEnd,
	inflateGetHeader,
	inflateSetDictionary,
	inflateInfo: "pako inflate (from Nodeca project)"
};
function GZheader() {
	this.text = 0;
	this.time = 0;
	this.xflags = 0;
	this.os = 0;
	this.extra = null;
	this.extra_len = 0;
	this.name = "";
	this.comment = "";
	this.hcrc = 0;
	this.done = false;
}
var gzheader = GZheader;
const toString$2 = Object.prototype.toString;
const { Z_NO_FLUSH, Z_FINISH, Z_OK, Z_STREAM_END, Z_NEED_DICT, Z_STREAM_ERROR, Z_DATA_ERROR, Z_MEM_ERROR } = constants$2;
/**
* class Inflate
*
* Generic JS-style wrapper for zlib calls. If you don't need
* streaming behaviour - use more simple functions: [[inflate]]
* and [[inflateRaw]].
**/
/**
* Inflate.result -> Uint8Array|String
*
* Uncompressed result, generated by default [[Inflate#onData]]
* and [[Inflate#onEnd]] handlers. Filled after you push last chunk
* (call [[Inflate#push]] with `Z_FINISH` / `true` param).
**/
/**
* Inflate.err -> Number
*
* Error code after inflate finished. 0 (Z_OK) on success.
* Should be checked if broken data possible.
**/
/**
* Inflate.msg -> String
*
* Error message, if [[Inflate.err]] != 0
**/
/**
* new Inflate(options)
* - options (Object): zlib inflate options.
*
* Creates new inflator instance with specified params. Throws exception
* on bad params. Supported options:
*
* - `windowBits`
* - `dictionary`
*
* [http://zlib.net/manual.html#Advanced](http://zlib.net/manual.html#Advanced)
* for more information on these.
*
* Additional options, for internal needs:
*
* - `chunkSize` - size of generated data chunks (16K by default)
* - `raw` (Boolean) - do raw inflate
* - `to` (String) - if equal to 'string', then result will be converted
*   from utf8 to utf16 (javascript) string. When string output requested,
*   chunk length can differ from `chunkSize`, depending on content.
*
* By default, when no options set, autodetect deflate/gzip data format via
* wrapper header.
*
* ##### Example:
*
* ```javascript
* const pako = require('pako')
* const chunk1 = new Uint8Array([1,2,3,4,5,6,7,8,9])
* const chunk2 = new Uint8Array([10,11,12,13,14,15,16,17,18,19]);
*
* const inflate = new pako.Inflate({ level: 3});
*
* inflate.push(chunk1, false);
* inflate.push(chunk2, true);  // true -> last chunk
*
* if (inflate.err) { throw new Error(inflate.err); }
*
* console.log(inflate.result);
* ```
**/
function Inflate$1(options) {
	this.options = common.assign({
		chunkSize: 1024 * 64,
		windowBits: 15,
		to: ""
	}, options || {});
	const opt = this.options;
	if (opt.raw && opt.windowBits >= 0 && opt.windowBits < 16) {
		opt.windowBits = -opt.windowBits;
		if (opt.windowBits === 0) {opt.windowBits = -15;}
	}
	if (opt.windowBits >= 0 && opt.windowBits < 16 && !(options && options.windowBits)) {opt.windowBits += 32;}
	if (opt.windowBits > 15 && opt.windowBits < 48) {
		if ((opt.windowBits & 15) === 0) {opt.windowBits |= 15;}
	}
	this.err = 0;
	this.msg = "";
	this.ended = false;
	this.chunks = [];
	this.strm = new zstream();
	this.strm.avail_out = 0;
	let status = inflate_1$2.inflateInit2(this.strm, opt.windowBits);
	if (status !== Z_OK) {throw new Error(messages[status]);}
	this.header = new gzheader();
	inflate_1$2.inflateGetHeader(this.strm, this.header);
	if (opt.dictionary) {
		if (typeof opt.dictionary === "string") {opt.dictionary = strings.string2buf(opt.dictionary);}
		else if (toString$2.call(opt.dictionary) === "[object ArrayBuffer]") {opt.dictionary = new Uint8Array(opt.dictionary);}
		if (opt.raw) {
			status = inflate_1$2.inflateSetDictionary(this.strm, opt.dictionary);
			if (status !== Z_OK) {throw new Error(messages[status]);}
		}
	}
}
/**
* Inflate#push(data[, flush_mode]) -> Boolean
* - data (Uint8Array|ArrayBuffer): input data
* - flush_mode (Number|Boolean): 0..6 for corresponding Z_NO_FLUSH..Z_TREE
*   flush modes. See constants. Skipped or `false` means Z_NO_FLUSH,
*   `true` means Z_FINISH.
*
* Sends input data to inflate pipe, generating [[Inflate#onData]] calls with
* new output chunks. Returns `true` on success. If end of stream detected,
* [[Inflate#onEnd]] will be called.
*
* `flush_mode` is not needed for normal operation, because end of stream
* detected automatically. You may try to use it for advanced things, but
* this functionality was not tested.
*
* On fail call [[Inflate#onEnd]] with error code and return false.
*
* ##### Example
*
* ```javascript
* push(chunk, false); // push one of data chunks
* ...
* push(chunk, true);  // push last chunk
* ```
**/
Inflate$1.prototype.push = function(data, flush_mode) {
	const strm = this.strm;
	const chunkSize = this.options.chunkSize;
	const dictionary = this.options.dictionary;
	let status, _flush_mode, last_avail_out;
	if (this.ended) {return false;}
	if (flush_mode === ~~flush_mode) {_flush_mode = flush_mode;}
	else {_flush_mode = flush_mode === true ? Z_FINISH : Z_NO_FLUSH;}
	if (toString$2.call(data) === "[object ArrayBuffer]") {strm.input = new Uint8Array(data);}
	else {strm.input = data;}
	strm.next_in = 0;
	strm.avail_in = strm.input.length;
	for (;;) {
		if (strm.avail_out === 0) {
			strm.output = new Uint8Array(chunkSize);
			strm.next_out = 0;
			strm.avail_out = chunkSize;
		}
		status = inflate_1$2.inflate(strm, _flush_mode);
		if (status === Z_NEED_DICT && dictionary) {
			status = inflate_1$2.inflateSetDictionary(strm, dictionary);
			if (status === Z_OK) {status = inflate_1$2.inflate(strm, _flush_mode);}
			else if (status === Z_DATA_ERROR) {status = Z_NEED_DICT;}
		}
		while (strm.avail_in > 0 && status === Z_STREAM_END && strm.state.wrap > 0 && data[strm.next_in] !== 0) {
			inflate_1$2.inflateReset(strm);
			status = inflate_1$2.inflate(strm, _flush_mode);
		}
		switch (status) {
			case Z_STREAM_ERROR:
			case Z_DATA_ERROR:
			case Z_NEED_DICT:
			case Z_MEM_ERROR:
				this.onEnd(status);
				this.ended = true;
				return false;
		}
		last_avail_out = strm.avail_out;
		if (strm.next_out) {
			if (strm.avail_out === 0 || status === Z_STREAM_END) {if (this.options.to === "string") {
				let next_out_utf8 = strings.utf8border(strm.output, strm.next_out);
				let tail = strm.next_out - next_out_utf8;
				let utf8str = strings.buf2string(strm.output, next_out_utf8);
				strm.next_out = tail;
				strm.avail_out = chunkSize - tail;
				if (tail) strm.output.set(strm.output.subarray(next_out_utf8, next_out_utf8 + tail), 0);
				this.onData(utf8str);
			} else this.onData(strm.output.length === strm.next_out ? strm.output : strm.output.subarray(0, strm.next_out));}
		}
		if (status === Z_OK && last_avail_out === 0) {continue;}
		if (status === Z_STREAM_END) {
			status = inflate_1$2.inflateEnd(this.strm);
			this.onEnd(status);
			this.ended = true;
			return true;
		}
		if (strm.avail_in === 0) {break;}
	}
	return true;
};
/**
* Inflate#onData(chunk) -> Void
* - chunk (Uint8Array|String): output data. When string output requested,
*   each chunk will be string.
*
* By default, stores data blocks in `chunks[]` property and glue
* those in `onEnd`. Override this handler, if you need another behaviour.
**/
Inflate$1.prototype.onData = function(chunk) {
	this.chunks.push(chunk);
};
/**
* Inflate#onEnd(status) -> Void
* - status (Number): inflate status. 0 (Z_OK) on success,
*   other if not.
*
* Called either after you tell inflate that the input stream is
* complete (Z_FINISH). By default - join collected chunks,
* free memory and fill `results` / `err` properties.
**/
Inflate$1.prototype.onEnd = function(status) {
	if (status === Z_OK) {if (this.options.to === "string") this.result = this.chunks.join("");
	else this.result = common.flattenChunks(this.chunks);}
	this.chunks = [];
	this.err = status;
	this.msg = this.strm.msg;
};
/**
* inflate(data[, options]) -> Uint8Array|String
* - data (Uint8Array|ArrayBuffer): input data to decompress.
* - options (Object): zlib inflate options.
*
* Decompress `data` with inflate/ungzip and `options`. Autodetect
* format via wrapper header by default. That's why we don't provide
* separate `ungzip` method.
*
* Supported options are:
*
* - windowBits
*
* [http://zlib.net/manual.html#Advanced](http://zlib.net/manual.html#Advanced)
* for more information.
*
* Sugar (options):
*
* - `raw` (Boolean) - say that we work with raw stream, if you don't wish to specify
*   negative windowBits implicitly.
* - `to` (String) - if equal to 'string', then result will be converted
*   from utf8 to utf16 (javascript) string. When string output requested,
*   chunk length can differ from `chunkSize`, depending on content.
*
*
* ##### Example:
*
* ```javascript
* const pako = require('pako');
* const input = pako.deflate(new Uint8Array([1,2,3,4,5,6,7,8,9]));
* let output;
*
* try {
*   output = pako.inflate(input);
* } catch (err) {
*   console.log(err);
* }
* ```
**/
function inflate$1(input, options) {
	const inflator = new Inflate$1(options);
	inflator.push(input);
	if (inflator.err) {throw inflator.msg || messages[inflator.err];}
	return inflator.result;
}
/**
* inflateRaw(data[, options]) -> Uint8Array|String
* - data (Uint8Array|ArrayBuffer): input data to decompress.
* - options (Object): zlib inflate options.
*
* The same as [[inflate]], but creates raw data, without wrapper
* (header and adler32 crc).
**/
function inflateRaw$1(input, options) {
	options = options || {};
	options.raw = true;
	return inflate$1(input, options);
}
var inflate_1$1 = {
	Inflate: Inflate$1,
	inflate: inflate$1,
	inflateRaw: inflateRaw$1,
	ungzip: inflate$1,
	constants: constants$2
};
const { Deflate, deflate, deflateRaw, gzip } = deflate_1$1;
const { Inflate, inflate, inflateRaw, ungzip } = inflate_1$1;
var pako = {
	Deflate,
	deflate,
	deflateRaw,
	gzip,
	Inflate,
	inflate,
	inflateRaw,
	ungzip,
	constants: constants$2
};
//#endregion
//#region node_modules/.pnpm/spark-md5@3.0.2/node_modules/spark-md5/spark-md5.js
var require_spark_md5 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(factory) {
		if (typeof exports === "object") {module.exports = factory();}
		else if (typeof define === "function" && define.amd) {define(factory);}
		else {
			var glob;
			try {
				glob = window;
			} catch (e) {
				glob = self;
			}
			glob.SparkMD5 = factory();
		}
	})(function(undefined) {
		"use strict";
		var hex_chr = [
			"0",
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
			"7",
			"8",
			"9",
			"a",
			"b",
			"c",
			"d",
			"e",
			"f"
		];
		function md5cycle(x, k) {
			var a = x[0], b = x[1], c = x[2], d = x[3];
			a += (b & c | ~b & d) + k[0] - 680876936 | 0;
			a = (a << 7 | a >>> 25) + b | 0;
			d += (a & b | ~a & c) + k[1] - 389564586 | 0;
			d = (d << 12 | d >>> 20) + a | 0;
			c += (d & a | ~d & b) + k[2] + 606105819 | 0;
			c = (c << 17 | c >>> 15) + d | 0;
			b += (c & d | ~c & a) + k[3] - 1044525330 | 0;
			b = (b << 22 | b >>> 10) + c | 0;
			a += (b & c | ~b & d) + k[4] - 176418897 | 0;
			a = (a << 7 | a >>> 25) + b | 0;
			d += (a & b | ~a & c) + k[5] + 1200080426 | 0;
			d = (d << 12 | d >>> 20) + a | 0;
			c += (d & a | ~d & b) + k[6] - 1473231341 | 0;
			c = (c << 17 | c >>> 15) + d | 0;
			b += (c & d | ~c & a) + k[7] - 45705983 | 0;
			b = (b << 22 | b >>> 10) + c | 0;
			a += (b & c | ~b & d) + k[8] + 1770035416 | 0;
			a = (a << 7 | a >>> 25) + b | 0;
			d += (a & b | ~a & c) + k[9] - 1958414417 | 0;
			d = (d << 12 | d >>> 20) + a | 0;
			c += (d & a | ~d & b) + k[10] - 42063 | 0;
			c = (c << 17 | c >>> 15) + d | 0;
			b += (c & d | ~c & a) + k[11] - 1990404162 | 0;
			b = (b << 22 | b >>> 10) + c | 0;
			a += (b & c | ~b & d) + k[12] + 1804603682 | 0;
			a = (a << 7 | a >>> 25) + b | 0;
			d += (a & b | ~a & c) + k[13] - 40341101 | 0;
			d = (d << 12 | d >>> 20) + a | 0;
			c += (d & a | ~d & b) + k[14] - 1502002290 | 0;
			c = (c << 17 | c >>> 15) + d | 0;
			b += (c & d | ~c & a) + k[15] + 1236535329 | 0;
			b = (b << 22 | b >>> 10) + c | 0;
			a += (b & d | c & ~d) + k[1] - 165796510 | 0;
			a = (a << 5 | a >>> 27) + b | 0;
			d += (a & c | b & ~c) + k[6] - 1069501632 | 0;
			d = (d << 9 | d >>> 23) + a | 0;
			c += (d & b | a & ~b) + k[11] + 643717713 | 0;
			c = (c << 14 | c >>> 18) + d | 0;
			b += (c & a | d & ~a) + k[0] - 373897302 | 0;
			b = (b << 20 | b >>> 12) + c | 0;
			a += (b & d | c & ~d) + k[5] - 701558691 | 0;
			a = (a << 5 | a >>> 27) + b | 0;
			d += (a & c | b & ~c) + k[10] + 38016083 | 0;
			d = (d << 9 | d >>> 23) + a | 0;
			c += (d & b | a & ~b) + k[15] - 660478335 | 0;
			c = (c << 14 | c >>> 18) + d | 0;
			b += (c & a | d & ~a) + k[4] - 405537848 | 0;
			b = (b << 20 | b >>> 12) + c | 0;
			a += (b & d | c & ~d) + k[9] + 568446438 | 0;
			a = (a << 5 | a >>> 27) + b | 0;
			d += (a & c | b & ~c) + k[14] - 1019803690 | 0;
			d = (d << 9 | d >>> 23) + a | 0;
			c += (d & b | a & ~b) + k[3] - 187363961 | 0;
			c = (c << 14 | c >>> 18) + d | 0;
			b += (c & a | d & ~a) + k[8] + 1163531501 | 0;
			b = (b << 20 | b >>> 12) + c | 0;
			a += (b & d | c & ~d) + k[13] - 1444681467 | 0;
			a = (a << 5 | a >>> 27) + b | 0;
			d += (a & c | b & ~c) + k[2] - 51403784 | 0;
			d = (d << 9 | d >>> 23) + a | 0;
			c += (d & b | a & ~b) + k[7] + 1735328473 | 0;
			c = (c << 14 | c >>> 18) + d | 0;
			b += (c & a | d & ~a) + k[12] - 1926607734 | 0;
			b = (b << 20 | b >>> 12) + c | 0;
			a += (b ^ c ^ d) + k[5] - 378558 | 0;
			a = (a << 4 | a >>> 28) + b | 0;
			d += (a ^ b ^ c) + k[8] - 2022574463 | 0;
			d = (d << 11 | d >>> 21) + a | 0;
			c += (d ^ a ^ b) + k[11] + 1839030562 | 0;
			c = (c << 16 | c >>> 16) + d | 0;
			b += (c ^ d ^ a) + k[14] - 35309556 | 0;
			b = (b << 23 | b >>> 9) + c | 0;
			a += (b ^ c ^ d) + k[1] - 1530992060 | 0;
			a = (a << 4 | a >>> 28) + b | 0;
			d += (a ^ b ^ c) + k[4] + 1272893353 | 0;
			d = (d << 11 | d >>> 21) + a | 0;
			c += (d ^ a ^ b) + k[7] - 155497632 | 0;
			c = (c << 16 | c >>> 16) + d | 0;
			b += (c ^ d ^ a) + k[10] - 1094730640 | 0;
			b = (b << 23 | b >>> 9) + c | 0;
			a += (b ^ c ^ d) + k[13] + 681279174 | 0;
			a = (a << 4 | a >>> 28) + b | 0;
			d += (a ^ b ^ c) + k[0] - 358537222 | 0;
			d = (d << 11 | d >>> 21) + a | 0;
			c += (d ^ a ^ b) + k[3] - 722521979 | 0;
			c = (c << 16 | c >>> 16) + d | 0;
			b += (c ^ d ^ a) + k[6] + 76029189 | 0;
			b = (b << 23 | b >>> 9) + c | 0;
			a += (b ^ c ^ d) + k[9] - 640364487 | 0;
			a = (a << 4 | a >>> 28) + b | 0;
			d += (a ^ b ^ c) + k[12] - 421815835 | 0;
			d = (d << 11 | d >>> 21) + a | 0;
			c += (d ^ a ^ b) + k[15] + 530742520 | 0;
			c = (c << 16 | c >>> 16) + d | 0;
			b += (c ^ d ^ a) + k[2] - 995338651 | 0;
			b = (b << 23 | b >>> 9) + c | 0;
			a += (c ^ (b | ~d)) + k[0] - 198630844 | 0;
			a = (a << 6 | a >>> 26) + b | 0;
			d += (b ^ (a | ~c)) + k[7] + 1126891415 | 0;
			d = (d << 10 | d >>> 22) + a | 0;
			c += (a ^ (d | ~b)) + k[14] - 1416354905 | 0;
			c = (c << 15 | c >>> 17) + d | 0;
			b += (d ^ (c | ~a)) + k[5] - 57434055 | 0;
			b = (b << 21 | b >>> 11) + c | 0;
			a += (c ^ (b | ~d)) + k[12] + 1700485571 | 0;
			a = (a << 6 | a >>> 26) + b | 0;
			d += (b ^ (a | ~c)) + k[3] - 1894986606 | 0;
			d = (d << 10 | d >>> 22) + a | 0;
			c += (a ^ (d | ~b)) + k[10] - 1051523 | 0;
			c = (c << 15 | c >>> 17) + d | 0;
			b += (d ^ (c | ~a)) + k[1] - 2054922799 | 0;
			b = (b << 21 | b >>> 11) + c | 0;
			a += (c ^ (b | ~d)) + k[8] + 1873313359 | 0;
			a = (a << 6 | a >>> 26) + b | 0;
			d += (b ^ (a | ~c)) + k[15] - 30611744 | 0;
			d = (d << 10 | d >>> 22) + a | 0;
			c += (a ^ (d | ~b)) + k[6] - 1560198380 | 0;
			c = (c << 15 | c >>> 17) + d | 0;
			b += (d ^ (c | ~a)) + k[13] + 1309151649 | 0;
			b = (b << 21 | b >>> 11) + c | 0;
			a += (c ^ (b | ~d)) + k[4] - 145523070 | 0;
			a = (a << 6 | a >>> 26) + b | 0;
			d += (b ^ (a | ~c)) + k[11] - 1120210379 | 0;
			d = (d << 10 | d >>> 22) + a | 0;
			c += (a ^ (d | ~b)) + k[2] + 718787259 | 0;
			c = (c << 15 | c >>> 17) + d | 0;
			b += (d ^ (c | ~a)) + k[9] - 343485551 | 0;
			b = (b << 21 | b >>> 11) + c | 0;
			x[0] = a + x[0] | 0;
			x[1] = b + x[1] | 0;
			x[2] = c + x[2] | 0;
			x[3] = d + x[3] | 0;
		}
		function md5blk(s) {
			var md5blks = [], i;
			for (i = 0; i < 64; i += 4) {md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);}
			return md5blks;
		}
		function md5blk_array(a) {
			var md5blks = [], i;
			for (i = 0; i < 64; i += 4) {md5blks[i >> 2] = a[i] + (a[i + 1] << 8) + (a[i + 2] << 16) + (a[i + 3] << 24);}
			return md5blks;
		}
		function md51(s) {
			var n = s.length, state = [
				1732584193,
				-271733879,
				-1732584194,
				271733878
			], i, length, tail, tmp, lo, hi;
			for (i = 64; i <= n; i += 64) {md5cycle(state, md5blk(s.substring(i - 64, i)));}
			s = s.substring(i - 64);
			length = s.length;
			tail = [
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0
			];
			for (i = 0; i < length; i += 1) {tail[i >> 2] |= s.charCodeAt(i) << (i % 4 << 3);}
			tail[i >> 2] |= 128 << (i % 4 << 3);
			if (i > 55) {
				md5cycle(state, tail);
				for (i = 0; i < 16; i += 1) {tail[i] = 0;}
			}
			tmp = n * 8;
			tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
			lo = parseInt(tmp[2], 16);
			hi = parseInt(tmp[1], 16) || 0;
			tail[14] = lo;
			tail[15] = hi;
			md5cycle(state, tail);
			return state;
		}
		function md51_array(a) {
			var n = a.length, state = [
				1732584193,
				-271733879,
				-1732584194,
				271733878
			], i, length, tail, tmp, lo, hi;
			for (i = 64; i <= n; i += 64) {md5cycle(state, md5blk_array(a.subarray(i - 64, i)));}
			a = i - 64 < n ? a.subarray(i - 64) : new Uint8Array(0);
			length = a.length;
			tail = [
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0
			];
			for (i = 0; i < length; i += 1) {tail[i >> 2] |= a[i] << (i % 4 << 3);}
			tail[i >> 2] |= 128 << (i % 4 << 3);
			if (i > 55) {
				md5cycle(state, tail);
				for (i = 0; i < 16; i += 1) {tail[i] = 0;}
			}
			tmp = n * 8;
			tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
			lo = parseInt(tmp[2], 16);
			hi = parseInt(tmp[1], 16) || 0;
			tail[14] = lo;
			tail[15] = hi;
			md5cycle(state, tail);
			return state;
		}
		function rhex(n) {
			var s = "", j;
			for (j = 0; j < 4; j += 1) {s += hex_chr[n >> j * 8 + 4 & 15] + hex_chr[n >> j * 8 & 15];}
			return s;
		}
		function hex(x) {
			var i;
			for (i = 0; i < x.length; i += 1) {x[i] = rhex(x[i]);}
			return x.join("");
		}
		if (hex(md51("hello")) !== "5d41402abc4b2a76b9719d911017c592"){;}
		/**
		* ArrayBuffer slice polyfill.
		*
		* @see https://github.com/ttaubert/node-arraybuffer-slice
		*/
		if (typeof ArrayBuffer !== "undefined" && !ArrayBuffer.prototype.slice) {(function() {
			function clamp(val, length) {
				val = val | 0 || 0;
				if (val < 0) return Math.max(val + length, 0);
				return Math.min(val, length);
			}
			ArrayBuffer.prototype.slice = function(from, to) {
				var length = this.byteLength, begin = clamp(from, length), end = length, num, target, targetArray, sourceArray;
				if (to !== undefined) end = clamp(to, length);
				if (begin > end) return /* @__PURE__ */ new ArrayBuffer(0);
				num = end - begin;
				target = new ArrayBuffer(num);
				targetArray = new Uint8Array(target);
				sourceArray = new Uint8Array(this, begin, num);
				targetArray.set(sourceArray);
				return target;
			};
		})();}
		/**
		* Helpers.
		*/
		function toUtf8(str) {
			if (/[\u0080-\uFFFF]/.test(str)) {str = unescape(encodeURIComponent(str));}
			return str;
		}
		function utf8Str2ArrayBuffer(str, returnUInt8Array) {
			var length = str.length, buff = new ArrayBuffer(length), arr = new Uint8Array(buff), i;
			for (i = 0; i < length; i += 1) {arr[i] = str.charCodeAt(i);}
			return returnUInt8Array ? arr : buff;
		}
		function arrayBuffer2Utf8Str(buff) {
			return String.fromCharCode.apply(null, new Uint8Array(buff));
		}
		function concatenateArrayBuffers(first, second, returnUInt8Array) {
			var result = new Uint8Array(first.byteLength + second.byteLength);
			result.set(new Uint8Array(first));
			result.set(new Uint8Array(second), first.byteLength);
			return returnUInt8Array ? result : result.buffer;
		}
		function hexToBinaryString(hex) {
			var bytes = [], length = hex.length, x;
			for (x = 0; x < length - 1; x += 2) {bytes.push(parseInt(hex.substr(x, 2), 16));}
			return String.fromCharCode.apply(String, bytes);
		}
		/**
		* SparkMD5 OOP implementation.
		*
		* Use this class to perform an incremental md5, otherwise use the
		* static methods instead.
		*/
		function SparkMD5() {
			this.reset();
		}
		/**
		* Appends a string.
		* A conversion will be applied if an utf8 string is detected.
		*
		* @param {String} str The string to be appended
		*
		* @return {SparkMD5} The instance itself
		*/
		SparkMD5.prototype.append = function(str) {
			this.appendBinary(toUtf8(str));
			return this;
		};
		/**
		* Appends a binary string.
		*
		* @param {String} contents The binary string to be appended
		*
		* @return {SparkMD5} The instance itself
		*/
		SparkMD5.prototype.appendBinary = function(contents) {
			this._buff += contents;
			this._length += contents.length;
			var length = this._buff.length, i;
			for (i = 64; i <= length; i += 64) {md5cycle(this._hash, md5blk(this._buff.substring(i - 64, i)));}
			this._buff = this._buff.substring(i - 64);
			return this;
		};
		/**
		* Finishes the incremental computation, reseting the internal state and
		* returning the result.
		*
		* @param {Boolean} raw True to get the raw string, false to get the hex string
		*
		* @return {String} The result
		*/
		SparkMD5.prototype.end = function(raw) {
			var buff = this._buff, length = buff.length, i, tail = [
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0
			], ret;
			for (i = 0; i < length; i += 1) {tail[i >> 2] |= buff.charCodeAt(i) << (i % 4 << 3);}
			this._finish(tail, length);
			ret = hex(this._hash);
			if (raw) {ret = hexToBinaryString(ret);}
			this.reset();
			return ret;
		};
		/**
		* Resets the internal state of the computation.
		*
		* @return {SparkMD5} The instance itself
		*/
		SparkMD5.prototype.reset = function() {
			this._buff = "";
			this._length = 0;
			this._hash = [
				1732584193,
				-271733879,
				-1732584194,
				271733878
			];
			return this;
		};
		/**
		* Gets the internal state of the computation.
		*
		* @return {Object} The state
		*/
		SparkMD5.prototype.getState = function() {
			return {
				buff: this._buff,
				length: this._length,
				hash: this._hash.slice()
			};
		};
		/**
		* Gets the internal state of the computation.
		*
		* @param {Object} state The state
		*
		* @return {SparkMD5} The instance itself
		*/
		SparkMD5.prototype.setState = function(state) {
			this._buff = state.buff;
			this._length = state.length;
			this._hash = state.hash;
			return this;
		};
		/**
		* Releases memory used by the incremental buffer and other additional
		* resources. If you plan to use the instance again, use reset instead.
		*/
		SparkMD5.prototype.destroy = function() {
			delete this._hash;
			delete this._buff;
			delete this._length;
		};
		/**
		* Finish the final calculation based on the tail.
		*
		* @param {Array}  tail   The tail (will be modified)
		* @param {Number} length The length of the remaining buffer
		*/
		SparkMD5.prototype._finish = function(tail, length) {
			var i = length, tmp, lo, hi;
			tail[i >> 2] |= 128 << (i % 4 << 3);
			if (i > 55) {
				md5cycle(this._hash, tail);
				for (i = 0; i < 16; i += 1) {tail[i] = 0;}
			}
			tmp = this._length * 8;
			tmp = tmp.toString(16).match(/(.*?)(.{0,8})$/);
			lo = parseInt(tmp[2], 16);
			hi = parseInt(tmp[1], 16) || 0;
			tail[14] = lo;
			tail[15] = hi;
			md5cycle(this._hash, tail);
		};
		/**
		* Performs the md5 hash on a string.
		* A conversion will be applied if utf8 string is detected.
		*
		* @param {String}  str The string
		* @param {Boolean} [raw] True to get the raw string, false to get the hex string
		*
		* @return {String} The result
		*/
		SparkMD5.hash = function(str, raw) {
			return SparkMD5.hashBinary(toUtf8(str), raw);
		};
		/**
		* Performs the md5 hash on a binary string.
		*
		* @param {String}  content The binary string
		* @param {Boolean} [raw]     True to get the raw string, false to get the hex string
		*
		* @return {String} The result
		*/
		SparkMD5.hashBinary = function(content, raw) {
			var ret = hex(md51(content));
			return raw ? hexToBinaryString(ret) : ret;
		};
		/**
		* SparkMD5 OOP implementation for array buffers.
		*
		* Use this class to perform an incremental md5 ONLY for array buffers.
		*/
		SparkMD5.ArrayBuffer = function() {
			this.reset();
		};
		/**
		* Appends an array buffer.
		*
		* @param {ArrayBuffer} arr The array to be appended
		*
		* @return {SparkMD5.ArrayBuffer} The instance itself
		*/
		SparkMD5.ArrayBuffer.prototype.append = function(arr) {
			var buff = concatenateArrayBuffers(this._buff.buffer, arr, true), length = buff.length, i;
			this._length += arr.byteLength;
			for (i = 64; i <= length; i += 64) {md5cycle(this._hash, md5blk_array(buff.subarray(i - 64, i)));}
			this._buff = i - 64 < length ? new Uint8Array(buff.buffer.slice(i - 64)) : new Uint8Array(0);
			return this;
		};
		/**
		* Finishes the incremental computation, reseting the internal state and
		* returning the result.
		*
		* @param {Boolean} raw True to get the raw string, false to get the hex string
		*
		* @return {String} The result
		*/
		SparkMD5.ArrayBuffer.prototype.end = function(raw) {
			var buff = this._buff, length = buff.length, tail = [
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0
			], i, ret;
			for (i = 0; i < length; i += 1) {tail[i >> 2] |= buff[i] << (i % 4 << 3);}
			this._finish(tail, length);
			ret = hex(this._hash);
			if (raw) {ret = hexToBinaryString(ret);}
			this.reset();
			return ret;
		};
		/**
		* Resets the internal state of the computation.
		*
		* @return {SparkMD5.ArrayBuffer} The instance itself
		*/
		SparkMD5.ArrayBuffer.prototype.reset = function() {
			this._buff = new Uint8Array(0);
			this._length = 0;
			this._hash = [
				1732584193,
				-271733879,
				-1732584194,
				271733878
			];
			return this;
		};
		/**
		* Gets the internal state of the computation.
		*
		* @return {Object} The state
		*/
		SparkMD5.ArrayBuffer.prototype.getState = function() {
			var state = SparkMD5.prototype.getState.call(this);
			state.buff = arrayBuffer2Utf8Str(state.buff);
			return state;
		};
		/**
		* Gets the internal state of the computation.
		*
		* @param {Object} state The state
		*
		* @return {SparkMD5.ArrayBuffer} The instance itself
		*/
		SparkMD5.ArrayBuffer.prototype.setState = function(state) {
			state.buff = utf8Str2ArrayBuffer(state.buff, true);
			return SparkMD5.prototype.setState.call(this, state);
		};
		SparkMD5.ArrayBuffer.prototype.destroy = SparkMD5.prototype.destroy;
		SparkMD5.ArrayBuffer.prototype._finish = SparkMD5.prototype._finish;
		/**
		* Performs the md5 hash on an array buffer.
		*
		* @param {ArrayBuffer} arr The array buffer
		* @param {Boolean}     [raw] True to get the raw string, false to get the hex one
		*
		* @return {String} The result
		*/
		SparkMD5.ArrayBuffer.hash = function(arr, raw) {
			var ret = hex(md51_array(new Uint8Array(arr)));
			return raw ? hexToBinaryString(ret) : ret;
		};
		return SparkMD5;
	});
}));
//#endregion
//#region node_modules/.pnpm/bignumber.js@9.3.1/node_modules/bignumber.js/bignumber.js
var require_bignumber = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(globalObject) {
		"use strict";
		var BigNumber, isNumeric = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i, mathceil = Math.ceil, mathfloor = Math.floor, bignumberError = "[BigNumber Error] ", tooManyDigits = bignumberError + "Number primitive has more than 15 significant digits: ", BASE = 0x5af3107a4000, LOG_BASE = 14, MAX_SAFE_INTEGER = 9007199254740991, POWS_TEN = [
			1,
			10,
			100,
			1e3,
			1e4,
			1e5,
			1e6,
			1e7,
			1e8,
			1e9,
			1e10,
			1e11,
			0xe8d4a51000,
			0x9184e72a000
		], SQRT_BASE = 1e7, MAX = 1e9;
		function clone(configObject) {
			var div, convertBase, parseNumeric, P = BigNumber.prototype = {
				constructor: BigNumber,
				toString: null,
				valueOf: null
			}, ONE = new BigNumber(1), DECIMAL_PLACES = 20, ROUNDING_MODE = 4, TO_EXP_NEG = -7, TO_EXP_POS = 21, MIN_EXP = -1e7, MAX_EXP = 1e7, CRYPTO = false, MODULO_MODE = 1, POW_PRECISION = 0, FORMAT = {
				prefix: "",
				groupSize: 3,
				secondaryGroupSize: 0,
				groupSeparator: ",",
				decimalSeparator: ".",
				fractionGroupSize: 0,
				fractionGroupSeparator: "\xA0",
				suffix: ""
			}, ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz", alphabetHasNormalDecimalDigits = true;
			function BigNumber(v, b) {
				var alphabet, c, caseChanged, e, i, isNum, len, str, x = this;
				if (!(x instanceof BigNumber)) {return new BigNumber(v, b);}
				if (b == null) {
					if (v && v._isBigNumber === true) {
						x.s = v.s;
						if (!v.c || v.e > MAX_EXP) {x.c = x.e = null;}
						else if (v.e < MIN_EXP) {x.c = [x.e = 0];}
						else {
							x.e = v.e;
							x.c = v.c.slice();
						}
						return;
					}
					if ((isNum = typeof v == "number") && v * 0 == 0) {
						x.s = 1 / v < 0 ? (v = -v, -1) : 1;
						if (v === ~~v) {
							for (e = 0, i = v; i >= 10; i /= 10, e++){;}
							if (e > MAX_EXP) {x.c = x.e = null;}
							else {
								x.e = e;
								x.c = [v];
							}
							return;
						}
						str = String(v);
					} else {
						if (!isNumeric.test(str = String(v))) {return parseNumeric(x, str, isNum);}
						x.s = str.charCodeAt(0) == 45 ? (str = str.slice(1), -1) : 1;
					}
					if ((e = str.indexOf(".")) > -1) {str = str.replace(".", "");}
					if ((i = str.search(/e/i)) > 0) {
						if (e < 0) {e = i;}
						e += +str.slice(i + 1);
						str = str.substring(0, i);
					} else if (e < 0) {e = str.length;}
				} else {
					intCheck(b, 2, ALPHABET.length, "Base");
					if (b == 10 && alphabetHasNormalDecimalDigits) {
						x = new BigNumber(v);
						return round(x, DECIMAL_PLACES + x.e + 1, ROUNDING_MODE);
					}
					str = String(v);
					if (isNum = typeof v == "number") {
						if (v * 0 != 0) {return parseNumeric(x, str, isNum, b);}
						x.s = 1 / v < 0 ? (str = str.slice(1), -1) : 1;
						if (BigNumber.DEBUG && str.replace(/^0\.0*|\./, "").length > 15) {throw Error(tooManyDigits + v);}
					} else {x.s = str.charCodeAt(0) === 45 ? (str = str.slice(1), -1) : 1;}
					alphabet = ALPHABET.slice(0, b);
					e = i = 0;
					for (len = str.length; i < len; i++) {if (alphabet.indexOf(c = str.charAt(i)) < 0) {
						if (c == ".") {
							if (i > e) {
								e = len;
								continue;
							}
						} else if (!caseChanged) {
							if (str == str.toUpperCase() && (str = str.toLowerCase()) || str == str.toLowerCase() && (str = str.toUpperCase())) {
								caseChanged = true;
								i = -1;
								e = 0;
								continue;
							}
						}
						return parseNumeric(x, String(v), isNum, b);
					}}
					isNum = false;
					str = convertBase(str, b, 10, x.s);
					if ((e = str.indexOf(".")) > -1) {str = str.replace(".", "");}
					else {e = str.length;}
				}
				for (i = 0; str.charCodeAt(i) === 48; i++){;}
				for (len = str.length; str.charCodeAt(--len) === 48;){;}
				if (str = str.slice(i, ++len)) {
					len -= i;
					if (isNum && BigNumber.DEBUG && len > 15 && (v > MAX_SAFE_INTEGER || v !== mathfloor(v))) {throw Error(tooManyDigits + x.s * v);}
					if ((e = e - i - 1) > MAX_EXP) {x.c = x.e = null;}
					else if (e < MIN_EXP) {x.c = [x.e = 0];}
					else {
						x.e = e;
						x.c = [];
						i = (e + 1) % LOG_BASE;
						if (e < 0) {i += LOG_BASE;}
						if (i < len) {
							if (i) {x.c.push(+str.slice(0, i));}
							for (len -= LOG_BASE; i < len;) {x.c.push(+str.slice(i, i += LOG_BASE));}
							i = LOG_BASE - (str = str.slice(i)).length;
						} else {i -= len;}
						for (; i--; str += "0"){;}
						x.c.push(+str);
					}
				} else {x.c = [x.e = 0];}
			}
			BigNumber.clone = clone;
			BigNumber.ROUND_UP = 0;
			BigNumber.ROUND_DOWN = 1;
			BigNumber.ROUND_CEIL = 2;
			BigNumber.ROUND_FLOOR = 3;
			BigNumber.ROUND_HALF_UP = 4;
			BigNumber.ROUND_HALF_DOWN = 5;
			BigNumber.ROUND_HALF_EVEN = 6;
			BigNumber.ROUND_HALF_CEIL = 7;
			BigNumber.ROUND_HALF_FLOOR = 8;
			BigNumber.EUCLID = 9;
			BigNumber.config = BigNumber.set = function(obj) {
				var p, v;
				if (obj != null) {if (typeof obj == "object") {
					if (obj.hasOwnProperty(p = "DECIMAL_PLACES")) {
						v = obj[p];
						intCheck(v, 0, MAX, p);
						DECIMAL_PLACES = v;
					}
					if (obj.hasOwnProperty(p = "ROUNDING_MODE")) {
						v = obj[p];
						intCheck(v, 0, 8, p);
						ROUNDING_MODE = v;
					}
					if (obj.hasOwnProperty(p = "EXPONENTIAL_AT")) {
						v = obj[p];
						if (v && v.pop) {
							intCheck(v[0], -MAX, 0, p);
							intCheck(v[1], 0, MAX, p);
							TO_EXP_NEG = v[0];
							TO_EXP_POS = v[1];
						} else {
							intCheck(v, -MAX, MAX, p);
							TO_EXP_NEG = -(TO_EXP_POS = v < 0 ? -v : v);
						}
					}
					if (obj.hasOwnProperty(p = "RANGE")) {
						v = obj[p];
						if (v && v.pop) {
							intCheck(v[0], -MAX, -1, p);
							intCheck(v[1], 1, MAX, p);
							MIN_EXP = v[0];
							MAX_EXP = v[1];
						} else {
							intCheck(v, -MAX, MAX, p);
							if (v) MIN_EXP = -(MAX_EXP = v < 0 ? -v : v);
							else throw Error(bignumberError + p + " cannot be zero: " + v);
						}
					}
					if (obj.hasOwnProperty(p = "CRYPTO")) {
						v = obj[p];
						if (v === !!v) if (v) if (typeof crypto != "undefined" && crypto && (crypto.getRandomValues || crypto.randomBytes)) CRYPTO = v;
						else {
							CRYPTO = !v;
							throw Error(bignumberError + "crypto unavailable");
						}
						else CRYPTO = v;
						else throw Error(bignumberError + p + " not true or false: " + v);
					}
					if (obj.hasOwnProperty(p = "MODULO_MODE")) {
						v = obj[p];
						intCheck(v, 0, 9, p);
						MODULO_MODE = v;
					}
					if (obj.hasOwnProperty(p = "POW_PRECISION")) {
						v = obj[p];
						intCheck(v, 0, MAX, p);
						POW_PRECISION = v;
					}
					if (obj.hasOwnProperty(p = "FORMAT")) {
						v = obj[p];
						if (typeof v == "object") FORMAT = v;
						else throw Error(bignumberError + p + " not an object: " + v);
					}
					if (obj.hasOwnProperty(p = "ALPHABET")) {
						v = obj[p];
						if (typeof v == "string" && !/^.?$|[+\-.\s]|(.).*\1/.test(v)) {
							alphabetHasNormalDecimalDigits = v.slice(0, 10) == "0123456789";
							ALPHABET = v;
						} else throw Error(bignumberError + p + " invalid: " + v);
					}
				} else throw Error(bignumberError + "Object expected: " + obj);}
				return {
					DECIMAL_PLACES,
					ROUNDING_MODE,
					EXPONENTIAL_AT: [TO_EXP_NEG, TO_EXP_POS],
					RANGE: [MIN_EXP, MAX_EXP],
					CRYPTO,
					MODULO_MODE,
					POW_PRECISION,
					FORMAT,
					ALPHABET
				};
			};
			BigNumber.isBigNumber = function(v) {
				if (!v || v._isBigNumber !== true) {return false;}
				if (!BigNumber.DEBUG) {return true;}
				var i, n, c = v.c, e = v.e, s = v.s;
				out: if ({}.toString.call(c) == "[object Array]") {
					if ((s === 1 || s === -1) && e >= -MAX && e <= MAX && e === mathfloor(e)) {
						if (c[0] === 0) {
							if (e === 0 && c.length === 1) {return true;}
							break out;
						}
						i = (e + 1) % LOG_BASE;
						if (i < 1) {i += LOG_BASE;}
						if (String(c[0]).length == i) {
							for (i = 0; i < c.length; i++) {
								n = c[i];
								if (n < 0 || n >= BASE || n !== mathfloor(n)) {break out;}
							}
							if (n !== 0) {return true;}
						}
					}
				} else if (c === null && e === null && (s === null || s === 1 || s === -1)) {return true;}
				throw Error(bignumberError + "Invalid BigNumber: " + v);
			};
			BigNumber.maximum = BigNumber.max = function() {
				return maxOrMin(arguments, -1);
			};
			BigNumber.minimum = BigNumber.min = function() {
				return maxOrMin(arguments, 1);
			};
			BigNumber.random = (function() {
				var pow2_53 = 9007199254740992;
				var random53bitInt = Math.random() * pow2_53 & 2097151 ? function() {
					return mathfloor(Math.random() * pow2_53);
				} : function() {
					return (Math.random() * 1073741824 | 0) * 8388608 + (Math.random() * 8388608 | 0);
				};
				return function(dp) {
					var a, b, e, k, v, i = 0, c = [], rand = new BigNumber(ONE);
					if (dp == null) {dp = DECIMAL_PLACES;}
					else {intCheck(dp, 0, MAX);}
					k = mathceil(dp / LOG_BASE);
					if (CRYPTO) {if (crypto.getRandomValues) {
						a = crypto.getRandomValues(new Uint32Array(k *= 2));
						for (; i < k;) {
							v = a[i] * 131072 + (a[i + 1] >>> 11);
							if (v >= 9e15) {
								b = crypto.getRandomValues(new Uint32Array(2));
								a[i] = b[0];
								a[i + 1] = b[1];
							} else {
								c.push(v % 0x5af3107a4000);
								i += 2;
							}
						}
						i = k / 2;
					} else if (crypto.randomBytes) {
						a = crypto.randomBytes(k *= 7);
						for (; i < k;) {
							v = (a[i] & 31) * 281474976710656 + a[i + 1] * 1099511627776 + a[i + 2] * 4294967296 + a[i + 3] * 16777216 + (a[i + 4] << 16) + (a[i + 5] << 8) + a[i + 6];
							if (v >= 9e15) crypto.randomBytes(7).copy(a, i);
							else {
								c.push(v % 0x5af3107a4000);
								i += 7;
							}
						}
						i = k / 7;
					} else {
						CRYPTO = false;
						throw Error(bignumberError + "crypto unavailable");
					}}
					if (!CRYPTO) {for (; i < k;) {
						v = random53bitInt();
						if (v < 9e15) c[i++] = v % 0x5af3107a4000;
					}}
					k = c[--i];
					dp %= LOG_BASE;
					if (k && dp) {
						v = POWS_TEN[LOG_BASE - dp];
						c[i] = mathfloor(k / v) * v;
					}
					for (; c[i] === 0; c.pop(), i--){;}
					if (i < 0) {c = [e = 0];}
					else {
						for (e = -1; c[0] === 0; c.splice(0, 1), e -= LOG_BASE){;}
						for (i = 1, v = c[0]; v >= 10; v /= 10, i++){;}
						if (i < LOG_BASE) {e -= LOG_BASE - i;}
					}
					rand.e = e;
					rand.c = c;
					return rand;
				};
			})();
			BigNumber.sum = function() {
				var i = 1, args = arguments, sum = new BigNumber(args[0]);
				for (; i < args.length;) {sum = sum.plus(args[i++]);}
				return sum;
			};
			convertBase = (function() {
				var decimal = "0123456789";
				function toBaseOut(str, baseIn, baseOut, alphabet) {
					var j, arr = [0], arrL, i = 0, len = str.length;
					for (; i < len;) {
						for (arrL = arr.length; arrL--; arr[arrL] *= baseIn){;}
						arr[0] += alphabet.indexOf(str.charAt(i++));
						for (j = 0; j < arr.length; j++) {if (arr[j] > baseOut - 1) {
							if (arr[j + 1] == null) arr[j + 1] = 0;
							arr[j + 1] += arr[j] / baseOut | 0;
							arr[j] %= baseOut;
						}}
					}
					return arr.toReversed();
				}
				return function(str, baseIn, baseOut, sign, callerIsToString) {
					var alphabet, d, e, k, r, x, xc, y, i = str.indexOf("."), dp = DECIMAL_PLACES, rm = ROUNDING_MODE;
					if (i >= 0) {
						k = POW_PRECISION;
						POW_PRECISION = 0;
						str = str.replace(".", "");
						y = new BigNumber(baseIn);
						x = y.pow(str.length - i);
						POW_PRECISION = k;
						y.c = toBaseOut(toFixedPoint(coeffToString(x.c), x.e, "0"), 10, baseOut, decimal);
						y.e = y.c.length;
					}
					xc = toBaseOut(str, baseIn, baseOut, callerIsToString ? (alphabet = ALPHABET, decimal) : (alphabet = decimal, ALPHABET));
					e = k = xc.length;
					for (; xc[--k] == 0; xc.pop()){;}
					if (!xc[0]) {return alphabet.charAt(0);}
					if (i < 0) {--e;}
					else {
						x.c = xc;
						x.e = e;
						x.s = sign;
						x = div(x, y, dp, rm, baseOut);
						xc = x.c;
						r = x.r;
						e = x.e;
					}
					d = e + dp + 1;
					i = xc[d];
					k = baseOut / 2;
					r = r || d < 0 || xc[d + 1] != null;
					r = rm < 4 ? (i != null || r) && (rm == 0 || rm == (x.s < 0 ? 3 : 2)) : i > k || i == k && (rm == 4 || r || rm == 6 && xc[d - 1] & 1 || rm == (x.s < 0 ? 8 : 7));
					if (d < 1 || !xc[0]) {str = r ? toFixedPoint(alphabet.charAt(1), -dp, alphabet.charAt(0)) : alphabet.charAt(0);}
					else {
						xc.length = d;
						if (r) {for (--baseOut; ++xc[--d] > baseOut;) {
							xc[d] = 0;
							if (!d) {
								++e;
								xc = [1].concat(xc);
							}
						}}
						for (k = xc.length; !xc[--k];){;}
						for (i = 0, str = ""; i <= k; str += alphabet.charAt(xc[i++])){;}
						str = toFixedPoint(str, e, alphabet.charAt(0));
					}
					return str;
				};
			})();
			div = (function() {
				function multiply(x, k, base) {
					var m, temp, xlo, xhi, carry = 0, i = x.length, klo = k % SQRT_BASE, khi = k / SQRT_BASE | 0;
					for (x = x.slice(); i--;) {
						xlo = x[i] % SQRT_BASE;
						xhi = x[i] / SQRT_BASE | 0;
						m = khi * xlo + xhi * klo;
						temp = klo * xlo + m % SQRT_BASE * SQRT_BASE + carry;
						carry = (temp / base | 0) + (m / SQRT_BASE | 0) + khi * xhi;
						x[i] = temp % base;
					}
					if (carry) {x = [carry].concat(x);}
					return x;
				}
				function compare(a, b, aL, bL) {
					var i, cmp;
					if (aL != bL) {cmp = aL > bL ? 1 : -1;}
					else {for (i = cmp = 0; i < aL; i++) if (a[i] != b[i]) {
						cmp = a[i] > b[i] ? 1 : -1;
						break;
					}}
					return cmp;
				}
				function subtract(a, b, aL, base) {
					var i = 0;
					for (; aL--;) {
						a[aL] -= i;
						i = a[aL] < b[aL] ? 1 : 0;
						a[aL] = i * base + a[aL] - b[aL];
					}
					for (; !a[0] && a.length > 1; a.splice(0, 1)){;}
				}
				return function(x, y, dp, rm, base) {
					var cmp, e, i, more, n, prod, prodL, q, qc, rem, remL, rem0, xi, xL, yc0, yL, yz, s = x.s == y.s ? 1 : -1, xc = x.c, yc = y.c;
					if (!xc || !xc[0] || !yc || !yc[0]) {return new BigNumber(!x.s || !y.s || (xc ? yc && xc[0] == yc[0] : !yc) ? NaN : xc && xc[0] == 0 || !yc ? s * 0 : s / 0);}
					q = new BigNumber(s);
					qc = q.c = [];
					e = x.e - y.e;
					s = dp + e + 1;
					if (!base) {
						base = BASE;
						e = bitFloor(x.e / LOG_BASE) - bitFloor(y.e / LOG_BASE);
						s = s / LOG_BASE | 0;
					}
					for (i = 0; yc[i] == (xc[i] || 0); i++){;}
					if (yc[i] > (xc[i] || 0)) {e--;}
					if (s < 0) {
						qc.push(1);
						more = true;
					} else {
						xL = xc.length;
						yL = yc.length;
						i = 0;
						s += 2;
						n = mathfloor(base / (yc[0] + 1));
						if (n > 1) {
							yc = multiply(yc, n, base);
							xc = multiply(xc, n, base);
							yL = yc.length;
							xL = xc.length;
						}
						xi = yL;
						rem = xc.slice(0, yL);
						remL = rem.length;
						for (; remL < yL; rem[remL++] = 0){;}
						yz = yc.slice();
						yz = [0].concat(yz);
						yc0 = yc[0];
						if (yc[1] >= base / 2) {yc0++;}
						do {
							n = 0;
							cmp = compare(yc, rem, yL, remL);
							if (cmp < 0) {
								rem0 = rem[0];
								if (yL != remL) {rem0 = rem0 * base + (rem[1] || 0);}
								n = mathfloor(rem0 / yc0);
								if (n > 1) {
									if (n >= base) {n = base - 1;}
									prod = multiply(yc, n, base);
									prodL = prod.length;
									remL = rem.length;
									while (compare(prod, rem, prodL, remL) == 1) {
										n--;
										subtract(prod, yL < prodL ? yz : yc, prodL, base);
										prodL = prod.length;
										cmp = 1;
									}
								} else {
									if (n == 0) {cmp = n = 1;}
									prod = yc.slice();
									prodL = prod.length;
								}
								if (prodL < remL) {prod = [0].concat(prod);}
								subtract(rem, prod, remL, base);
								remL = rem.length;
								if (cmp == -1) {while (compare(yc, rem, yL, remL) < 1) {
									n++;
									subtract(rem, yL < remL ? yz : yc, remL, base);
									remL = rem.length;
								}}
							} else if (cmp === 0) {
								n++;
								rem = [0];
							}
							qc[i++] = n;
							if (rem[0]) {rem[remL++] = xc[xi] || 0;}
							else {
								rem = [xc[xi]];
								remL = 1;
							}
						} while ((xi++ < xL || rem[0] != null) && s--);
						more = rem[0] != null;
						if (!qc[0]) {qc.splice(0, 1);}
					}
					if (base == BASE) {
						for (i = 1, s = qc[0]; s >= 10; s /= 10, i++){;}
						round(q, dp + (q.e = i + e * LOG_BASE - 1) + 1, rm, more);
					} else {
						q.e = e;
						q.r = +more;
					}
					return q;
				};
			})();
			function format(n, i, rm, id) {
				var c0, e, ne, len, str;
				if (rm == null) {rm = ROUNDING_MODE;}
				else {intCheck(rm, 0, 8);}
				if (!n.c) {return n.toString();}
				c0 = n.c[0];
				ne = n.e;
				if (i == null) {
					str = coeffToString(n.c);
					str = id == 1 || id == 2 && (ne <= TO_EXP_NEG || ne >= TO_EXP_POS) ? toExponential(str, ne) : toFixedPoint(str, ne, "0");
				} else {
					n = round(new BigNumber(n), i, rm);
					e = n.e;
					str = coeffToString(n.c);
					len = str.length;
					if (id == 1 || id == 2 && (i <= e || e <= TO_EXP_NEG)) {
						for (; len < i; str += "0", len++){;}
						str = toExponential(str, e);
					} else {
						i -= ne + (id === 2 && e > ne);
						str = toFixedPoint(str, e, "0");
						if (e + 1 > len) {
							if (--i > 0) {for (str += "."; i--; str += "0");}
						} else {
							i += e - len;
							if (i > 0) {
								if (e + 1 == len) {str += ".";}
								for (; i--; str += "0"){;}
							}
						}
					}
				}
				return n.s < 0 && c0 ? "-" + str : str;
			}
			function maxOrMin(args, n) {
				var k, y, i = 1, x = new BigNumber(args[0]);
				for (; i < args.length; i++) {
					y = new BigNumber(args[i]);
					if (!y.s || (k = compare(x, y)) === n || k === 0 && x.s === n) {x = y;}
				}
				return x;
			}
			function normalise(n, c, e) {
				var i = 1, j = c.length;
				for (; !c[--j]; c.pop()){;}
				for (j = c[0]; j >= 10; j /= 10, i++){;}
				if ((e = i + e * LOG_BASE - 1) > MAX_EXP) {n.c = n.e = null;}
				else if (e < MIN_EXP) {n.c = [n.e = 0];}
				else {
					n.e = e;
					n.c = c;
				}
				return n;
			}
			parseNumeric = (function() {
				var basePrefix = /^(-?)0([xbo])(?=\w[\w.]*$)/i, dotAfter = /^([^.]+)\.$/, dotBefore = /^\.([^.]+)$/, isInfinityOrNaN = /^-?(Infinity|NaN)$/, whitespaceOrPlus = /^\s*\+(?=[\w.])|^\s+|\s+$/g;
				return function(x, str, isNum, b) {
					var base, s = isNum ? str : str.replace(whitespaceOrPlus, "");
					if (isInfinityOrNaN.test(s)) {x.s = isNaN(s) ? null : s < 0 ? -1 : 1;}
					else {
						if (!isNum) {
							s = s.replace(basePrefix, function(m, p1, p2) {
								base = (p2 = p2.toLowerCase()) == "x" ? 16 : p2 == "b" ? 2 : 8;
								return !b || b == base ? p1 : m;
							});
							if (b) {
								base = b;
								s = s.replace(dotAfter, "$1").replace(dotBefore, "0.$1");
							}
							if (str != s) {return new BigNumber(s, base);}
						}
						if (BigNumber.DEBUG) {throw Error(bignumberError + "Not a" + (b ? " base " + b : "") + " number: " + str);}
						x.s = null;
					}
					x.c = x.e = null;
				};
			})();
			function round(x, sd, rm, r) {
				var d, i, j, k, n, ni, rd, xc = x.c, pows10 = POWS_TEN;
				if (xc) {
					out: {
						for (d = 1, k = xc[0]; k >= 10; k /= 10, d++){;}
						i = sd - d;
						if (i < 0) {
							i += LOG_BASE;
							j = sd;
							n = xc[ni = 0];
							rd = mathfloor(n / pows10[d - j - 1] % 10);
						} else {
							ni = mathceil((i + 1) / LOG_BASE);
							if (ni >= xc.length) {if (r) {
								for (; xc.length <= ni; xc.push(0));
								n = rd = 0;
								d = 1;
								i %= LOG_BASE;
								j = i - LOG_BASE + 1;
							} else break out;}
							else {
								n = k = xc[ni];
								for (d = 1; k >= 10; k /= 10, d++){;}
								i %= LOG_BASE;
								j = i - LOG_BASE + d;
								rd = j < 0 ? 0 : mathfloor(n / pows10[d - j - 1] % 10);
							}
						}
						r = r || sd < 0 || xc[ni + 1] != null || (j < 0 ? n : n % pows10[d - j - 1]);
						r = rm < 4 ? (rd || r) && (rm == 0 || rm == (x.s < 0 ? 3 : 2)) : rd > 5 || rd == 5 && (rm == 4 || r || rm == 6 && (i > 0 ? j > 0 ? n / pows10[d - j] : 0 : xc[ni - 1]) % 10 & 1 || rm == (x.s < 0 ? 8 : 7));
						if (sd < 1 || !xc[0]) {
							xc.length = 0;
							if (r) {
								sd -= x.e + 1;
								xc[0] = pows10[(LOG_BASE - sd % LOG_BASE) % LOG_BASE];
								x.e = -sd || 0;
							} else {xc[0] = x.e = 0;}
							return x;
						}
						if (i == 0) {
							xc.length = ni;
							k = 1;
							ni--;
						} else {
							xc.length = ni + 1;
							k = pows10[LOG_BASE - i];
							xc[ni] = j > 0 ? mathfloor(n / pows10[d - j] % pows10[j]) * k : 0;
						}
						if (r) {for (;;) if (ni == 0) {
							for (i = 1, j = xc[0]; j >= 10; j /= 10, i++);
							j = xc[0] += k;
							for (k = 1; j >= 10; j /= 10, k++);
							if (i != k) {
								x.e++;
								if (xc[0] == BASE) xc[0] = 1;
							}
							break;
						} else {
							xc[ni] += k;
							if (xc[ni] != BASE) break;
							xc[ni--] = 0;
							k = 1;
						}}
						for (i = xc.length; xc[--i] === 0; xc.pop()){;}
					}
					if (x.e > MAX_EXP) {x.c = x.e = null;}
					else if (x.e < MIN_EXP) {x.c = [x.e = 0];}
				}
				return x;
			}
			function valueOf(n) {
				var str, e = n.e;
				if (e === null) {return n.toString();}
				str = coeffToString(n.c);
				str = e <= TO_EXP_NEG || e >= TO_EXP_POS ? toExponential(str, e) : toFixedPoint(str, e, "0");
				return n.s < 0 ? "-" + str : str;
			}
			P.absoluteValue = P.abs = function() {
				var x = new BigNumber(this);
				if (x.s < 0) {x.s = 1;}
				return x;
			};
			P.comparedTo = function(y, b) {
				return compare(this, new BigNumber(y, b));
			};
			P.decimalPlaces = P.dp = function(dp, rm) {
				var c, n, v, x = this;
				if (dp != null) {
					intCheck(dp, 0, MAX);
					if (rm == null) {rm = ROUNDING_MODE;}
					else {intCheck(rm, 0, 8);}
					return round(new BigNumber(x), dp + x.e + 1, rm);
				}
				if (!(c = x.c)) {return null;}
				n = ((v = c.length - 1) - bitFloor(this.e / LOG_BASE)) * LOG_BASE;
				if (v = c[v]) {for (; v % 10 == 0; v /= 10, n--);}
				if (n < 0) {n = 0;}
				return n;
			};
			P.dividedBy = P.div = function(y, b) {
				return div(this, new BigNumber(y, b), DECIMAL_PLACES, ROUNDING_MODE);
			};
			P.dividedToIntegerBy = P.idiv = function(y, b) {
				return div(this, new BigNumber(y, b), 0, 1);
			};
			P.exponentiatedBy = P.pow = function(n, m) {
				var half, isModExp, i, k, more, nIsBig, nIsNeg, nIsOdd, y, x = this;
				n = new BigNumber(n);
				if (n.c && !n.isInteger()) {throw Error(bignumberError + "Exponent not an integer: " + valueOf(n));}
				if (m != null) {m = new BigNumber(m);}
				nIsBig = n.e > 14;
				if (!x.c || !x.c[0] || x.c[0] == 1 && !x.e && x.c.length == 1 || !n.c || !n.c[0]) {
					y = new BigNumber(Math.pow(+valueOf(x), nIsBig ? n.s * (2 - isOdd(n)) : +valueOf(n)));
					return m ? y.mod(m) : y;
				}
				nIsNeg = n.s < 0;
				if (m) {
					if (m.c ? !m.c[0] : !m.s) {return new BigNumber(NaN);}
					isModExp = !nIsNeg && x.isInteger() && m.isInteger();
					if (isModExp) {x = x.mod(m);}
				} else if (n.e > 9 && (x.e > 0 || x.e < -1 || (x.e == 0 ? x.c[0] > 1 || nIsBig && x.c[1] >= 24e7 : x.c[0] < 8e13 || nIsBig && x.c[0] <= 9999975e7))) {
					k = x.s < 0 && isOdd(n) ? -0 : 0;
					if (x.e > -1) {k = 1 / k;}
					return new BigNumber(nIsNeg ? 1 / k : k);
				} else if (POW_PRECISION) {k = mathceil(POW_PRECISION / LOG_BASE + 2);}
				if (nIsBig) {
					half = new BigNumber(.5);
					if (nIsNeg) {n.s = 1;}
					nIsOdd = isOdd(n);
				} else {
					i = Math.abs(+valueOf(n));
					nIsOdd = i % 2;
				}
				y = new BigNumber(ONE);
				for (;;) {
					if (nIsOdd) {
						y = y.times(x);
						if (!y.c) {break;}
						if (k) {
							if (y.c.length > k) {y.c.length = k;}
						} else if (isModExp) {y = y.mod(m);}
					}
					if (i) {
						i = mathfloor(i / 2);
						if (i === 0) {break;}
						nIsOdd = i % 2;
					} else {
						n = n.times(half);
						round(n, n.e + 1, 1);
						if (n.e > 14) {nIsOdd = isOdd(n);}
						else {
							i = +valueOf(n);
							if (i === 0) {break;}
							nIsOdd = i % 2;
						}
					}
					x = x.times(x);
					if (k) {
						if (x.c && x.c.length > k) {x.c.length = k;}
					} else if (isModExp) {x = x.mod(m);}
				}
				if (isModExp) {return y;}
				if (nIsNeg) {y = ONE.div(y);}
				return m ? y.mod(m) : k ? round(y, POW_PRECISION, ROUNDING_MODE, more) : y;
			};
			P.integerValue = function(rm) {
				var n = new BigNumber(this);
				if (rm == null) {rm = ROUNDING_MODE;}
				else {intCheck(rm, 0, 8);}
				return round(n, n.e + 1, rm);
			};
			P.isEqualTo = P.eq = function(y, b) {
				return compare(this, new BigNumber(y, b)) === 0;
			};
			P.isFinite = function() {
				return !!this.c;
			};
			P.isGreaterThan = P.gt = function(y, b) {
				return compare(this, new BigNumber(y, b)) > 0;
			};
			P.isGreaterThanOrEqualTo = P.gte = function(y, b) {
				return (b = compare(this, new BigNumber(y, b))) === 1 || b === 0;
			};
			P.isInteger = function() {
				return !!this.c && bitFloor(this.e / LOG_BASE) > this.c.length - 2;
			};
			P.isLessThan = P.lt = function(y, b) {
				return compare(this, new BigNumber(y, b)) < 0;
			};
			P.isLessThanOrEqualTo = P.lte = function(y, b) {
				return (b = compare(this, new BigNumber(y, b))) === -1 || b === 0;
			};
			P.isNaN = function() {
				return !this.s;
			};
			P.isNegative = function() {
				return this.s < 0;
			};
			P.isPositive = function() {
				return this.s > 0;
			};
			P.isZero = function() {
				return !!this.c && this.c[0] == 0;
			};
			P.minus = function(y, b) {
				var i, j, t, xLTy, x = this, a = x.s;
				y = new BigNumber(y, b);
				b = y.s;
				if (!a || !b) {return new BigNumber(NaN);}
				if (a != b) {
					y.s = -b;
					return x.plus(y);
				}
				var xe = x.e / LOG_BASE, ye = y.e / LOG_BASE, xc = x.c, yc = y.c;
				if (!xe || !ye) {
					if (!xc || !yc) {return xc ? (y.s = -b, y) : new BigNumber(yc ? x : NaN);}
					if (!xc[0] || !yc[0]) {return yc[0] ? (y.s = -b, y) : new BigNumber(xc[0] ? x : ROUNDING_MODE == 3 ? -0 : 0);}
				}
				xe = bitFloor(xe);
				ye = bitFloor(ye);
				xc = xc.slice();
				if (a = xe - ye) {
					if (xLTy = a < 0) {
						a = -a;
						t = xc;
					} else {
						ye = xe;
						t = yc;
					}
					t.reverse();
					for (b = a; b--; t.push(0)){;}
					t.reverse();
				} else {
					j = (xLTy = (a = xc.length) < (b = yc.length)) ? a : b;
					for (a = b = 0; b < j; b++) {if (xc[b] != yc[b]) {
						xLTy = xc[b] < yc[b];
						break;
					}}
				}
				if (xLTy) {
					t = xc;
					xc = yc;
					yc = t;
					y.s = -y.s;
				}
				b = (j = yc.length) - (i = xc.length);
				if (b > 0) {for (; b--; xc[i++] = 0);}
				b = BASE - 1;
				for (; j > a;) {
					if (xc[--j] < yc[j]) {
						for (i = j; i && !xc[--i]; xc[i] = b){;}
						--xc[i];
						xc[j] += BASE;
					}
					xc[j] -= yc[j];
				}
				for (; xc[0] == 0; xc.splice(0, 1), --ye){;}
				if (!xc[0]) {
					y.s = ROUNDING_MODE == 3 ? -1 : 1;
					y.c = [y.e = 0];
					return y;
				}
				return normalise(y, xc, ye);
			};
			P.modulo = P.mod = function(y, b) {
				var q, s, x = this;
				y = new BigNumber(y, b);
				if (!x.c || !y.s || y.c && !y.c[0]) {return new BigNumber(NaN);}
				else if (!y.c || x.c && !x.c[0]) {return new BigNumber(x);}
				if (MODULO_MODE == 9) {
					s = y.s;
					y.s = 1;
					q = div(x, y, 0, 3);
					y.s = s;
					q.s *= s;
				} else {q = div(x, y, 0, MODULO_MODE);}
				y = x.minus(q.times(y));
				if (!y.c[0] && MODULO_MODE == 1) {y.s = x.s;}
				return y;
			};
			P.multipliedBy = P.times = function(y, b) {
				var c, e, i, j, k, m, xcL, xlo, xhi, ycL, ylo, yhi, zc, base, sqrtBase, x = this, xc = x.c, yc = (y = new BigNumber(y, b)).c;
				if (!xc || !yc || !xc[0] || !yc[0]) {
					if (!x.s || !y.s || xc && !xc[0] && !yc || yc && !yc[0] && !xc) {y.c = y.e = y.s = null;}
					else {
						y.s *= x.s;
						if (!xc || !yc) {y.c = y.e = null;}
						else {
							y.c = [0];
							y.e = 0;
						}
					}
					return y;
				}
				e = bitFloor(x.e / LOG_BASE) + bitFloor(y.e / LOG_BASE);
				y.s *= x.s;
				xcL = xc.length;
				ycL = yc.length;
				if (xcL < ycL) {
					zc = xc;
					xc = yc;
					yc = zc;
					i = xcL;
					xcL = ycL;
					ycL = i;
				}
				for (i = xcL + ycL, zc = []; i--; zc.push(0)){;}
				base = BASE;
				sqrtBase = SQRT_BASE;
				for (i = ycL; --i >= 0;) {
					c = 0;
					ylo = yc[i] % sqrtBase;
					yhi = yc[i] / sqrtBase | 0;
					for (k = xcL, j = i + k; j > i;) {
						xlo = xc[--k] % sqrtBase;
						xhi = xc[k] / sqrtBase | 0;
						m = yhi * xlo + xhi * ylo;
						xlo = ylo * xlo + m % sqrtBase * sqrtBase + zc[j] + c;
						c = (xlo / base | 0) + (m / sqrtBase | 0) + yhi * xhi;
						zc[j--] = xlo % base;
					}
					zc[j] = c;
				}
				if (c) {++e;}
				else {zc.splice(0, 1);}
				return normalise(y, zc, e);
			};
			P.negated = function() {
				var x = new BigNumber(this);
				x.s = -x.s || null;
				return x;
			};
			P.plus = function(y, b) {
				var t, x = this, a = x.s;
				y = new BigNumber(y, b);
				b = y.s;
				if (!a || !b) {return new BigNumber(NaN);}
				if (a != b) {
					y.s = -b;
					return x.minus(y);
				}
				var xe = x.e / LOG_BASE, ye = y.e / LOG_BASE, xc = x.c, yc = y.c;
				if (!xe || !ye) {
					if (!xc || !yc) {return new BigNumber(a / 0);}
					if (!xc[0] || !yc[0]) {return yc[0] ? y : new BigNumber(xc[0] ? x : a * 0);}
				}
				xe = bitFloor(xe);
				ye = bitFloor(ye);
				xc = xc.slice();
				if (a = xe - ye) {
					if (a > 0) {
						ye = xe;
						t = yc;
					} else {
						a = -a;
						t = xc;
					}
					t.reverse();
					for (; a--; t.push(0)){;}
					t.reverse();
				}
				a = xc.length;
				b = yc.length;
				if (a - b < 0) {
					t = yc;
					yc = xc;
					xc = t;
					b = a;
				}
				for (a = 0; b;) {
					a = (xc[--b] = xc[b] + yc[b] + a) / BASE | 0;
					xc[b] = BASE === xc[b] ? 0 : xc[b] % BASE;
				}
				if (a) {
					xc = [a].concat(xc);
					++ye;
				}
				return normalise(y, xc, ye);
			};
			P.precision = P.sd = function(sd, rm) {
				var c, n, v, x = this;
				if (sd != null && sd !== !!sd) {
					intCheck(sd, 1, MAX);
					if (rm == null) {rm = ROUNDING_MODE;}
					else {intCheck(rm, 0, 8);}
					return round(new BigNumber(x), sd, rm);
				}
				if (!(c = x.c)) {return null;}
				v = c.length - 1;
				n = v * LOG_BASE + 1;
				if (v = c[v]) {
					for (; v % 10 == 0; v /= 10, n--){;}
					for (v = c[0]; v >= 10; v /= 10, n++){;}
				}
				if (sd && x.e + 1 > n) {n = x.e + 1;}
				return n;
			};
			P.shiftedBy = function(k) {
				intCheck(k, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
				return this.times("1e" + k);
			};
			P.squareRoot = P.sqrt = function() {
				var m, n, r, rep, t, x = this, c = x.c, s = x.s, e = x.e, dp = DECIMAL_PLACES + 4, half = new BigNumber("0.5");
				if (s !== 1 || !c || !c[0]) {return new BigNumber(!s || s < 0 && (!c || c[0]) ? NaN : c ? x : Infinity);}
				s = Math.sqrt(+valueOf(x));
				if (s == 0 || s == Infinity) {
					n = coeffToString(c);
					if ((n.length + e) % 2 == 0) {n += "0";}
					s = Math.sqrt(+n);
					e = bitFloor((e + 1) / 2) - (e < 0 || e % 2);
					if (s == Infinity) {n = "5e" + e;}
					else {
						n = s.toExponential();
						n = n.slice(0, n.indexOf("e") + 1) + e;
					}
					r = new BigNumber(n);
				} else {r = new BigNumber(s + "");}
				if (r.c[0]) {
					e = r.e;
					s = e + dp;
					if (s < 3) {s = 0;}
					for (;;) {
						t = r;
						r = half.times(t.plus(div(x, t, dp, 1)));
						if (coeffToString(t.c).slice(0, s) === (n = coeffToString(r.c)).slice(0, s)) {
							if (r.e < e) {--s;}
							n = n.slice(s - 3, s + 1);
							if (n == "9999" || !rep && n == "4999") {
								if (!rep) {
									round(t, t.e + DECIMAL_PLACES + 2, 0);
									if (t.times(t).eq(x)) {
										r = t;
										break;
									}
								}
								dp += 4;
								s += 4;
								rep = 1;
							} else {
								if (!+n || !+n.slice(1) && n.charAt(0) == "5") {
									round(r, r.e + DECIMAL_PLACES + 2, 1);
									m = !r.times(r).eq(x);
								}
								break;
							}
						}
					}
				}
				return round(r, r.e + DECIMAL_PLACES + 1, ROUNDING_MODE, m);
			};
			P.toExponential = function(dp, rm) {
				if (dp != null) {
					intCheck(dp, 0, MAX);
					dp++;
				}
				return format(this, dp, rm, 1);
			};
			P.toFixed = function(dp, rm) {
				if (dp != null) {
					intCheck(dp, 0, MAX);
					dp = dp + this.e + 1;
				}
				return format(this, dp, rm);
			};
			P.toFormat = function(dp, rm, format) {
				var str, x = this;
				if (format == null) {if (dp != null && rm && typeof rm == "object") {
					format = rm;
					rm = null;
				} else if (dp && typeof dp == "object") {
					format = dp;
					dp = rm = null;
				} else format = FORMAT;}
				else if (typeof format != "object") {throw Error(bignumberError + "Argument not an object: " + format);}
				str = x.toFixed(dp, rm);
				if (x.c) {
					var i, arr = str.split("."), g1 = +format.groupSize, g2 = +format.secondaryGroupSize, groupSeparator = format.groupSeparator || "", intPart = arr[0], fractionPart = arr[1], isNeg = x.s < 0, intDigits = isNeg ? intPart.slice(1) : intPart, len = intDigits.length;
					if (g2) {
						i = g1;
						g1 = g2;
						g2 = i;
						len -= i;
					}
					if (g1 > 0 && len > 0) {
						i = len % g1 || g1;
						intPart = intDigits.substr(0, i);
						for (; i < len; i += g1) {intPart += groupSeparator + intDigits.substr(i, g1);}
						if (g2 > 0) {intPart += groupSeparator + intDigits.slice(i);}
						if (isNeg) {intPart = "-" + intPart;}
					}
					str = fractionPart ? intPart + (format.decimalSeparator || "") + ((g2 = +format.fractionGroupSize) ? fractionPart.replace(new RegExp("\\d{" + g2 + "}\\B", "g"), "$&" + (format.fractionGroupSeparator || "")) : fractionPart) : intPart;
				}
				return (format.prefix || "") + str + (format.suffix || "");
			};
			P.toFraction = function(md) {
				var d, d0, d1, d2, e, exp, n, n0, n1, q, r, s, x = this, xc = x.c;
				if (md != null) {
					n = new BigNumber(md);
					if (!n.isInteger() && (n.c || n.s !== 1) || n.lt(ONE)) {throw Error(bignumberError + "Argument " + (n.isInteger() ? "out of range: " : "not an integer: ") + valueOf(n));}
				}
				if (!xc) {return new BigNumber(x);}
				d = new BigNumber(ONE);
				n1 = d0 = new BigNumber(ONE);
				d1 = n0 = new BigNumber(ONE);
				s = coeffToString(xc);
				e = d.e = s.length - x.e - 1;
				d.c[0] = POWS_TEN[(exp = e % LOG_BASE) < 0 ? LOG_BASE + exp : exp];
				md = !md || n.comparedTo(d) > 0 ? e > 0 ? d : n1 : n;
				exp = MAX_EXP;
				MAX_EXP = Infinity;
				n = new BigNumber(s);
				n0.c[0] = 0;
				for (;;) {
					q = div(n, d, 0, 1);
					d2 = d0.plus(q.times(d1));
					if (d2.comparedTo(md) == 1) {break;}
					d0 = d1;
					d1 = d2;
					n1 = n0.plus(q.times(d2 = n1));
					n0 = d2;
					d = n.minus(q.times(d2 = d));
					n = d2;
				}
				d2 = div(md.minus(d0), d1, 0, 1);
				n0 = n0.plus(d2.times(n1));
				d0 = d0.plus(d2.times(d1));
				n0.s = n1.s = x.s;
				e = e * 2;
				r = div(n1, d1, e, ROUNDING_MODE).minus(x).abs().comparedTo(div(n0, d0, e, ROUNDING_MODE).minus(x).abs()) < 1 ? [n1, d1] : [n0, d0];
				MAX_EXP = exp;
				return r;
			};
			P.toNumber = function() {
				return +valueOf(this);
			};
			P.toPrecision = function(sd, rm) {
				if (sd != null) {intCheck(sd, 1, MAX);}
				return format(this, sd, rm, 2);
			};
			P.toString = function(b) {
				var str, n = this, s = n.s, e = n.e;
				if (e === null) {if (s) {
					str = "Infinity";
					if (s < 0) str = "-" + str;
				} else str = "NaN";}
				else {
					if (b == null) {str = e <= TO_EXP_NEG || e >= TO_EXP_POS ? toExponential(coeffToString(n.c), e) : toFixedPoint(coeffToString(n.c), e, "0");}
					else if (b === 10 && alphabetHasNormalDecimalDigits) {
						n = round(new BigNumber(n), DECIMAL_PLACES + e + 1, ROUNDING_MODE);
						str = toFixedPoint(coeffToString(n.c), n.e, "0");
					} else {
						intCheck(b, 2, ALPHABET.length, "Base");
						str = convertBase(toFixedPoint(coeffToString(n.c), e, "0"), 10, b, s, true);
					}
					if (s < 0 && n.c[0]) {str = "-" + str;}
				}
				return str;
			};
			P.valueOf = P.toJSON = function() {
				return valueOf(this);
			};
			P._isBigNumber = true;
			if (configObject != null) {BigNumber.set(configObject);}
			return BigNumber;
		}
		function bitFloor(n) {
			var i = n | 0;
			return n > 0 || n === i ? i : i - 1;
		}
		function coeffToString(a) {
			var s, z, i = 1, j = a.length, r = a[0] + "";
			for (; i < j;) {
				s = a[i++] + "";
				z = LOG_BASE - s.length;
				for (; z--; s = "0" + s){;}
				r += s;
			}
			for (j = r.length; r.charCodeAt(--j) === 48;){;}
			return r.slice(0, j + 1 || 1);
		}
		function compare(x, y) {
			var a, b, xc = x.c, yc = y.c, i = x.s, j = y.s, k = x.e, l = y.e;
			if (!i || !j) {return null;}
			a = xc && !xc[0];
			b = yc && !yc[0];
			if (a || b) {return a ? b ? 0 : -j : i;}
			if (i != j) {return i;}
			a = i < 0;
			b = k == l;
			if (!xc || !yc) {return b ? 0 : !xc ^ a ? 1 : -1;}
			if (!b) {return k > l ^ a ? 1 : -1;}
			j = (k = xc.length) < (l = yc.length) ? k : l;
			for (i = 0; i < j; i++) {if (xc[i] != yc[i]) return xc[i] > yc[i] ^ a ? 1 : -1;}
			return k == l ? 0 : k > l ^ a ? 1 : -1;
		}
		function intCheck(n, min, max, name) {
			if (n < min || n > max || n !== mathfloor(n)) {throw Error(bignumberError + (name || "Argument") + (typeof n == "number" ? n < min || n > max ? " out of range: " : " not an integer: " : " not a primitive number: ") + String(n));}
		}
		function isOdd(n) {
			var k = n.c.length - 1;
			return bitFloor(n.e / LOG_BASE) == k && n.c[k] % 2 != 0;
		}
		function toExponential(str, e) {
			return (str.length > 1 ? str.charAt(0) + "." + str.slice(1) : str) + (e < 0 ? "e" : "e+") + e;
		}
		function toFixedPoint(str, e, z) {
			var len, zs;
			if (e < 0) {
				for (zs = z + "."; ++e; zs += z){;}
				str = zs + str;
			} else {
				len = str.length;
				if (++e > len) {
					for (zs = z, e -= len; --e; zs += z){;}
					str += zs;
				} else if (e < len) {str = str.slice(0, e) + "." + str.slice(e);}
			}
			return str;
		}
		BigNumber = clone();
		BigNumber["default"] = BigNumber.BigNumber = BigNumber;
		if (typeof define == "function" && define.amd) {define(function() {
			return BigNumber;
		});}
		else if (typeof module != "undefined" && module.exports) {module.exports = BigNumber;}
		else {
			if (!globalObject) {globalObject = typeof self != "undefined" && self ? self : window;}
			globalObject.BigNumber = BigNumber;
		}
	})(exports);
}));
//#endregion
//#region node_modules/.pnpm/json-bigint@1.0.0/node_modules/json-bigint/lib/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var BigNumber = require_bignumber();
	var JSON = module.exports;
	(function() {
		"use strict";
		var escapable = /[\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g, gap, indent, meta = {
			"\b": "\\b",
			"	": "\\t",
			"\n": "\\n",
			"\f": "\\f",
			"\r": "\\r",
			"\"": "\\\"",
			"\\": "\\\\"
		}, rep;
		function quote(string) {
			escapable.lastIndex = 0;
			return escapable.test(string) ? "\"" + string.replace(escapable, function(a) {
				var c = meta[a];
				return typeof c === "string" ? c : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
			}) + "\"" : "\"" + string + "\"";
		}
		function str(key, holder) {
			var i, k, v, length, mind = gap, partial, value = holder[key], isBigNumber = value != null && (value instanceof BigNumber || BigNumber.isBigNumber(value));
			if (value && typeof value === "object" && typeof value.toJSON === "function") {value = value.toJSON(key);}
			if (typeof rep === "function") {value = rep.call(holder, key, value);}
			switch (typeof value) {
				case "string": if (isBigNumber) {return value;}
				else {return quote(value);}
				case "number": return isFinite(value) ? String(value) : "null";
				case "boolean":
				case "null":
				case "bigint": return String(value);
				case "object":
					if (!value) {return "null";}
					gap += indent;
					partial = [];
					if (Object.prototype.toString.apply(value) === "[object Array]") {
						length = value.length;
						for (i = 0; i < length; i += 1) {partial[i] = str(i, value) || "null";}
						v = partial.length === 0 ? "[]" : gap ? "[\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "]" : "[" + partial.join(",") + "]";
						gap = mind;
						return v;
					}
					if (rep && typeof rep === "object") {
						length = rep.length;
						for (i = 0; i < length; i += 1) {if (typeof rep[i] === "string") {
							k = rep[i];
							v = str(k, value);
							if (v) partial.push(quote(k) + (gap ? ": " : ":") + v);
						}}
					} else {Object.keys(value).forEach(function(k) {
						var v = str(k, value);
						if (v) partial.push(quote(k) + (gap ? ": " : ":") + v);
					});}
					v = partial.length === 0 ? "{}" : gap ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}" : "{" + partial.join(",") + "}";
					gap = mind;
					return v;
			}
		}
		if (typeof JSON.stringify !== "function") {JSON.stringify = function(value, replacer, space) {
			var i;
			gap = "";
			indent = "";
			if (typeof space === "number") for (i = 0; i < space; i += 1) indent += " ";
			else if (typeof space === "string") indent = space;
			rep = replacer;
			if (replacer && typeof replacer !== "function" && (typeof replacer !== "object" || typeof replacer.length !== "number")) throw new Error("JSON.stringify");
			return str("", { "": value });
		};}
	})();
}));
//#endregion
//#region node_modules/.pnpm/json-bigint@1.0.0/node_modules/json-bigint/lib/parse.js
var require_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var BigNumber = null;
	const suspectProtoRx = /(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])/;
	const suspectConstructorRx = /(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)/;
	var json_parse = function(options) {
		"use strict";
		var _options = {
			strict: false,
			storeAsString: false,
			alwaysParseAsBig: false,
			useNativeBigInt: false,
			protoAction: "error",
			constructorAction: "error"
		};
		if (options !== void 0 && options !== null) {
			if (options.strict === true) {_options.strict = true;}
			if (options.storeAsString === true) {_options.storeAsString = true;}
			_options.alwaysParseAsBig = options.alwaysParseAsBig === true ? options.alwaysParseAsBig : false;
			_options.useNativeBigInt = options.useNativeBigInt === true ? options.useNativeBigInt : false;
			if (typeof options.constructorAction !== "undefined") {if (options.constructorAction === "error" || options.constructorAction === "ignore" || options.constructorAction === "preserve") _options.constructorAction = options.constructorAction;
			else throw new Error(`Incorrect value for constructorAction option, must be "error", "ignore" or undefined but passed ${options.constructorAction}`);}
			if (typeof options.protoAction !== "undefined") {if (options.protoAction === "error" || options.protoAction === "ignore" || options.protoAction === "preserve") _options.protoAction = options.protoAction;
			else throw new Error(`Incorrect value for protoAction option, must be "error", "ignore" or undefined but passed ${options.protoAction}`);}
		}
		var at, ch, escapee = {
			"\"": "\"",
			"\\": "\\",
			"/": "/",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "	"
		}, text, error = function(m) {
			throw {
				name: "SyntaxError",
				message: m,
				at,
				text
			};
		}, next = function(c) {
			if (c && c !== ch) {error("Expected '" + c + "' instead of '" + ch + "'");}
			ch = text.charAt(at);
			at += 1;
			return ch;
		}, number = function() {
			var number, string = "";
			if (ch === "-") {
				string = "-";
				next("-");
			}
			while (ch >= "0" && ch <= "9") {
				string += ch;
				next();
			}
			if (ch === ".") {
				string += ".";
				while (next() && ch >= "0" && ch <= "9") {string += ch;}
			}
			if (ch === "e" || ch === "E") {
				string += ch;
				next();
				if (ch === "-" || ch === "+") {
					string += ch;
					next();
				}
				while (ch >= "0" && ch <= "9") {
					string += ch;
					next();
				}
			}
			number = +string;
			if (!isFinite(number)) {error("Bad number");}
			else {
				if (BigNumber == null) {BigNumber = require_bignumber();}
				if (string.length > 15) {return _options.storeAsString ? string : _options.useNativeBigInt ? BigInt(string) : new BigNumber(string);}
				else {return !_options.alwaysParseAsBig ? number : _options.useNativeBigInt ? BigInt(number) : new BigNumber(number);}
			}
		}, string = function() {
			var hex, i, string = "", uffff;
			if (ch === "\"") {
				var startAt = at;
				while (next()) {
					if (ch === "\"") {
						if (at - 1 > startAt) {string += text.substring(startAt, at - 1);}
						next();
						return string;
					}
					if (ch === "\\") {
						if (at - 1 > startAt) {string += text.substring(startAt, at - 1);}
						next();
						if (ch === "u") {
							uffff = 0;
							for (i = 0; i < 4; i += 1) {
								hex = parseInt(next(), 16);
								if (!isFinite(hex)) {break;}
								uffff = uffff * 16 + hex;
							}
							string += String.fromCharCode(uffff);
						} else if (typeof escapee[ch] === "string") {string += escapee[ch];}
						else {break;}
						startAt = at;
					}
				}
			}
			error("Bad string");
		}, white = function() {
			while (ch && ch <= " ") {next();}
		}, word = function() {
			switch (ch) {
				case "t":
					next("t");
					next("r");
					next("u");
					next("e");
					return true;
				case "f":
					next("f");
					next("a");
					next("l");
					next("s");
					next("e");
					return false;
				case "n":
					next("n");
					next("u");
					next("l");
					next("l");
					return null;
			}
			error("Unexpected '" + ch + "'");
		}, value, array = function() {
			var array = [];
			if (ch === "[") {
				next("[");
				white();
				if (ch === "]") {
					next("]");
					return array;
				}
				while (ch) {
					array.push(value());
					white();
					if (ch === "]") {
						next("]");
						return array;
					}
					next(",");
					white();
				}
			}
			error("Bad array");
		}, object = function() {
			var key, object = Object.create(null);
			if (ch === "{") {
				next("{");
				white();
				if (ch === "}") {
					next("}");
					return object;
				}
				while (ch) {
					key = string();
					white();
					next(":");
					if (_options.strict && Object.hasOwnProperty.call(object, key)) {error("Duplicate key \"" + key + "\"");}
					if (suspectProtoRx.test(key)) {if (_options.protoAction === "error") error("Object contains forbidden prototype property");
					else if (_options.protoAction === "ignore") value();
					else object[key] = value();}
					else if (suspectConstructorRx.test(key)) {if (_options.constructorAction === "error") error("Object contains forbidden constructor property");
					else if (_options.constructorAction === "ignore") value();
					else object[key] = value();}
					else {object[key] = value();}
					white();
					if (ch === "}") {
						next("}");
						return object;
					}
					next(",");
					white();
				}
			}
			error("Bad object");
		};
		value = function() {
			white();
			switch (ch) {
				case "{": return object();
				case "[": return array();
				case "\"": return string();
				case "-": return number();
				default: return ch >= "0" && ch <= "9" ? number() : word();
			}
		};
		return function(source, reviver) {
			var result;
			text = source + "";
			at = 0;
			ch = " ";
			result = value();
			white();
			if (ch) {error("Syntax error");}
			return typeof reviver === "function" ? (function walk(holder, key) {
				var v, value = holder[key];
				if (value && typeof value === "object") {Object.keys(value).forEach(function(k) {
					v = walk(value, k);
					if (v !== void 0) value[k] = v;
					else delete value[k];
				});}
				return reviver.call(holder, key, value);
			})({ "": result }, "") : result;
		};
	};
	module.exports = json_parse;
}));
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/context.js
var import_json_bigint = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports, module) => {
	var json_stringify = require_stringify().stringify;
	var json_parse = require_parse();
	module.exports = function(options) {
		return {
			parse: json_parse(options),
			stringify: json_stringify
		};
	};
	module.exports.parse = json_parse();
	module.exports.stringify = json_stringify;
})))(), 1);
var import_spark_md5 = /* @__PURE__ */ __toESM(require_spark_md5(), 1);
const _5_MINUTES = 300 * 1e3;
var CallbacksMap = class extends Map {
	/**
	* @param ttl Time to live in milliseconds. Default is 5 minutes.
	*/
	set(key, value, ttl = _5_MINUTES) {
		setTimeout(() => {
			this.delete(key);
		}, ttl);
		return super.set(key, value);
	}
};
const createContext = (apiType = 30, apiVersion = 671) => ({
	API_TYPE: apiType,
	API_VERSION: apiVersion,
	uploadCallbacks: new CallbacksMap(),
	options: {
		selfListen: false,
		checkUpdate: true,
		logging: true,
		polyfill: global.fetch
	},
	secretKey: null
});
function isContextSession(ctx) {
	return !!ctx.secretKey;
}
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/utils.js
const isBun = typeof Bun !== "undefined";
function hasOwn(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj, key);
}
/**
* Get signed key for API requests.
*
* @param type
* @param params
* @returns MD5 hash
*
*/
function getSignKey(type, params) {
	const n = [];
	for (const s in params) {if (hasOwn(params, s)) n.push(s);}
	n.sort();
	let a = "zsecure" + type;
	for (let s = 0; s < n.length; s++) {a += params[n[s]];}
	return import_crypto_js.default.MD5(a).toString();
}
/**
*
* @param baseURL
* @param params
* @param apiVersion automatically add zalo api version to url params
* @returns
*
*/
function makeURL(ctx, baseURL, params = {}, apiVersion = true) {
	const url = new URL(baseURL);
	for (const key in params) {if (hasOwn(params, key)) url.searchParams.append(key, params[key].toString());}
	if (apiVersion) {
		if (!url.searchParams.has("zpw_ver")) {url.searchParams.set("zpw_ver", ctx.API_VERSION.toString());}
		if (!url.searchParams.has("zpw_type")) {url.searchParams.set("zpw_type", ctx.API_TYPE.toString());}
	}
	return url.toString();
}
var ParamsEncryptor = class ParamsEncryptor {
	constructor({ type, imei, firstLaunchTime }) {
		this.zcid = null;
		this.enc_ver = "v2";
		this.zcid = null;
		this.encryptKey = null;
		this.createZcid(type, imei, firstLaunchTime);
		this.zcid_ext = ParamsEncryptor.randomString();
		this.createEncryptKey();
	}
	getEncryptKey() {
		if (!this.encryptKey) {throw new ZaloApiError("getEncryptKey: didn't create encryptKey yet");}
		return this.encryptKey;
	}
	createZcid(type, imei, firstLaunchTime) {
		if (!type || !imei || !firstLaunchTime) {throw new ZaloApiError("createZcid: missing params");}
		const msg = `${type},${imei},${firstLaunchTime}`;
		this.zcid = ParamsEncryptor.encodeAES("3FC4F0D2AB50057BCE0D90D9187A22B1", msg, "hex", true);
	}
	createEncryptKey(e = 0) {
		const t = (e, t) => {
			const { even: n } = ParamsEncryptor.processStr(e), { even: a, odd: s } = ParamsEncryptor.processStr(t);
			if (!n || !a || !s) {return !1;}
			return this.encryptKey = n.slice(0, 8).join("") + a.slice(0, 12).join("") + s.toReversed().slice(0, 12).join(""), !0;
		};
		if (!this.zcid || !this.zcid_ext) {throw new ZaloApiError("createEncryptKey: zcid or zcid_ext is null");}
		try {
			if (t(import_crypto_js.default.MD5(this.zcid_ext).toString().toUpperCase(), this.zcid) || !(e < 3)) {return !1;}
			this.createEncryptKey(e + 1);
		} catch (_a) {
			if (e < 3) {this.createEncryptKey(e + 1);}
		}
		return !0;
	}
	getParams() {
		return this.zcid ? {
			zcid: this.zcid,
			zcid_ext: this.zcid_ext,
			enc_ver: this.enc_ver
		} : null;
	}
	static processStr(e) {
		if (!e || "string" != typeof e) {return {
			even: null,
			odd: null
		};}
		const [t, n] = [...e].reduce((e, t, n) => (e[n % 2].push(t), e), [[], []]);
		return {
			even: t,
			odd: n
		};
	}
	static randomString(e, t) {
		const n = e || 6, a = t && e && t > e ? t : 12;
		let s = Math.floor(Math.random() * (a - n + 1)) + n;
		if (s > 12) {
			let e = "";
			for (; s > 0;) {
				e += Math.random().toString(16).substr(2, s > 12 ? 12 : s);
				s -= 12;
			}
			return e;
		}
		return Math.random().toString(16).substr(2, s);
	}
	static encodeAES(e, message, type, uppercase, s = 0) {
		if (!message) {return null;}
		try {
			{
				const encoder = "hex" == type ? import_crypto_js.default.enc.Hex : import_crypto_js.default.enc.Base64;
				const key = import_crypto_js.default.enc.Utf8.parse(e);
				const encrypted = import_crypto_js.default.AES.encrypt(message, key, {
					iv: {
						words: [
							0,
							0,
							0,
							0
						],
						sigBytes: 16
					},
					mode: import_crypto_js.default.mode.CBC,
					padding: import_crypto_js.default.pad.Pkcs7
				}).ciphertext.toString(encoder);
				return uppercase ? encrypted.toUpperCase() : encrypted;
			}
		} catch (_a) {
			return s < 3 ? ParamsEncryptor.encodeAES(e, message, type, uppercase, s + 1) : null;
		}
	}
};
function decryptResp(key, data) {
	let n = null;
	try {
		n = decodeRespAES(key, data);
		return JSON.parse(n);
	} catch (_a) {
		return n;
	}
}
function decodeRespAES(key, data) {
	data = decodeURIComponent(data);
	const parsedKey = import_crypto_js.default.enc.Utf8.parse(key);
	return import_crypto_js.default.AES.decrypt({ ciphertext: import_crypto_js.default.enc.Base64.parse(data) }, parsedKey, {
		iv: {
			words: [
				0,
				0,
				0,
				0
			],
			sigBytes: 16
		},
		mode: import_crypto_js.default.mode.CBC,
		padding: import_crypto_js.default.pad.Pkcs7
	}).toString(import_crypto_js.default.enc.Utf8);
}
function decodeBase64ToBuffer(data) {
	return Buffer.from(data, "base64");
}
function decodeUnit8Array(data) {
	try {
		return new TextDecoder().decode(data);
	} catch (_a) {
		return null;
	}
}
function encodeAES(secretKey, data, t = 0) {
	try {
		const key = import_crypto_js.default.enc.Base64.parse(secretKey);
		return import_crypto_js.default.AES.encrypt(data, key, {
			iv: import_crypto_js.default.enc.Hex.parse("00000000000000000000000000000000"),
			mode: import_crypto_js.default.mode.CBC,
			padding: import_crypto_js.default.pad.Pkcs7
		}).ciphertext.toString(import_crypto_js.default.enc.Base64);
	} catch (_a) {
		return t < 3 ? encodeAES(secretKey, data, t + 1) : null;
	}
}
function decodeAES(secretKey, data, t = 0) {
	try {
		data = decodeURIComponent(data);
		const key = import_crypto_js.default.enc.Base64.parse(secretKey);
		return import_crypto_js.default.AES.decrypt({ ciphertext: import_crypto_js.default.enc.Base64.parse(data) }, key, {
			iv: import_crypto_js.default.enc.Hex.parse("00000000000000000000000000000000"),
			mode: import_crypto_js.default.mode.CBC,
			padding: import_crypto_js.default.pad.Pkcs7
		}).toString(import_crypto_js.default.enc.Utf8);
	} catch (_a) {
		return t < 3 ? decodeAES(secretKey, data, t + 1) : null;
	}
}
async function getDefaultHeaders(ctx, origin = "https://chat.zalo.me") {
	if (!ctx.cookie) {throw new ZaloApiError("Cookie is not available");}
	if (!ctx.userAgent) {throw new ZaloApiError("User agent is not available");}
	return {
		Accept: "application/json, text/plain, */*",
		"Accept-Encoding": "gzip, deflate, br, zstd",
		"Accept-Language": "en-US,en;q=0.9",
		"content-type": "application/x-www-form-urlencoded",
		Cookie: await ctx.cookie.getCookieString(origin),
		Origin: "https://chat.zalo.me",
		Referer: "https://chat.zalo.me/",
		"User-Agent": ctx.userAgent
	};
}
async function request(ctx, url, options, raw = false) {
	var _a, _b;
	if (!ctx.cookie) {ctx.cookie = new import_cookie.CookieJar();}
	const origin = new URL(url).origin;
	const defaultHeaders = await getDefaultHeaders(ctx, origin);
	if (!raw) {if (options) options.headers = Object.assign(defaultHeaders, options.headers || {});
	else options = { headers: defaultHeaders };}
	const _options = Object.assign(Object.assign({}, options !== null && options !== void 0 ? options : {}), isBun ? { proxy: (_b = (_a = ctx.options.agent) === null || _a === void 0 ? void 0 : _a.proxy) === null || _b === void 0 ? void 0 : _b.href } : { agent: ctx.options.agent });
	const response = await ctx.options.polyfill(url, _options);
	const setCookieRaw = response.headers.get("set-cookie");
	if (setCookieRaw && !raw) {
		const splitCookies = setCookieRaw.split(", ");
		for (const cookie of splitCookies) {
			const parsed = import_cookie.Cookie.parse(cookie);
			try {
				if (parsed) {await ctx.cookie.setCookie(parsed, parsed.domain != "zalo.me" ? `https://${parsed.domain}` : origin);}
			} catch (error) {
				logger(ctx).error(error);
			}
		}
	}
	const redirectURL = response.headers.get("location");
	if (redirectURL) {
		const redirectOptions = Object.assign({}, options);
		redirectOptions.method = "GET";
		if (!raw) {
			redirectOptions.headers = new Headers(redirectOptions.headers);
			redirectOptions.headers.set("Referer", "https://id.zalo.me/");
		}
		return await request(ctx, redirectURL, redirectOptions);
	}
	return response;
}
async function getImageMetaData(ctx, filePath) {
	if (!ctx.options.imageMetadataGetter) {throw new ZaloApiMissingImageMetadataGetter();}
	const imageData = await ctx.options.imageMetadataGetter(filePath);
	if (!imageData) {throw new ZaloApiError("Failed to get image metadata");}
	return {
		fileName: filePath.split("/").pop(),
		totalSize: imageData.size,
		width: imageData.width,
		height: imageData.height
	};
}
async function getFileSize(filePath) {
	return fs.promises.stat(filePath).then((s) => s.size);
}
async function getGifMetaData(ctx, filePath) {
	if (!ctx.options.imageMetadataGetter) {throw new ZaloApiMissingImageMetadataGetter();}
	const gifData = await ctx.options.imageMetadataGetter(filePath);
	if (!gifData) {throw new ZaloApiError("Failed to get gif metadata");}
	return {
		fileName: path.basename(filePath),
		totalSize: gifData.size,
		width: gifData.width,
		height: gifData.height
	};
}
async function decodeEventData(parsed, cipherKey) {
	if (typeof parsed.data !== "string") {throw new ZaloApiError(`Invalid data, expected string but got ${typeof parsed.data}`);}
	if (typeof parsed.encrypt !== "number") {throw new ZaloApiError(`Invalid encrypt type, expected number but got ${typeof parsed.encrypt}`);}
	if (parsed.encrypt < 0 || parsed.encrypt > 3) {throw new ZaloApiError(`Invalid encrypt type, expected 0-3 but got ${parsed.encrypt}`);}
	const rawData = parsed.data;
	const encryptType = parsed.encrypt;
	if (encryptType === 0) {return JSON.parse(rawData);}
	const decodedBuffer = decodeBase64ToBuffer(encryptType === 1 ? rawData : decodeURIComponent(rawData));
	let decryptedBuffer = decodedBuffer;
	if (encryptType !== 1) {if (cipherKey && decodedBuffer.length >= 48) {
		const algorithm = {
			name: "AES-GCM",
			iv: decodedBuffer.subarray(0, 16),
			tagLength: 128,
			additionalData: decodedBuffer.subarray(16, 32)
		};
		const dataSource = decodedBuffer.subarray(32);
		const cryptoKey = await crypto$1.subtle.importKey("raw", decodeBase64ToBuffer(cipherKey), algorithm, false, ["decrypt"]);
		decryptedBuffer = await crypto$1.subtle.decrypt(algorithm, cryptoKey, dataSource);
	} else throw new ZaloApiError("Invalid data length or missing cipher key");}
	const decodedData = decodeUnit8Array(encryptType === 3 ? new Uint8Array(decryptedBuffer) : pako.inflate(decryptedBuffer));
	if (!decodedData) {return;}
	return import_json_bigint.default.parse(decodedData);
}
async function getMd5LargeFileObject(source, fileSize) {
	const buffer = typeof source == "string" ? await fs.promises.readFile(source) : source.data;
	return new Promise((resolve) => {
		let currentChunk = 0;
		const chunkSize = 2097152, chunks = Math.ceil(fileSize / chunkSize), spark = new import_spark_md5.default.ArrayBuffer();
		function loadNext() {
			const start = currentChunk * chunkSize, end = start + chunkSize >= fileSize ? fileSize : start + chunkSize;
			spark.append(new Uint8Array(buffer.subarray(start, end)).buffer);
			currentChunk++;
			if (currentChunk < chunks) {loadNext();}
			else {resolve({
				currentChunk,
				data: spark.end()
			});}
		}
		loadNext();
	});
}
const logger = (ctx) => ({
	verbose: (...args) => {
		if (ctx.options.logging) {console.log("\x1B[35m🚀 VERBOSE\x1B[0m", ...args);}
	},
	info: (...args) => {
		if (ctx.options.logging) {console.log("\x1B[34mINFO\x1B[0m", ...args);}
	},
	warn: (...args) => {
		if (ctx.options.logging) {console.log("\x1B[33mWARN\x1B[0m", ...args);}
	},
	error: (...args) => {
		if (ctx.options.logging) {console.log("\x1B[31mERROR\x1B[0m", ...args);}
	},
	success: (...args) => {
		if (ctx.options.logging) {console.log("\x1B[32mSUCCESS\x1B[0m", ...args);}
	},
	timestamp: (...args) => {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		if (ctx.options.logging) {console.log(`\x1b[90m[${now}]\x1b[0m`, ...args);}
	}
});
function getClientMessageType(msgType) {
	if (msgType === "webchat") {return 1;}
	if (msgType === "chat.voice") {return 31;}
	if (msgType === "chat.photo") {return 32;}
	if (msgType === "chat.sticker") {return 36;}
	if (msgType === "chat.doodle") {return 37;}
	if (msgType === "chat.recommended") {return 38;}
	if (msgType === "chat.link") {return 38;}
	if (msgType === "chat.video.msg") {return 44;}
	if (msgType === "share.file") {return 46;}
	if (msgType === "chat.gif") {return 49;}
	if (msgType === "chat.location.new") {return 43;}
	return 1;
}
function strPadLeft(e, t, n) {
	const a = (e = "" + e).length;
	return a === n ? e : a > n ? e.slice(-n) : t.repeat(n - a) + e;
}
function formatTime(format, timestamp = Date.now()) {
	const date = new Date(timestamp);
	const formatted = new Intl.DateTimeFormat("vi-VN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit"
	}).format(date);
	if (format.includes("%H") || format.includes("%d")) {return format.replace("%H", date.getHours().toString().padStart(2, "0")).replace("%M", date.getMinutes().toString().padStart(2, "0")).replace("%S", date.getSeconds().toString().padStart(2, "0")).replace("%d", date.getDate().toString().padStart(2, "0")).replace("%m", (date.getMonth() + 1).toString().padStart(2, "0")).replace("%Y", date.getFullYear().toString());}
	return formatted;
}
function getFullTimeFromMillisecond(e) {
	const t = new Date(e);
	return strPadLeft(t.getHours(), "0", 2) + ":" + strPadLeft(t.getMinutes(), "0", 2) + " " + strPadLeft(t.getDate(), "0", 2) + "/" + strPadLeft(t.getMonth() + 1, "0", 2) + "/" + t.getFullYear();
}
function getFileExtension(e) {
	return path.extname(e).slice(1);
}
function getFileName(e) {
	return path.basename(e);
}
function removeUndefinedKeys(e) {
	for (const t in e) {if (e[t] === void 0) delete e[t];}
	return e;
}
function getGroupEventType(act) {
	if (act == "join_request") {return GroupEventType.JOIN_REQUEST;}
	if (act == "join") {return GroupEventType.JOIN;}
	if (act == "leave") {return GroupEventType.LEAVE;}
	if (act == "remove_member") {return GroupEventType.REMOVE_MEMBER;}
	if (act == "block_member") {return GroupEventType.BLOCK_MEMBER;}
	if (act == "update_setting") {return GroupEventType.UPDATE_SETTING;}
	if (act == "update_avatar") {return GroupEventType.UPDATE_AVATAR;}
	if (act == "update") {return GroupEventType.UPDATE;}
	if (act == "new_link") {return GroupEventType.NEW_LINK;}
	if (act == "add_admin") {return GroupEventType.ADD_ADMIN;}
	if (act == "remove_admin") {return GroupEventType.REMOVE_ADMIN;}
	if (act == "new_pin_topic") {return GroupEventType.NEW_PIN_TOPIC;}
	if (act == "update_pin_topic") {return GroupEventType.UPDATE_PIN_TOPIC;}
	if (act == "update_topic") {return GroupEventType.UPDATE_TOPIC;}
	if (act == "update_board") {return GroupEventType.UPDATE_BOARD;}
	if (act == "remove_board") {return GroupEventType.REMOVE_BOARD;}
	if (act == "reorder_pin_topic") {return GroupEventType.REORDER_PIN_TOPIC;}
	if (act == "unpin_topic") {return GroupEventType.UNPIN_TOPIC;}
	if (act == "remove_topic") {return GroupEventType.REMOVE_TOPIC;}
	if (act == "accept_remind") {return GroupEventType.ACCEPT_REMIND;}
	if (act == "reject_remind") {return GroupEventType.REJECT_REMIND;}
	if (act == "remind_topic") {return GroupEventType.REMIND_TOPIC;}
	return GroupEventType.UNKNOWN;
}
function getFriendEventType(act) {
	if (act == "add") {return FriendEventType.ADD;}
	if (act == "remove") {return FriendEventType.REMOVE;}
	if (act == "block") {return FriendEventType.BLOCK;}
	if (act == "unblock") {return FriendEventType.UNBLOCK;}
	if (act == "block_call") {return FriendEventType.BLOCK_CALL;}
	if (act == "unblock_call") {return FriendEventType.UNBLOCK_CALL;}
	if (act == "req_v2") {return FriendEventType.REQUEST;}
	if (act == "reject") {return FriendEventType.REJECT_REQUEST;}
	if (act == "undo_req") {return FriendEventType.UNDO_REQUEST;}
	if (act == "seen_fr_req") {return FriendEventType.SEEN_FRIEND_REQUEST;}
	if (act == "pin_unpin") {return FriendEventType.PIN_UNPIN;}
	if (act == "pin_create") {return FriendEventType.PIN_CREATE;}
	return FriendEventType.UNKNOWN;
}
async function handleZaloResponse(ctx, response, isEncrypted = true) {
	const result = {
		data: null,
		error: null
	};
	if (!response.ok) {
		result.error = { message: "Request failed with status code " + response.status };
		return result;
	}
	try {
		const jsonData = await response.json();
		if (jsonData.error_code != 0) {
			result.error = {
				message: jsonData.error_message,
				code: jsonData.error_code
			};
			return result;
		}
		const decodedData = isEncrypted ? JSON.parse(decodeAES(ctx.secretKey, jsonData.data)) : jsonData;
		if (decodedData.error_code != 0) {
			result.error = {
				message: decodedData.error_message,
				code: decodedData.error_code
			};
			return result;
		}
		result.data = decodedData.data;
	} catch (error) {
		logger(ctx).error("Failed to parse response data:", error);
		result.error = { message: "Failed to parse response data" };
	}
	return result;
}
async function resolveResponse(ctx, res, cb, isEncrypted) {
	const result = await handleZaloResponse(ctx, res, isEncrypted);
	if (result.error) {throw new ZaloApiError(result.error.message, result.error.code);}
	if (cb) {return cb(result);}
	return result.data;
}
function apiFactory() {
	return (callback) => {
		return (ctx, api) => {
			if (!isContextSession(ctx)) {throw new ZaloApiError("Invalid context " + JSON.stringify(ctx, null, 2));}
			return callback(api, ctx, {
				makeURL(baseURL, params, apiVersion) {
					return makeURL(ctx, baseURL, params, apiVersion);
				},
				encodeAES(data, t) {
					return encodeAES(ctx.secretKey, data, t);
				},
				request(url, options, raw) {
					return request(ctx, url, options, raw);
				},
				logger: logger(ctx),
				resolve: (res, cb, isEncrypted) => resolveResponse(ctx, res, cb, isEncrypted)
			});
		};
	};
}
function generateZaloUUID(userAgent) {
	return crypto$1.randomUUID() + "-" + import_crypto_js.default.MD5(userAgent).toString();
}
/**
* Encrypts a 4-digit PIN to a 32-character hex string
* @param pin 4-digit PIN number
* @returns 32-character hex string
*/
function encryptPin(pin) {
	return crypto$1.createHash("md5").update(pin).digest("hex");
}
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/loginQR.js
var LoginQRCallbackEventType$1;
(function(LoginQRCallbackEventType) {
	LoginQRCallbackEventType[LoginQRCallbackEventType["QRCodeGenerated"] = 0] = "QRCodeGenerated";
	LoginQRCallbackEventType[LoginQRCallbackEventType["QRCodeExpired"] = 1] = "QRCodeExpired";
	LoginQRCallbackEventType[LoginQRCallbackEventType["QRCodeScanned"] = 2] = "QRCodeScanned";
	LoginQRCallbackEventType[LoginQRCallbackEventType["QRCodeDeclined"] = 3] = "QRCodeDeclined";
	LoginQRCallbackEventType[LoginQRCallbackEventType["GotLoginInfo"] = 4] = "GotLoginInfo";
})(LoginQRCallbackEventType$1 || (LoginQRCallbackEventType$1 = {}));
async function loadLoginPage(ctx) {
	const match = (await (await request(ctx, "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F", {
		headers: {
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			"accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			"cache-control": "max-age=0",
			priority: "u=0, i",
			"sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": "\"Windows\"",
			"sec-fetch-dest": "document",
			"sec-fetch-mode": "navigate",
			"sec-fetch-site": "same-site",
			"sec-fetch-user": "?1",
			"upgrade-insecure-requests": "1",
			Referer: "https://chat.zalo.me/",
			"Referrer-Policy": "strict-origin-when-cross-origin"
		},
		method: "GET"
	})).text()).match(/https:\/\/stc-zlogin\.zdn\.vn\/main-([\d.]+)\.js/);
	return match === null || match === void 0 ? void 0 : match[1];
}
async function getLoginInfo(ctx, version) {
	const form = new URLSearchParams();
	form.append("continue", "https://zalo.me/pc");
	form.append("v", version);
	return await request(ctx, "https://id.zalo.me/account/logininfo", {
		headers: {
			accept: "*/*",
			"accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			"content-type": "application/x-www-form-urlencoded",
			priority: "u=1, i",
			"sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": "\"Windows\"",
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			Referer: "https://id.zalo.me/account?continue=https%3A%2F%2Fzalo.me%2Fpc",
			"Referrer-Policy": "strict-origin-when-cross-origin"
		},
		body: form,
		method: "POST"
	}).then((res) => res.json()).catch(logger(ctx).error);
}
async function verifyClient(ctx, version) {
	const form = new URLSearchParams();
	form.append("type", "device");
	form.append("continue", "https://zalo.me/pc");
	form.append("v", version);
	return await request(ctx, "https://id.zalo.me/account/verify-client", {
		headers: {
			accept: "*/*",
			"accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			"content-type": "application/x-www-form-urlencoded",
			priority: "u=1, i",
			"sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": "\"Windows\"",
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			Referer: "https://id.zalo.me/account?continue=https%3A%2F%2Fzalo.me%2Fpc",
			"Referrer-Policy": "strict-origin-when-cross-origin"
		},
		body: form,
		method: "POST"
	}).then((res) => res.json()).catch(logger(ctx).error);
}
async function generate(ctx, version) {
	const form = new URLSearchParams();
	form.append("continue", "https://zalo.me/pc");
	form.append("v", version);
	return await request(ctx, "https://id.zalo.me/account/authen/qr/generate", {
		headers: {
			accept: "*/*",
			"accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			"content-type": "application/x-www-form-urlencoded",
			priority: "u=1, i",
			"sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": "\"Windows\"",
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			Referer: "https://id.zalo.me/account?continue=https%3A%2F%2Fzalo.me%2Fpc",
			"Referrer-Policy": "strict-origin-when-cross-origin"
		},
		body: form,
		method: "POST"
	}).then((res) => res.json()).catch(logger(ctx).error);
}
async function saveQRCodeToFile(filepath, imageData) {
	await writeFile(filepath, imageData, "base64");
}
async function waitingScan(ctx, version, code, signal) {
	const form = new URLSearchParams();
	form.append("code", code);
	form.append("continue", "https://chat.zalo.me/");
	form.append("v", version);
	return await request(ctx, "https://id.zalo.me/account/authen/qr/waiting-scan", {
		headers: {
			accept: "*/*",
			"accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			"content-type": "application/x-www-form-urlencoded",
			priority: "u=1, i",
			"sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": "\"Windows\"",
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			Referer: "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
			"Referrer-Policy": "strict-origin-when-cross-origin"
		},
		body: form,
		method: "POST",
		signal
	}).then((res) => res.json()).then((data) => {
		if (data.error_code == 8) {return waitingScan(ctx, version, code, signal);}
		return data;
	}).catch((e) => {
		if (!signal.aborted) {logger(ctx).error(e);}
	});
}
async function waitingConfirm(ctx, version, code, signal) {
	const form = new URLSearchParams();
	form.append("code", code);
	form.append("gToken", "");
	form.append("gAction", "CONFIRM_QR");
	form.append("continue", "https://chat.zalo.me/");
	form.append("v", version);
	logger(ctx).info("Please confirm on your phone");
	return await request(ctx, "https://id.zalo.me/account/authen/qr/waiting-confirm", {
		headers: {
			accept: "*/*",
			"accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			"content-type": "application/x-www-form-urlencoded",
			priority: "u=1, i",
			"sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": "\"Windows\"",
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			Referer: "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
			"Referrer-Policy": "strict-origin-when-cross-origin"
		},
		body: form,
		method: "POST",
		signal
	}).then((res) => res.json()).then((data) => {
		if (data.error_code == 8) {return waitingConfirm(ctx, version, code, signal);}
		return data;
	}).catch((e) => {
		if (!signal.aborted) {logger(ctx).error(e);}
	});
}
async function checkSession(ctx) {
	return await request(ctx, "https://id.zalo.me/account/checksession?continue=https%3A%2F%2Fchat.zalo.me%2Findex.html", {
		headers: {
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			"accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			priority: "u=0, i",
			"sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": "\"Windows\"",
			"sec-fetch-dest": "document",
			"sec-fetch-mode": "navigate",
			"sec-fetch-site": "same-origin",
			"upgrade-insecure-requests": "1",
			Referer: "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F",
			"Referrer-Policy": "strict-origin-when-cross-origin"
		},
		redirect: "manual",
		method: "GET"
	}).catch(logger(ctx).error);
}
async function getUserInfo(ctx) {
	return await request(ctx, "https://jr.chat.zalo.me/jr/userinfo", {
		headers: {
			accept: "*/*",
			"accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
			priority: "u=1, i",
			"sec-ch-ua": "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\", \"Not?A_Brand\";v=\"99\"",
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": "\"Windows\"",
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-site",
			Referer: "https://chat.zalo.me/",
			"Referrer-Policy": "strict-origin-when-cross-origin"
		},
		method: "GET"
	}).then((res) => res.json()).catch(logger(ctx).error);
}
async function loginQR(ctx, options, callback) {
	ctx.cookie = new import_cookie.CookieJar();
	ctx.userAgent = options.userAgent;
	return new Promise(async (resolve, reject) => {
		var _a;
		const controller = new AbortController();
		let qrTimeout = null;
		function cleanUp() {
			controller.abort();
			if (qrTimeout) {
				clearTimeout(qrTimeout);
				qrTimeout = null;
			}
		}
		try {
			function retry() {
				cleanUp();
				return resolve(loginQR(ctx, options, callback));
			}
			function abort() {
				cleanUp();
				return reject(new ZaloApiLoginQRAborted());
			}
			if (ctx.options.logging) {console.log();}
			const loginVersion = await loadLoginPage(ctx);
			if (!loginVersion) {throw new ZaloApiError("Cannot get API login version");}
			logger(ctx).info("Got login version:", loginVersion);
			await getLoginInfo(ctx, loginVersion);
			await verifyClient(ctx, loginVersion);
			const qrGenResult = await generate(ctx, loginVersion);
			if (!qrGenResult || !qrGenResult.data) {throw new ZaloApiError(`Unable to generate QRCode\nResponse: ${JSON.stringify(qrGenResult, null, 2)}`);}
			const qrData = qrGenResult.data;
			if (callback) {callback({
				type: LoginQRCallbackEventType$1.QRCodeGenerated,
				data: Object.assign(Object.assign({}, qrGenResult.data), { image: qrGenResult.data.image.replace(/^data:image\/png;base64,/, "") }),
				actions: {
					async saveToFile(qrPath) {
						var _a;
						if (qrPath === void 0) qrPath = (_a = options.qrPath) !== null && _a !== void 0 ? _a : "qr.png";
						await saveQRCodeToFile(qrPath, qrData.image.replace(/^data:image\/png;base64,/, ""));
						logger(ctx).info("Scan the QR code at", `'${qrPath}'`, "to proceed with login");
					},
					retry,
					abort
				}
			});}
			else {
				const qrPath = (_a = options.qrPath) !== null && _a !== void 0 ? _a : "qr.png";
				await saveQRCodeToFile(qrPath, qrData.image.replace(/^data:image\/png;base64,/, ""));
				logger(ctx).info("Scan the QR code at", `'${qrPath}'`, "to proceed with login");
			}
			qrTimeout = setTimeout(() => {
				cleanUp();
				logger(ctx).info("QR expired!");
				if (callback) {callback({
					type: LoginQRCallbackEventType$1.QRCodeExpired,
					data: null,
					actions: {
						retry,
						abort
					}
				});}
				else {retry();}
			}, 1e5);
			const scanResult = await waitingScan(ctx, loginVersion, qrGenResult.data.code, controller.signal);
			if (!scanResult || !scanResult.data) {throw new ZaloApiError("Cannot get scan result");}
			if (callback) {callback({
				type: LoginQRCallbackEventType$1.QRCodeScanned,
				data: scanResult.data,
				actions: {
					retry,
					abort
				}
			});}
			const confirmResult = await waitingConfirm(ctx, loginVersion, qrGenResult.data.code, controller.signal);
			if (!confirmResult) {throw new ZaloApiError("Cannot get confirm result");}
			clearTimeout(qrTimeout);
			if (confirmResult.error_code == -13) {
				if (callback) {callback({
					type: LoginQRCallbackEventType$1.QRCodeDeclined,
					data: { code: qrData.code },
					actions: {
						retry,
						abort
					}
				});}
				else {
					logger(ctx).error("QRCode login declined");
					throw new ZaloApiLoginQRDeclined();
				}
				return;
			} else if (confirmResult.error_code != 0) {throw new ZaloApiError(`An error has occurred.\nResponse: ${JSON.stringify(confirmResult, null, 2)}`);}
			if (!await checkSession(ctx)) {throw new ZaloApiError("Cannot get session, login failed");}
			logger(ctx).info("Successfully logged into the account", scanResult.data.display_name);
			const userInfo = await getUserInfo(ctx);
			if (!userInfo || !userInfo.data) {throw new ZaloApiError("Can't get account info");}
			if (!userInfo.data.logged) {throw new ZaloApiError("Can't login");}
			resolve({
				cookies: ctx.cookie.toJSON().cookies,
				userInfo: userInfo.data.info
			});
		} catch (error) {
			cleanUp();
			reject(error);
		}
	});
}
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/login.js
async function login(ctx, encryptParams) {
	const encryptedParams = await getEncryptParam(ctx, encryptParams, "getlogininfo");
	try {
		const response = await request(ctx, makeURL(ctx, "https://wpa.chat.zalo.me/api/login/getLoginInfo", Object.assign(Object.assign({}, encryptedParams.params), { nretry: 0 })));
		if (!response.ok) {throw new ZaloApiError("Failed to fetch login info: " + response.statusText);}
		const data = await response.json();
		if (encryptedParams.enk) {
			const decryptedData = decryptResp(encryptedParams.enk, data.data);
			return decryptedData != null && typeof decryptedData != "string" ? decryptedData : null;
		}
		return null;
	} catch (error) {
		logger(ctx).error("Login failed:", error);
		throw error;
	}
}
async function getServerInfo(ctx, encryptParams) {
	const encryptedParams = await getEncryptParam(ctx, encryptParams, "getserverinfo");
	if (!encryptedParams.params.signkey || typeof encryptedParams.params.signkey !== "string") {throw new ZaloApiError("Missing signkey");}
	const response = await request(ctx, makeURL(ctx, "https://wpa.chat.zalo.me/api/login/getServerInfo", {
		imei: ctx.imei,
		type: ctx.API_TYPE,
		client_version: ctx.API_VERSION,
		computer_name: "Web",
		signkey: encryptedParams.params.signkey
	}, false));
	if (!response.ok) {throw new ZaloApiError("Failed to fetch server info: " + response.statusText);}
	const data = await response.json();
	if (data.data == null) {throw new ZaloApiError("Failed to fetch server info: " + data.error_message);}
	return data.data;
}
async function getEncryptParam(ctx, encryptParams, type) {
	const params = {};
	const data = {
		computer_name: "Web",
		imei: ctx.imei,
		language: ctx.language,
		ts: Date.now()
	};
	const encryptedData = await _encryptParam(ctx, data, encryptParams);
	if (encryptedData == null) {Object.assign(params, data);}
	else {
		const { encrypted_params, encrypted_data } = encryptedData;
		Object.assign(params, encrypted_params);
		params.params = encrypted_data;
	}
	params.type = ctx.API_TYPE;
	params.client_version = ctx.API_VERSION;
	params.signkey = type == "getserverinfo" ? getSignKey(type, {
		imei: ctx.imei,
		type: ctx.API_TYPE,
		client_version: ctx.API_VERSION,
		computer_name: "Web"
	}) : getSignKey(type, params);
	return {
		params,
		enk: encryptedData ? encryptedData.enk : null
	};
}
async function _encryptParam(ctx, data, encryptParams) {
	if (encryptParams) {
		const encryptor = new ParamsEncryptor({
			type: ctx.API_TYPE,
			imei: data.imei,
			firstLaunchTime: Date.now()
		});
		try {
			const stringifiedData = JSON.stringify(data);
			const encryptedKey = encryptor.getEncryptKey();
			const encodedData = ParamsEncryptor.encodeAES(encryptedKey, stringifiedData, "base64", false);
			const params = encryptor.getParams();
			return params ? {
				encrypted_data: encodedData,
				encrypted_params: params,
				enk: encryptedKey
			} : null;
		} catch (error) {
			throw new ZaloApiError("Failed to encrypt params: " + error);
		}
	}
	return null;
}
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/update.js
var import_semver = require_semver();
const VERSION = "2.1.1";
const NPM_REGISTRY = "https://registry.npmjs.org/zca-js";
async function checkUpdate(ctx) {
	var _a, _b;
	if (!ctx.options.checkUpdate) {return;}
	const _options = Object.assign({}, isBun ? { proxy: (_b = (_a = ctx.options.agent) === null || _a === void 0 ? void 0 : _a.proxy) === null || _b === void 0 ? void 0 : _b.href } : { agent: ctx.options.agent });
	const response = await ctx.options.polyfill(NPM_REGISTRY, _options).catch(() => null);
	if (!response || !response.ok) {return;}
	const data = await response.json().catch(() => null);
	if (!data) {return;}
	const latestVersion = data["dist-tags"].latest;
	if ((0, import_semver.compare)(VERSION, latestVersion) === -1) {logger(ctx).info(`A new version of zca-js is available: ${latestVersion}`);}
	else {logger(ctx).info("zca-js is up to date");}
}
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/listen.js
var CloseReason;
(function(CloseReason) {
	CloseReason[CloseReason["ManualClosure"] = 1e3] = "ManualClosure";
	CloseReason[CloseReason["AbnormalClosure"] = 1006] = "AbnormalClosure";
	CloseReason[CloseReason["DuplicateConnection"] = 3e3] = "DuplicateConnection";
	CloseReason[CloseReason["KickConnection"] = 3003] = "KickConnection";
})(CloseReason || (CloseReason = {}));
var Listener = class extends EventEmitter {
	constructor(ctx, urls) {
		super();
		this.ctx = ctx;
		this.urls = urls;
		this.id = 0;
		if (!ctx.cookie) {throw new ZaloApiError("Cookie is not available");}
		if (!ctx.userAgent) {throw new ZaloApiError("User agent is not available");}
		this.wsURL = makeURL(this.ctx, this.urls[0], { t: Date.now() });
		this.retryCount = {};
		this.rotateCount = 0;
		for (const retry in ctx.settings.features.socket.retries) {
			const { times, max } = ctx.settings.features.socket.retries[retry];
			this.retryCount[retry] = {
				count: 0,
				max: max || 0,
				times: typeof times === "number" ? [times] : times
			};
		}
		this.cookie = ctx.cookie.getCookieStringSync("https://chat.zalo.me");
		this.userAgent = ctx.userAgent;
		this.selfListen = ctx.options.selfListen;
		this.ws = null;
		this.onConnectedCallback = () => {};
		this.onClosedCallback = () => {};
		this.onErrorCallback = () => {};
		this.onMessageCallback = () => {};
	}
	/**
	* @deprecated Use `on` method instead
	*/
	onConnected(cb) {
		this.onConnectedCallback = cb;
	}
	/**
	* @deprecated Use `on` method instead
	*/
	onClosed(cb) {
		this.onClosedCallback = cb;
	}
	/**
	* @deprecated Use `on` method instead
	*/
	onError(cb) {
		this.onErrorCallback = cb;
	}
	/**
	* @deprecated Use `on` method instead
	*/
	onMessage(cb) {
		this.onMessageCallback = cb;
	}
	canRetry(code) {
		if (!this.ctx.settings.features.socket.close_and_retry_codes.includes(code)) {return false;}
		if (this.retryCount[code.toString()].count >= this.retryCount[code.toString()].max) {return false;}
		this.retryCount[code.toString()].count++;
		const { count, max, times } = this.retryCount[code.toString()];
		const retryTime = count - 1 < times.length ? times[count - 1] : times[times.length - 1];
		logger(this.ctx).verbose(`Retry for code ${code} in ${retryTime}ms (${count}/${max})`);
		return retryTime;
	}
	shouldRotate(code) {
		if (!this.ctx.settings.features.socket.rotate_error_codes.includes(code)) {return false;}
		if (this.rotateCount >= this.urls.length - 1) {return false;}
		return true;
	}
	rotateEndpoint() {
		this.rotateCount++;
		this.wsURL = makeURL(this.ctx, this.urls[this.rotateCount], { t: Date.now() });
		logger(this.ctx).verbose(`Rotating endpoint to ${this.wsURL}`);
	}
	start({ retryOnClose = false } = {}) {
		if (this.ws) {throw new ZaloApiError("Already started");}
		const ws = new WebSocket$1(this.wsURL, {
			headers: {
				"accept-encoding": "gzip, deflate, br, zstd",
				"accept-language": "en-US,en;q=0.9",
				"cache-control": "no-cache",
				connection: "Upgrade",
				host: new URL(this.wsURL).host,
				origin: "https://chat.zalo.me",
				prgama: "no-cache",
				"sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
				"sec-websocket-version": "13",
				upgrade: "websocket",
				"user-agent": this.userAgent,
				cookie: this.cookie
			},
			agent: this.ctx.options.agent
		});
		this.ws = ws;
		ws.onopen = () => {
			this.onConnectedCallback();
			this.emit("connected");
		};
		ws.onclose = (event) => {
			this.reset();
			this.emit("disconnected", event.code, event.reason);
			const retry = retryOnClose && this.canRetry(event.code);
			if (retry && retryOnClose) {
				if (this.shouldRotate(event.code)) {this.rotateEndpoint();}
				setTimeout(() => {
					this.start({ retryOnClose: true });
				}, retry);
			} else {
				this.onClosedCallback(event.code, event.reason);
				this.emit("closed", event.code, event.reason);
			}
		};
		ws.onerror = (event) => {
			this.onErrorCallback(event);
			this.emit("error", event);
		};
		ws.onmessage = async (event) => {
			const { data } = event;
			if (!(data instanceof Buffer)) {return;}
			const [version, cmd, subCmd] = getHeader(data.subarray(0, 4));
			try {
				const dataToDecode = data.subarray(4);
				const decodedData = new TextDecoder("utf-8").decode(dataToDecode);
				if (decodedData.length == 0) {return;}
				const parsed = JSON.parse(decodedData);
				if (version == 1 && cmd == 1 && subCmd == 1 && hasOwn(parsed, "key")) {
					this.cipherKey = parsed.key;
					this.emit("cipher_key", parsed.key);
					if (this.pingInterval) {clearInterval(this.pingInterval);}
					const ping = () => {
						const payload = {
							version: 1,
							cmd: 2,
							subCmd: 1,
							data: { eventId: Date.now() }
						};
						this.sendWs(payload, false);
					};
					this.pingInterval = setInterval(() => {
						ping();
					}, this.ctx.settings.features.socket.ping_interval);
				}
				if (version == 1 && cmd == 501 && subCmd == 0) {
					const { msgs } = (await decodeEventData(parsed, this.cipherKey)).data;
					for (const msg of msgs) {if (typeof msg.content == "object" && hasOwn(msg.content, "deleteMsg")) {
						const undoObject = new Undo(this.ctx.uid, msg, false);
						if (undoObject.isSelf && !this.selfListen) continue;
						this.emit("undo", undoObject);
					} else {
						const messageObject = new UserMessage(this.ctx.uid, msg);
						if (messageObject.isSelf && !this.selfListen) continue;
						this.onMessageCallback(messageObject);
						this.emit("message", messageObject);
					}}
				}
				if (version == 1 && cmd == 521 && subCmd == 0) {
					const { groupMsgs } = (await decodeEventData(parsed, this.cipherKey)).data;
					for (const msg of groupMsgs) {if (typeof msg.content == "object" && hasOwn(msg.content, "deleteMsg")) {
						const undoObject = new Undo(this.ctx.uid, msg, true);
						if (undoObject.isSelf && !this.selfListen) continue;
						this.emit("undo", undoObject);
					} else {
						const messageObject = new GroupMessage(this.ctx.uid, msg);
						if (messageObject.isSelf && !this.selfListen) continue;
						this.onMessageCallback(messageObject);
						this.emit("message", messageObject);
					}}
				}
				if (version == 1 && cmd == 601 && subCmd == 0) {
					const { controls } = (await decodeEventData(parsed, this.cipherKey)).data;
					for (const control of controls) {if (control.content.act_type == "file_done") {
						const data = {
							fileUrl: control.content.data.url,
							fileId: control.content.fileId
						};
						const uploadCallback = this.ctx.uploadCallbacks.get(String(control.content.fileId));
						if (uploadCallback) uploadCallback(data);
						this.ctx.uploadCallbacks.delete(String(control.content.fileId));
						this.emit("upload_attachment", data);
					} else if (control.content.act_type == "group") {
						if (control.content.act == "join_reject") continue;
						const groupEventData = typeof control.content.data == "string" ? JSON.parse(control.content.data) : control.content.data;
						const groupEvent = initializeGroupEvent(this.ctx.uid, groupEventData, getGroupEventType(control.content.act), control.content.act);
						if (groupEvent.isSelf && !this.selfListen) continue;
						this.emit("group_event", groupEvent);
					} else if (control.content.act_type == "fr") {
						if (control.content.act == "req") continue;
						const friendEventData = typeof control.content.data == "string" ? JSON.parse(control.content.data) : control.content.data;
						if (typeof friendEventData == "object" && "topic" in friendEventData && typeof friendEventData.topic == "object" && "params" in friendEventData.topic) friendEventData.topic.params = JSON.parse(`${friendEventData.topic.params}`);
						const friendEvent = initializeFriendEvent(this.ctx.uid, typeof friendEventData == "number" ? control.content.data : friendEventData, getFriendEventType(control.content.act));
						if (friendEvent.isSelf && !this.selfListen) continue;
						this.emit("friend_event", friendEvent);
					}}
				}
				if (cmd == 612) {
					const { reacts, reactGroups } = (await decodeEventData(parsed, this.cipherKey)).data;
					for (const react of reacts) {
						react.content = JSON.parse(react.content);
						const reactionObject = new Reaction(this.ctx.uid, react, false);
						if (reactionObject.isSelf && !this.selfListen) {continue;}
						this.emit("reaction", reactionObject);
					}
					for (const reactGroup of reactGroups) {
						reactGroup.content = JSON.parse(reactGroup.content);
						const reactionObject = new Reaction(this.ctx.uid, reactGroup, true);
						if (reactionObject.isSelf && !this.selfListen) {continue;}
						this.emit("reaction", reactionObject);
					}
				}
				if (cmd == 610 || cmd == 611) {
					const parsedData = (await decodeEventData(parsed, this.cipherKey)).data;
					const isGroup = cmd == 611;
					const reactionObjects = parsedData[isGroup ? "reactGroups" : "reacts"].map((react) => new Reaction(this.ctx.uid, react, isGroup));
					this.emit("old_reactions", reactionObjects, isGroup);
				}
				if (cmd == 510 && subCmd == 1) {
					const responseMsgs = (await decodeEventData(parsed, this.cipherKey)).data.msgs.map((msg) => new UserMessage(this.ctx.uid, msg));
					this.emit("old_messages", responseMsgs, ThreadType$1.User);
				}
				if (cmd == 511 && subCmd == 1) {
					const responseMsgs = (await decodeEventData(parsed, this.cipherKey)).data.groupMsgs.map((msg) => new GroupMessage(this.ctx.uid, msg));
					this.emit("old_messages", responseMsgs, ThreadType$1.Group);
				}
				if (cmd == 602 && subCmd == 0) {
					const { actions } = (await decodeEventData(parsed, this.cipherKey)).data;
					for (const action of actions) {if (action.act_type == "typing") {
						const data = JSON.parse(`{${action.data}}`);
						if (action.act == "typing") {
							const typingObject = new UserTyping(data);
							this.emit("typing", typingObject);
						} else if (action.act == "gtyping") {
							const typingObject = new GroupTyping(data);
							this.emit("typing", typingObject);
						}
					}}
				}
				if (cmd == 502 && subCmd == 0) {
					const { delivereds: deliveredMsgs, seens: seenMsgs } = (await decodeEventData(parsed, this.cipherKey)).data;
					if (Array.isArray(deliveredMsgs) && deliveredMsgs.length > 0) {
						const deliveredObjects = deliveredMsgs.map((delivered) => new UserDeliveredMessage(delivered));
						this.emit("delivered_messages", deliveredObjects);
					}
					if (Array.isArray(seenMsgs) && seenMsgs.length > 0) {
						const seenObjects = seenMsgs.map((seen) => new UserSeenMessage(seen));
						this.emit("seen_messages", seenObjects);
					}
				}
				if (cmd == 522 && subCmd == 0) {
					const { delivereds: deliveredMsgs, groupSeens: groupSeenMsgs } = (await decodeEventData(parsed, this.cipherKey)).data;
					if (Array.isArray(deliveredMsgs) && deliveredMsgs.length > 0) {
						let deliveredObjects = deliveredMsgs.map((delivered) => new GroupDeliveredMessage(this.ctx.uid, delivered));
						if (!this.selfListen) {deliveredObjects = deliveredObjects.filter((delivered) => !delivered.isSelf);}
						this.emit("delivered_messages", deliveredObjects);
					}
					if (Array.isArray(groupSeenMsgs) && groupSeenMsgs.length > 0) {
						let seenObjects = groupSeenMsgs.map((seen) => new GroupSeenMessage(this.ctx.uid, seen));
						if (!this.selfListen) {seenObjects = seenObjects.filter((seen) => !seen.isSelf);}
						this.emit("seen_messages", seenObjects);
					}
				}
				if (version == 1 && cmd == 3e3 && subCmd == 0) {
					logger(this.ctx).error();
					logger(this.ctx).error("Another connection is opened, closing this one");
					logger(this.ctx).error();
					if (ws.readyState !== WebSocket$1.CLOSED) {ws.close(CloseReason.DuplicateConnection);}
				}
			} catch (error) {
				this.onErrorCallback(error);
				this.emit("error", error);
			}
		};
	}
	stop() {
		if (this.ws) {
			this.ws.close(CloseReason.ManualClosure);
			this.reset();
		}
	}
	sendWs(payload, requireId = true) {
		if (this.ws) {
			if (requireId) {payload.data["req_id"] = `req_${this.id++}`;}
			const encodedData = new TextEncoder().encode(JSON.stringify(payload.data));
			const dataLength = encodedData.length;
			const data = new DataView(Buffer.alloc(4 + dataLength).buffer);
			data.setUint8(0, payload.version);
			data.setInt32(1, payload.cmd, true);
			data.setInt8(3, payload.subCmd);
			encodedData.forEach((e, i) => {
				data.setUint8(4 + i, e);
			});
			this.ws.send(data);
		}
	}
	/**
	* Request old messages
	*
	* @param lastMsgId
	*/
	requestOldMessages(threadType, lastMsgId = null) {
		const payload = {
			version: 1,
			cmd: threadType === ThreadType$1.User ? 510 : 511,
			subCmd: 1,
			data: {
				first: true,
				lastId: lastMsgId,
				preIds: []
			}
		};
		this.sendWs(payload);
	}
	/**
	* Request old messages
	*
	* @param lastMsgId
	*/
	requestOldReactions(threadType, lastMsgId = null) {
		const payload = {
			version: 1,
			cmd: threadType === ThreadType$1.User ? 610 : 611,
			subCmd: 1,
			data: {
				first: true,
				lastId: lastMsgId,
				preIds: []
			}
		};
		this.sendWs(payload);
	}
	reset() {
		this.ws = null;
		this.cipherKey = void 0;
		if (this.pingInterval) {clearInterval(this.pingInterval);}
	}
};
function getHeader(buffer) {
	if (buffer.byteLength < 4) {throw new ZaloApiError("Invalid header");}
	return [
		buffer[0],
		buffer.readUInt16LE(1),
		buffer[3]
	];
}
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/acceptFriendRequest.js
const acceptFriendRequestFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/accept`);
	/**
	* Accept a friend request from a User
	*
	* @param friendId The friend ID to user request is accept
	*
	* @throws {ZaloApiError}
	*/
	return async function acceptFriendRequest(friendId) {
		const params = {
			fid: friendId,
			language: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/addGroupBlockedMember.js
const addGroupBlockedMemberFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/blockedmems/add`);
	/**
	* Add group blocked member
	*
	* @param memberId member id(s)
	* @param groupId group id
	*
	* @throws {ZaloApiError}
	*/
	return async function addGroupBlockedMember(memberId, groupId) {
		if (!Array.isArray(memberId)) {memberId = [memberId];}
		const params = {
			grid: groupId,
			members: memberId
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/addGroupDeputy.js
const addGroupDeputyFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/admins/add`);
	/**
	* Add group deputy
	*
	* @param memberId user Id or list of user Ids
	* @param groupId group Id
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function addGroupDeputy(memberId, groupId) {
		if (!Array.isArray(memberId)) {memberId = [memberId];}
		const params = {
			grid: groupId,
			members: memberId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/addPollOptions.js
const addPollOptionsFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/poll/option/add`);
	/**
	* Add new option to poll
	*
	* @param payload
	*
	* @throws {ZaloApiError}
	*/
	return async function addPollOptions(payload) {
		const params = {
			poll_id: payload.pollId,
			new_options: JSON.stringify(payload.options),
			voted_option_ids: payload.votedOptionIds
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/addQuickMessage.js
const addQuickMessageFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.quick_message[0]}/api/quickmessage/create`);
	/**
	* Add quick message
	*
	* @param addPayload - The payload containing data to add the quick message
	*
	* @note Zalo might throw an error with code 821 if you have reached the limit of quick messages.
	*
	* @throws {ZaloApiError}
	*/
	return async function addQuickMessage(addPayload) {
		const isType = !addPayload.media ? 0 : 1;
		const params = {
			keyword: addPayload.keyword,
			message: {
				title: addPayload.title,
				params: ""
			},
			type: isType,
			imei: ctx.imei
		};
		if (isType === 1) {
			if (!addPayload.media) {throw new ZaloApiError("Media is required");}
			const uploadMedia = await api.uploadProductPhoto({ file: addPayload.media });
			const photoId = uploadMedia.photoId;
			const thumbUrl = uploadMedia.thumbUrl;
			const normalUrl = uploadMedia.normalUrl;
			const hdUrl = uploadMedia.hdUrl;
			params.media = { items: [{
				type: 0,
				photoId,
				title: "",
				width: "",
				height: "",
				previewThumb: thumbUrl,
				rawUrl: normalUrl || hdUrl,
				thumbUrl,
				normalUrl: normalUrl || hdUrl,
				hdUrl: hdUrl || normalUrl
			}] };
		}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/addReaction.js
const addReactionFactory = apiFactory()((api, ctx, utils) => {
	const serviceURLs = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.reaction[0]}/api/message/reaction`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.reaction[0]}/api/group/reaction`)
	};
	/**
	* Add reaction to a message
	*
	* @param icon Reaction icon
	* @param dest Destination data including message IDs and thread information
	*
	* @throws {ZaloApiError}
	*/
	return async function addReaction(icon, dest) {
		const serviceURL = serviceURLs[dest.type];
		let rType, source;
		if (typeof icon == "object") {
			rType = icon.rType;
			source = icon.source;
		} else {switch (icon) {
			case Reactions$1.HAHA:
				rType = 0;
				source = 6;
				break;
			case Reactions$1.LIKE:
				rType = 3;
				source = 6;
				break;
			case Reactions$1.HEART:
				rType = 5;
				source = 6;
				break;
			case Reactions$1.WOW:
				rType = 32;
				source = 6;
				break;
			case Reactions$1.CRY:
				rType = 2;
				source = 6;
				break;
			case Reactions$1.ANGRY:
				rType = 20;
				source = 6;
				break;
			case Reactions$1.KISS:
				rType = 8;
				source = 6;
				break;
			case Reactions$1.TEARS_OF_JOY:
				rType = 7;
				source = 6;
				break;
			case Reactions$1.SHIT:
				rType = 66;
				source = 6;
				break;
			case Reactions$1.ROSE:
				rType = 120;
				source = 6;
				break;
			case Reactions$1.BROKEN_HEART:
				rType = 65;
				source = 6;
				break;
			case Reactions$1.DISLIKE:
				rType = 4;
				source = 6;
				break;
			case Reactions$1.LOVE:
				rType = 29;
				source = 6;
				break;
			case Reactions$1.CONFUSED:
				rType = 51;
				source = 6;
				break;
			case Reactions$1.WINK:
				rType = 45;
				source = 6;
				break;
			case Reactions$1.FADE:
				rType = 121;
				source = 6;
				break;
			case Reactions$1.SUN:
				rType = 67;
				source = 6;
				break;
			case Reactions$1.BIRTHDAY:
				rType = 126;
				source = 6;
				break;
			case Reactions$1.BOMB:
				rType = 127;
				source = 6;
				break;
			case Reactions$1.OK:
				rType = 68;
				source = 6;
				break;
			case Reactions$1.PEACE:
				rType = 69;
				source = 6;
				break;
			case Reactions$1.THANKS:
				rType = 70;
				source = 6;
				break;
			case Reactions$1.PUNCH:
				rType = 71;
				source = 6;
				break;
			case Reactions$1.SHARE:
				rType = 72;
				source = 6;
				break;
			case Reactions$1.PRAY:
				rType = 73;
				source = 6;
				break;
			case Reactions$1.NO:
				rType = 131;
				source = 6;
				break;
			case Reactions$1.BAD:
				rType = 132;
				source = 6;
				break;
			case Reactions$1.LOVE_YOU:
				rType = 133;
				source = 6;
				break;
			case Reactions$1.SAD:
				rType = 1;
				source = 6;
				break;
			case Reactions$1.VERY_SAD:
				rType = 16;
				source = 6;
				break;
			case Reactions$1.COOL:
				rType = 21;
				source = 6;
				break;
			case Reactions$1.NERD:
				rType = 22;
				source = 6;
				break;
			case Reactions$1.BIG_SMILE:
				rType = 23;
				source = 6;
				break;
			case Reactions$1.SUNGLASSES:
				rType = 26;
				source = 6;
				break;
			case Reactions$1.NEUTRAL:
				rType = 30;
				source = 6;
				break;
			case Reactions$1.SAD_FACE:
				rType = 35;
				source = 6;
				break;
			case Reactions$1.BYE:
				rType = 36;
				source = 6;
				break;
			case Reactions$1.SLEEPY:
				rType = 38;
				source = 6;
				break;
			case Reactions$1.WIPE:
				rType = 39;
				source = 6;
				break;
			case Reactions$1.DIG:
				rType = 42;
				source = 6;
				break;
			case Reactions$1.ANGUISH:
				rType = 44;
				source = 6;
				break;
			case Reactions$1.HANDCLAP:
				rType = 46;
				source = 6;
				break;
			case Reactions$1.ANGRY_FACE:
				rType = 47;
				source = 6;
				break;
			case Reactions$1.F_CHAIR:
				rType = 48;
				source = 6;
				break;
			case Reactions$1.L_CHAIR:
				rType = 49;
				source = 6;
				break;
			case Reactions$1.R_CHAIR:
				rType = 50;
				source = 6;
				break;
			case Reactions$1.SILENT:
				rType = 52;
				source = 6;
				break;
			case Reactions$1.SURPRISE:
				rType = 53;
				source = 6;
				break;
			case Reactions$1.EMBARRASSED:
				rType = 54;
				source = 6;
				break;
			case Reactions$1.AFRAID:
				rType = 60;
				source = 6;
				break;
			case Reactions$1.SAD2:
				rType = 61;
				source = 6;
				break;
			case Reactions$1.BIG_LAUGH:
				rType = 62;
				source = 6;
				break;
			case Reactions$1.RICH:
				rType = 63;
				source = 6;
				break;
			case Reactions$1.BEER:
				rType = 99;
				source = 6;
				break;
			default:
				rType = -1;
				source = 6;
		}}
		const rIcon = typeof icon == "object" ? icon.icon : icon;
		if (rType == void 0 || source == void 0 || rIcon == void 0) {throw new ZaloApiError("Invalid reaction");}
		const params = { react_list: [{
			message: JSON.stringify({
				rMsg: [{
					gMsgID: parseInt(dest.data.msgId),
					cMsgID: parseInt(dest.data.cliMsgId),
					msgType: 1
				}],
				rIcon,
				rType,
				source
			}),
			clientId: Date.now()
		}] };
		if (dest.type == ThreadType$1.User) {params.toid = dest.threadId;}
		else {
			params.grid = dest.threadId;
			params.imei = ctx.imei;
		}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response, (result) => {
			if (typeof result.data.msgIds === "string") {return { msgIds: JSON.parse(result.data.msgIds) };}
			return result.data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/addUnreadMark.js
const addUnreadMarkFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/conv/addUnreadMark`);
	/**
	* Add unread mark to conversation
	*
	* @param threadId Thread ID
	* @param type Thread type (User/Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function addUnreadMark(threadId, type = ThreadType$1.User) {
		const timestamp = Date.now();
		const timestampString = timestamp.toString();
		const isGroup = type === ThreadType$1.Group;
		const requestParams = { param: JSON.stringify({
			[isGroup ? "convsGroup" : "convsUser"]: [{
				id: threadId,
				cliMsgId: timestampString,
				fromUid: "0",
				ts: timestamp
			}],
			[isGroup ? "convsUser" : "convsGroup"]: [],
			imei: ctx.imei
		}) };
		const encryptedParams = utils.encodeAES(JSON.stringify(requestParams));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response, (result) => {
			const data = result.data;
			if (typeof data.data === "string") {return {
				data: JSON.parse(data.data),
				status: data.status
			};}
			return result.data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/addUserToGroup.js
const addUserToGroupFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/invite/v2`);
	/**
	* Add user to existing group
	*
	* @param memberId User ID or list of user IDs to add
	* @param groupId Group ID
	*
	* @throws {ZaloApiError}
	*/
	return async function addUserToGroup(memberId, groupId) {
		if (!Array.isArray(memberId)) {memberId = [memberId];}
		const params = {
			grid: groupId,
			members: memberId,
			memberTypes: memberId.map(() => -1),
			imei: ctx.imei,
			clientLang: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/blockUser.js
const blockUserFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/block`);
	/**
	* Block a User
	*
	* @param userId The ID of the User to block
	*
	* @throws {ZaloApiError}
	*/
	return async function blockUser(userId) {
		const params = {
			fid: userId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/blockViewFeed.js
const blockViewFeedFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/feed/block`);
	/**
	* Block/Unblock friend view feed by ID
	*
	* @param isBlockFeed Boolean to block/unblock view feed
	* @param userId User ID to block/unblock view feed
	*
	* @throws {ZaloApiError}
	*/
	return async function blockViewFeed(isBlockFeed, userId) {
		const params = {
			fid: userId,
			isBlockFeed: isBlockFeed ? 1 : 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/changeAccountAvatar.js
var import_form_data = /* @__PURE__ */ __toESM(require_form_data(), 1);
const changeAccountAvatarFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.file[0]}/api/profile/upavatar`);
	/**
	* Change account avatar
	*
	* @param avatarSource Attachment source, can be a file path or an Attachment object
	*
	* @throws {ZaloApiError | ZaloApiMissingImageMetadataGetter}
	*/
	return async function changeAccountAvatar(avatarSource) {
		const isSourceFilePath = typeof avatarSource == "string";
		const imageMetaData = isSourceFilePath ? await getImageMetaData(ctx, avatarSource) : avatarSource.metadata;
		const fileSize = imageMetaData.totalSize || 0;
		const params = {
			avatarSize: 120,
			clientId: String(ctx.uid + formatTime("%H:%M %d/%m/%Y")),
			language: ctx.language,
			metaData: JSON.stringify({
				origin: {
					width: imageMetaData.width || 1080,
					height: imageMetaData.height || 1080
				},
				processed: {
					width: imageMetaData.width || 1080,
					height: imageMetaData.height || 1080,
					size: fileSize
				}
			})
		};
		const avatarData = isSourceFilePath ? fs.readFileSync(avatarSource) : avatarSource.data;
		const formData = new import_form_data.default();
		formData.append("fileContent", avatarData, {
			filename: "blob",
			contentType: "image/jpeg"
		});
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), {
			method: "POST",
			headers: formData.getHeaders(),
			body: formData.getBuffer()
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/changeFriendAlias.js
const changeFriendAliasFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.alias[0]}/api/alias/update`);
	/**
	* Change friend's alias
	*
	* @param alias new alias (nickname - bietdanh)
	* @param friendId friend id
	*
	* @throws {ZaloApiError}
	*/
	return async function changeFriendAlias(alias, friendId) {
		const params = {
			friendId,
			alias,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/changeGroupAvatar.js
const changeGroupAvatarFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.file[0]}/api/group/upavatar`);
	/**
	* Change group avatar
	*
	* @param avatarSource Attachment source, can be a file path or an Attachment object
	* @param groupId Group ID
	*
	* @throws {ZaloApiError | ZaloApiMissingImageMetadataGetter}
	*/
	return async function changeGroupAvatar(avatarSource, groupId) {
		const params = {
			grid: groupId,
			avatarSize: 120,
			clientId: `g${groupId}${getFullTimeFromMillisecond((/* @__PURE__ */ new Date()).getTime())}`,
			imei: ctx.imei
		};
		const isSourceFilePath = typeof avatarSource == "string";
		const imageMetaData = isSourceFilePath ? await getImageMetaData(ctx, avatarSource) : avatarSource.metadata;
		params.originWidth = imageMetaData.width || 1080;
		params.originHeight = imageMetaData.height || 1080;
		const avatarData = isSourceFilePath ? fs.readFileSync(avatarSource) : avatarSource.data;
		const formData = new import_form_data.default();
		formData.append("fileContent", avatarData, {
			filename: "blob",
			contentType: "image/jpeg"
		});
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), {
			method: "POST",
			headers: formData.getHeaders(),
			body: formData.getBuffer()
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/changeGroupName.js
const changeGroupNameFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/updateinfo`);
	/**
	* Change group name
	*
	* @param name New group name
	* @param groupId Group ID
	*
	* @throws {ZaloApiError}
	*/
	return async function changeGroupName(name, groupId) {
		if (name.length == 0) {name = Date.now().toString();}
		const params = {
			grid: groupId,
			gname: name,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/changeGroupOwner.js
const changeGroupOwnerFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/change-owner`);
	/**
	* Change group owner
	*
	* @param memberId User Id of new group owner
	* @param groupId Group Id
	* @note Be careful when changing the key, as it will result in losing group admin rights
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function changeGroupOwner(memberId, groupId) {
		const params = {
			grid: groupId,
			newAdminId: memberId,
			imei: ctx.imei,
			language: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/createAutoReply.js
const createAutoReplyFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.auto_reply[0]}/api/autoreply/create`);
	/**
	* Create auto reply
	*
	* @param payload payload
	*
	* @note this API used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function createAutoReply(payload) {
		const uids = Array.isArray(payload.uids) ? payload.uids : [payload.uids];
		const resultUids = payload.scope === 2 || payload.scope === 3 ? uids : [];
		const params = {
			cliLang: ctx.language,
			enable: payload.isEnable,
			content: payload.content,
			startTime: payload.startTime,
			endTime: payload.endTime,
			recurrence: ["RRULE:FREQ=DAILY;"],
			scope: payload.scope,
			uids: resultUids
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/createCatalog.js
const createCatalogFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.catalog[0]}/api/prodcatalog/catalog/create`);
	/**
	* Create catalog?
	*
	* @param catalogName catalog name
	*
	* @note this API is used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function createCatalog(catalogName) {
		const params = {
			catalog_name: catalogName,
			catalog_photo: ""
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/createGroup.js
const createGroupFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/create/v2`);
	/**
	* Create a new group
	*
	* @param options Group options
	*
	* @throws {ZaloApiError}
	*/
	return async function createGroup(options) {
		if (options.members.length == 0) {throw new ZaloApiError("Group must have at least one member");}
		const params = {
			clientId: Date.now(),
			gname: String(Date.now()),
			gdesc: null,
			members: options.members,
			membersTypes: options.members.map(() => -1),
			nameChanged: 0,
			createLink: 1,
			clientLang: ctx.language,
			imei: ctx.imei,
			zsource: 601
		};
		if (options.name && options.name.length > 0) {
			params.gname = options.name;
			params.nameChanged = 1;
		}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "POST" });
		const data = await utils.resolve(response);
		options.avatarSource = options.avatarSource || options.avatarPath;
		if (options.avatarSource) {await api.changeGroupAvatar(options.avatarSource, data.groupId).catch(utils.logger.error);}
		return data;
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/createNote.js
const createNoteFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/topic/createv2`);
	/**
	* Create a note in a group
	*
	* @param options note options
	* @param options.title note title
	* @param options.pinAct pin action (pin note)
	* @param groupId group id
	*
	* @throws {ZaloApiError}
	*/
	return async function createNote(options, groupId) {
		const params = {
			grid: groupId,
			type: 0,
			color: -16777216,
			emoji: "",
			startTime: -1,
			duration: -1,
			params: JSON.stringify({ title: options.title }),
			repeat: 0,
			src: 1,
			imei: ctx.imei,
			pinAct: options.pinAct ? 1 : 0
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response, (result) => {
			if (typeof result.data.params === "string") {result.data.params = JSON.parse(result.data.params);}
			return result.data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/createPoll.js
const createPollFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/poll/create`);
	/**
	* Create a poll in a group.
	*
	* @param options Poll options
	* @param groupId Group ID to create poll from
	*
	* @throws {ZaloApiError}
	*/
	return async function createPoll(options, groupId) {
		var _a;
		const params = {
			group_id: groupId,
			question: options.question,
			options: options.options,
			expired_time: (_a = options.expiredTime) !== null && _a !== void 0 ? _a : 0,
			pinAct: false,
			allow_multi_choices: !!options.allowMultiChoices,
			allow_add_new_option: !!options.allowAddNewOption,
			is_hide_vote_preview: !!options.hideVotePreview,
			is_anonymous: !!options.isAnonymous,
			poll_type: 0,
			src: 1,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/createProductCatalog.js
const createProductCatalogFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.catalog[0]}/api/prodcatalog/product/create`);
	/**
	* Create product catalog?
	*
	* @param payload payload
	*
	* @note this API is used for zBussiness - Maximum 5 media files are supported
	* @throws {ZaloApiError}
	*/
	return async function createProductCatalog(payload) {
		const productPhoto = payload.product_photos || [];
		if (payload.files && payload.files.length == 0) {
			if (payload.files.length > 5) {throw new ZaloApiError("Maximum 5 media files are allowed");}
			for (const mediaFile of payload.files) {
				const uploadMedia = await api.uploadProductPhoto({ file: mediaFile });
				const url = uploadMedia.normalUrl || uploadMedia.hdUrl;
				productPhoto.push(url);
			}
		}
		if (productPhoto.length > 5) {throw new ZaloApiError("Maximum 5 media files are allowed");}
		const params = {
			product_name: payload.productName,
			price: payload.price,
			description: payload.description,
			product_photos: productPhoto,
			catalog_id: payload.catalogId,
			currency_unit: "₫",
			create_time: Date.now()
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/createReminder.js
const createReminderFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/oneone/create`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/topic/createv2`)
	};
	/**
	* Create a reminder in a group
	*
	* @param options reminder options
	* @param threadId Group ID to create note from
	* @param type Thread type (User or Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function createReminder(options, threadId, type = ThreadType$1.User) {
		var _a, _b, _c, _d, _e, _f;
		const params = type === ThreadType$1.User ? {
			objectData: JSON.stringify({
				toUid: threadId,
				type: 0,
				color: -16245706,
				emoji: (_a = options.emoji) !== null && _a !== void 0 ? _a : "⏰",
				startTime: (_b = options.startTime) !== null && _b !== void 0 ? _b : Date.now(),
				duration: -1,
				params: { title: options.title },
				needPin: false,
				repeat: (_c = options.repeat) !== null && _c !== void 0 ? _c : ReminderRepeatMode.None,
				creatorUid: ctx.uid,
				src: 1
			}),
			imei: ctx.imei
		} : {
			grid: threadId,
			type: 0,
			color: -16245706,
			emoji: (_d = options.emoji) !== null && _d !== void 0 ? _d : "⏰",
			startTime: (_e = options.startTime) !== null && _e !== void 0 ? _e : Date.now(),
			duration: -1,
			params: JSON.stringify({ title: options.title }),
			repeat: (_f = options.repeat) !== null && _f !== void 0 ? _f : ReminderRepeatMode.None,
			src: 1,
			imei: ctx.imei,
			pinAct: 0
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/deleteAutoReply.js
const deleteAutoReplyFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.auto_reply[0]}/api/autoreply/delete`);
	/**
	* Delete auto reply
	*
	* @param id id of auto reply
	*
	* @note this API used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function deleteAutoReply(id) {
		const params = {
			cliLang: ctx.language,
			id
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/deleteAvatar.js
const deleteAvatarFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/del-avatars`);
	/**
	* Delete avatar from avatar list
	*
	* @param photoId avatar photo ID(s) to delete - can be a single string or array of strings
	*
	* @throws {ZaloApiError}
	*/
	return async function deleteAvatar(photoId) {
		const delPhotos = (Array.isArray(photoId) ? photoId : [photoId]).map((id) => ({ photoId: id }));
		const params = {
			delPhotos: JSON.stringify(delPhotos),
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/deleteCatalog.js
const deleteCatalogFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.catalog[0]}/api/prodcatalog/catalog/delete`);
	/**
	* Delete catalog?
	*
	* @param catalogId catalog id
	*
	* @note this API is used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function deleteCatalog(catalogId) {
		const params = { catalog_id: catalogId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/deleteChat.js
const deleteChatFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/deleteconver`, { nretry: 0 }),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/deleteconver`, { nretry: 0 })
	};
	/**
	* Delete chat
	*
	* @param lastMessage Last message info
	* @param threadId Thread ID
	* @param type Thread type
	*
	* @throws {ZaloApiError}
	*/
	return async function deleteChat(lastMessage, threadId, type = ThreadType$1.User) {
		const timestampString = Date.now().toString();
		const params = type === ThreadType$1.User ? {
			toid: threadId,
			cliMsgId: timestampString,
			conver: lastMessage,
			onlyMe: 1,
			imei: ctx.imei
		} : {
			grid: threadId,
			cliMsgId: timestampString,
			conver: lastMessage,
			onlyMe: 1,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/deleteGroupInviteBox.js
const deleteGroupInviteBoxFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/inv-box/mdel-inv`);
	/**
	* Delete group invite box
	*
	* @param groupId - The group id
	* @param blockFutureInvite - Whether to block future invites from this group
	*
	* @throws {ZaloApiError}
	*/
	return async function deleteGroupInviteBox(groupId, blockFutureInvite = false) {
		const grids = Array.isArray(groupId) ? groupId : [groupId];
		const params = {
			invitations: JSON.stringify(grids.map((grid) => ({ grid }))),
			block: blockFutureInvite ? 1 : 0
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/deleteMessage.js
const deleteMessageFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/delete`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/deletemsg`)
	};
	/**
	* Delete a message
	*
	* @param dest Delete target
	* @param onlyMe Delete message for only you
	*
	* @throws {ZaloApiError}
	*/
	return async function deleteMessage(dest, onlyMe = false) {
		const { threadId, type = ThreadType$1.User, data } = dest;
		const isGroup = type === ThreadType$1.Group;
		if (ctx.uid == data.uidFrom && ! onlyMe) {throw new ZaloApiError("To delete your message for everyone, use undo api instead");}
		if (!isGroup && ! onlyMe) {throw new ZaloApiError("Can't delete message for everyone in a private chat");}
		const params = {
			[isGroup ? "grid" : "toid"]: threadId,
			cliMsgId: Date.now(),
			msgs: [{
				cliMsgId: data.cliMsgId,
				globalMsgId: data.msgId,
				ownerId: data.uidFrom,
				destId: threadId
			}],
			onlyMe: onlyMe ? 1 : 0
		};
		if (!isGroup) {params.imei = ctx.imei;}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/deleteProductCatalog.js
const deleteProductCatalogFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.catalog[0]}/api/prodcatalog/product/mdelete`);
	/**
	* Delete product catalog?
	*
	* @param payload payload
	*
	* @note this API is used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function deleteProductCatalog(payload) {
		if (!Array.isArray(payload.productIds)) {payload.productIds = [payload.productIds];}
		const params = {
			product_ids: payload.productIds,
			catalog_id: payload.catalogId
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/disableGroupLink.js
const disableGroupLinkFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/link/disable`);
	/**
	* Disable group link
	*
	* @param groupId The group id
	*
	* @throws {ZaloApiError}
	*/
	return async function disableGroupLink(groupId) {
		const params = { grid: groupId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/disperseGroup.js
const disperseGroupFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/disperse`);
	/**
	* Disperse Group
	*
	* @param groupId Group ID to disperse Group from
	*
	* @throws {ZaloApiError}
	*/
	return async function disperseGroup(groupId) {
		const params = {
			grid: groupId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/editNote.js
const editNoteFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/topic/updatev2`);
	/**
	* Edit an existing note in a group
	*
	* @param options Options for editing the note
	* @param groupId Group ID to create note from
	*
	* @throws {ZaloApiError}
	*/
	return async function editNote(options, groupId) {
		const params = {
			grid: groupId,
			type: 0,
			color: -16777216,
			emoji: "",
			startTime: -1,
			duration: -1,
			params: JSON.stringify({ title: options.title }),
			topicId: options.topicId,
			repeat: 0,
			imei: ctx.imei,
			pinAct: options.pinAct ? 1 : 2
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response, (result) => {
			const data = result.data;
			if (typeof data.params == "string") {data.params = JSON.parse(data.params);}
			return data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/editReminder.js
const editReminderFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/oneone/update`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/topic/updatev2`)
	};
	/**
	* Edit an existing reminder
	*
	* @param options Reminder parameters
	* @param threadId Thread ID
	* @param type Thread type (User/Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function editReminder(options, threadId, type = ThreadType$1.User) {
		var _a, _b, _c, _d, _e, _f;
		const requestParams = type === ThreadType$1.User ? { objectData: JSON.stringify({
			toUid: threadId,
			type: 0,
			color: -16777216,
			emoji: (_a = options.emoji) !== null && _a !== void 0 ? _a : "",
			startTime: (_b = options.startTime) !== null && _b !== void 0 ? _b : Date.now(),
			duration: -1,
			params: { title: options.title },
			needPin: false,
			reminderId: options.topicId,
			repeat: (_c = options.repeat) !== null && _c !== void 0 ? _c : 0
		}) } : {
			grid: threadId,
			type: 0,
			color: -16777216,
			emoji: (_d = options.emoji) !== null && _d !== void 0 ? _d : "",
			startTime: (_e = options.startTime) !== null && _e !== void 0 ? _e : Date.now(),
			duration: -1,
			params: JSON.stringify({ title: options.title }),
			topicId: options.topicId,
			repeat: (_f = options.repeat) !== null && _f !== void 0 ? _f : 0,
			imei: ctx.imei,
			pinAct: 2
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(requestParams));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/enableGroupLink.js
const enableGroupLinkFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/link/new`);
	/**
	* Enable and create new group link
	*
	* @param groupId The group id
	*
	* @throws {ZaloApiError}
	*/
	return async function enableGroupLink(groupId) {
		const params = {
			grid: groupId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/fetchAccountInfo.js
const fetchAccountInfoFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/me-v2`);
	return async function fetchAccountInfo() {
		const response = await utils.request(serviceURL, { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/findUser.js
const findUserFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/profile/get`);
	/**
	* Find user by phone number
	*
	* @param phoneNumber Phone number
	* @param avatarSize Avatar size (default: AvatarSize.Large)
	*
	* @throws {ZaloApiError}
	*/
	return async function findUser(phoneNumber, avatarSize = AvatarSize.Large) {
		if (!phoneNumber) {throw new ZaloApiError("Missing phoneNumber");}
		if (phoneNumber.startsWith("0")) {
			if (ctx.language == "vi") {phoneNumber = "84" + phoneNumber.slice(1);}
		}
		const params = {
			phone: phoneNumber,
			avatar_size: avatarSize,
			language: ctx.language,
			imei: ctx.imei,
			reqSrc: 40
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const finalServiceUrl = new URL(serviceURL);
		finalServiceUrl.searchParams.append("params", encryptedParams);
		const response = await utils.request(utils.makeURL(finalServiceUrl.toString(), { params: encryptedParams }));
		return utils.resolve(response, (result) => {
			if (result.error && result.error.code != 216) {throw new ZaloApiError(result.error.message, result.error.code);}
			return result.data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/findUserByUsername.js
const findUserByUsernameFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/search/by-user-name`);
	/**
	* Find user by username
	*
	* @param username username for find
	* @param avatarSize Avatar size (default: AvatarSize.Large)
	*
	* @throws {ZaloApiError}
	*/
	return async function findUserByUsername(username, avatarSize = AvatarSize.Large) {
		const params = {
			user_name: username,
			avatar_size: avatarSize
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/forwardMessage.js
const forwardMessageFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/message/mforward`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/group/mforward`)
	};
	/**
	* Forward message to multiple threads
	*
	* @param payload Forward message payload
	* @param threadId Thread ID(s)
	* @param type Thread type (User/Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function forwardMessage(payload, threadIds, type = ThreadType$1.User) {
		var _a, _b;
		if (!payload.message) {throw new ZaloApiError("Missing message content");}
		if (!threadIds || threadIds.length === 0) {throw new ZaloApiError("Missing thread IDs");}
		const clientId = Date.now().toString();
		const msgInfo = {
			message: payload.message,
			reference: payload.reference ? JSON.stringify({
				type: 3,
				data: JSON.stringify(payload.reference)
			}) : void 0
		};
		const decorLog = payload.reference ? { fw: {
			pmsg: {
				st: 1,
				ts: payload.reference.ts,
				id: payload.reference.id
			},
			rmsg: {
				st: 1,
				ts: payload.reference.ts,
				id: payload.reference.id
			},
			fwLvl: payload.reference.fwLvl
		} } : null;
		let params;
		if (type === ThreadType$1.User) {params = {
			toIds: threadIds.map((threadId) => {
				var _a;
				return {
					clientId,
					toUid: threadId,
					ttl: (_a = payload.ttl) !== null && _a !== void 0 ? _a : 0
				};
			}),
			imei: ctx.imei,
			ttl: (_a = payload.ttl) !== null && _a !== void 0 ? _a : 0,
			msgType: "1",
			totalIds: threadIds.length,
			msgInfo: JSON.stringify(msgInfo),
			decorLog: JSON.stringify(decorLog)
		};}
		else {params = {
			grids: threadIds.map((threadId) => {
				var _a;
				return {
					clientId,
					grid: threadId,
					ttl: (_a = payload.ttl) !== null && _a !== void 0 ? _a : 0
				};
			}),
			ttl: (_b = payload.ttl) !== null && _b !== void 0 ? _b : 0,
			msgType: "1",
			totalIds: threadIds.length,
			msgInfo: JSON.stringify(msgInfo),
			decorLog: JSON.stringify(decorLog)
		};}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getAliasList.js
const getAliasListFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.alias[0]}/api/alias/list`);
	/**
	* Get alias list
	*
	* @param count Page size (default: 100)
	* @param page Page number (default: 1)
	*
	* @throws {ZaloApiError}
	*/
	return async function getAliasList(count = 100, page = 1) {
		const params = {
			page,
			count,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getAllFriends.js
const getAllFriendsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/friend/getfriends`);
	/**
	* Get all friends
	*
	* @param count Page size (default: 20000)
	* @param page Page number (default: 1)
	* @param avatarSize Avatar size (default: AvatarSize.Small)
	*
	* @throws {ZaloApiError}
	*/
	return async function getAllFriends(count = 2e4, page = 1, avatarSize = AvatarSize.Small) {
		const params = {
			incInvalid: 1,
			page,
			count,
			avatar_size: avatarSize,
			actiontime: 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getAllGroups.js
const getAllGroupsFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group_poll[0]}/api/group/getlg/v4`);
	return async function getAllGroups() {
		const response = await utils.request(serviceURL, { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getArchivedChatList.js
const getArchivedChatListFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.label[0]}/api/archivedchat/list`);
	/**
	* Get arcnived chat list
	*
	* @throws {ZaloApiError}
	*/
	return async function getArchivedChatList() {
		const params = {
			version: 1,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getAutoDeleteChat.js
const getAutoDeleteChatFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/conv/autodelete/getConvers`);
	/**
	* Get auto delete chat
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function getAutoDeleteChat() {
		const encryptedParams = utils.encodeAES(JSON.stringify({}));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getAutoReplyList.js
const getAutoReplyListFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.auto_reply[0]}/api/autoreply/list`);
	/**
	* Get auto reply list
	*
	* @note this API used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function getAutoReplyList() {
		const params = {
			version: 0,
			cliLang: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getAvatarList.js
const getAvatarListFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/avatar-list`);
	/**
	* Get avatar list
	*
	* @param count The number of avatars to fetch (default: 50)
	* @param page The page number to fetch (default: 1)
	*
	* @throws {ZaloApiError}
	*/
	return async function getAvatarList(count = 50, page = 1) {
		const params = {
			page,
			albumId: "0",
			count,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getAvatarUrlProfile.js
const getAvatarUrlProfileFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/avatar-url`);
	/**
	* Get avatar url profile
	*
	* @param friendId friend id(s)
	* @param avatarSize Avatar size (default: AvatarSize.Large)
	*
	* @throws {ZaloApiError}
	*/
	return async function getAvatarUrlProfile(friendIds, avatarSize = AvatarSize.Large) {
		if (!Array.isArray(friendIds)) {friendIds = [friendIds];}
		const params = {
			friend_ids: friendIds,
			avatar_size: avatarSize,
			srcReq: -1
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getBizAccount.js
const getBizAccountFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/friend/get-bizacc`);
	/**
	* Get biz account
	*
	* @param friendId The friend ID to get biz account
	*
	* @throws {ZaloApiError}
	*/
	return async function getBizAccount(friendId) {
		const params = { fid: friendId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getCatalogList.js
const getCatalogListFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.catalog[0]}/api/prodcatalog/catalog/list`);
	/**
	* Get catalog list?
	*
	* @param payload payload
	*
	* @note this API is used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function getCatalogList(payload) {
		var _a, _b, _c;
		const params = {
			version_list_catalog: 0,
			limit: (_a = payload === null || payload === void 0 ? void 0 : payload.limit) !== null && _a !== void 0 ? _a : 20,
			last_product_id: (_b = payload === null || payload === void 0 ? void 0 : payload.lastProductId) !== null && _b !== void 0 ? _b : -1,
			page: (_c = payload === null || payload === void 0 ? void 0 : payload.page) !== null && _c !== void 0 ? _c : 0
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getCloseFriends.js
const getCloseFriendsFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/friend/getclosedfriends`);
	/**
	* Get close friends
	*
	* @throws {ZaloApiError}
	*/
	return async function getCloseFriends() {
		const encryptedParams = utils.encodeAES(JSON.stringify({}));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getContext.js
const getContextFactory = apiFactory()((_, ctx) => {
	return () => ctx;
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getCookie.js
const getCookieFactory = apiFactory()((_, ctx) => {
	/**
	* Get the current cookie string
	*/
	return function getCookie() {
		return ctx.cookie;
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getFriendBoardList.js
const getFriendBoardListFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend_board[0]}/api/friendboard/list`);
	/**
	* Get friend board list
	*
	* @param conversationId conversation id
	*
	* @throws {ZaloApiError}
	*/
	return async function getFriendBoardList(conversationId) {
		const params = {
			conversationId,
			version: 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getFriendOnlines.js
const getFriendOnlinesFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/friend/onlines`);
	/**
	* Get friend onlines?
	*
	* @throws {ZaloApiError}
	*/
	return async function getFriendOnlines() {
		const params = { imei: ctx.imei };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response, (result) => {
			const data = result.data;
			if (Array.isArray(data.onlines)) {
				for (const online of data.onlines) {if (typeof online.status === "string") {
					const parsed = JSON.parse(online.status);
					if (parsed && typeof parsed.status === "string") online.status = parsed.status;
				}}
			}
			return data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getFriendRecommendations.js
var FriendRecommendationsType;
(function(FriendRecommendationsType) {
	FriendRecommendationsType[FriendRecommendationsType["RecommendedFriend"] = 1] = "RecommendedFriend";
	FriendRecommendationsType[FriendRecommendationsType["ReceivedFriendRequest"] = 2] = "ReceivedFriendRequest";
})(FriendRecommendationsType || (FriendRecommendationsType = {}));
const getFriendRecommendationsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/recommendsv2/list`);
	/**
	* Get friend recommendations/received friend requests
	*
	* @throws {ZaloApiError}
	*/
	return async function getFriendRecommendations() {
		const params = { imei: ctx.imei };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getFriendRequestStatus.js
const getFriendRequestStatusFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/reqstatus`);
	/**
	* Get friend request status
	*
	* @param friendId friend id
	*
	* @throws {ZaloApiError}
	*/
	return async function getFriendRequestStatus(friendId) {
		const params = {
			fid: friendId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getFullAvatar.js
const getFullAvatarFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/avatar`);
	/**
	* Get full avatar
	*
	* @param friendId friend id
	*
	* @throws {ZaloApiError}
	*/
	return async function getFullAvatar(friendId) {
		const params = {
			fid: friendId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getGroupBlockedMember.js
const getGroupBlockedMemberFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/blockedmems/list`);
	/**
	* Get group blocked member
	*
	* @param payload payload
	* @param groupId group id
	*
	* @throws {ZaloApiError}
	*/
	return async function getGroupBlockedMember(payload, groupId) {
		var _a, _b;
		const params = {
			grid: groupId,
			page: (_a = payload.page) !== null && _a !== void 0 ? _a : 1,
			count: (_b = payload.count) !== null && _b !== void 0 ? _b : 50,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getGroupChatHistory.js
const getGroupChatHistoryFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/history`);
	/**
	* Get group chat history
	*
	* @param groupId group id
	* @param count count of messages to return (default: 50)
	*
	* @throws {ZaloApiError}
	*/
	return async function getGroupChatHistory(groupId, count = 50) {
		const params = {
			grid: groupId,
			count
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response, (result) => {
			let data = result.data;
			if (typeof data === "string") {data = JSON.parse(data);}
			for (let i = 0; i < data.groupMsgs.length; i++) {data.groupMsgs[i] = new GroupMessage(ctx.uid, data.groupMsgs[i]);}
			return data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getGroupInfo.js
const getGroupInfoFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/getmg-v2`);
	/**
	* Get group information
	*
	* @param groupId Group ID or list of group IDs
	*
	* @throws {ZaloApiError}
	*/
	return async function getGroupInfo(groupId) {
		if (!Array.isArray(groupId)) {groupId = [groupId];}
		const params = { gridVerMap: JSON.stringify(groupId.reduce((acc, id) => {
			acc[id] = 0;
			return acc;
		}, {})) };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getGroupInviteBoxInfo.js
const getGroupInviteBoxInfoFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/inv-box/inv-info`);
	/**
	* Get group invite box info
	*
	* @param payload - The payload of the request
	*
	* @throws {ZaloApiError}
	*/
	return async function getGroupInviteBoxInfo(payload) {
		var _a, _b;
		const params = {
			grId: payload.groupId,
			mcount: (_a = payload.mcount) !== null && _a !== void 0 ? _a : 10,
			mpage: (_b = payload.mpage) !== null && _b !== void 0 ? _b : 1
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response, (result) => {
			const data = result.data;
			const topic = data.groupInfo.topic;
			if (typeof topic.params == "string") {
				const params = JSON.parse(topic.params);
				if (typeof params.extra == "string") {params.extra = JSON.parse(params.extra);}
				topic.params = params;
			}
			return data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getGroupInviteBoxList.js
const getGroupInviteBoxListFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/inv-box/list`);
	/**
	* Get group invite box list
	*
	* @param payload - The payload of the request
	*
	* @throws {ZaloApiError}
	*/
	return async function getGroupInviteBoxList(payload) {
		var _a, _b, _c, _d;
		const params = {
			mpage: (_a = payload === null || payload === void 0 ? void 0 : payload.mpage) !== null && _a !== void 0 ? _a : 1,
			page: (_b = payload === null || payload === void 0 ? void 0 : payload.page) !== null && _b !== void 0 ? _b : 0,
			invPerPage: (_c = payload === null || payload === void 0 ? void 0 : payload.invPerPage) !== null && _c !== void 0 ? _c : 12,
			mcount: (_d = payload === null || payload === void 0 ? void 0 : payload.mcount) !== null && _d !== void 0 ? _d : 10,
			lastGroupId: null,
			avatar_size: 120,
			member_avatar_size: 120
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getGroupLinkDetail.js
const getGroupLinkDetailFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/link/detail`);
	/**
	* Get group link detail
	*
	* @param groupId The group id
	*
	* @throws {ZaloApiError}
	*/
	return async function getGroupLinkDetail(groupId) {
		const params = {
			grid: groupId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getGroupLinkInfo.js
const getGroupLinkInfoFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/link/ginfo`);
	/**
	* Get group link info
	*
	* @param payload - The payload of the request
	*
	* @throws {ZaloApiError}
	*/
	return async function getGroupLinkInfo(payload) {
		var _a;
		const params = {
			link: payload.link,
			avatar_size: 120,
			member_avatar_size: 120,
			mpage: (_a = payload.memberPage) !== null && _a !== void 0 ? _a : 1
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getGroupMembersInfo.js
const getGroupMembersInfoFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/group/members`);
	/**
	* Get group information
	*
	* @param memberId member id or array of member ids
	*
	* @throws {ZaloApiError}
	*/
	return async function getGroupMembersInfo(memberId) {
		if (!Array.isArray(memberId)) {memberId = [memberId];}
		const params = { friend_pversion_map: memberId.map((id) => id.endsWith("_0") ? id : `${id}_0`) };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }));
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getHiddenConversations.js
const getHiddenConversationsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/hiddenconvers/get-all`);
	/**
	* Get hidden conversations
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function getHiddenConversations() {
		const params = { imei: ctx.imei };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getLabels.js
const getLabelsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.label[0]}/api/convlabel/get`);
	/**
	* Get all labels
	*
	* @throws {ZaloApiError}
	*/
	return async function getLabels() {
		const params = { imei: ctx.imei };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }));
		return utils.resolve(response, (result) => {
			const data = result.data;
			return {
				labelData: JSON.parse(data.labelData),
				version: data.version,
				lastUpdateTime: data.lastUpdateTime
			};
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getListBoard.js
const getListBoardFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/list`);
	/**
	* Get list board items in a group
	*
	* @param options - The options for the request
	* @param groupId - The ID of the group
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function getListBoard(options, groupId) {
		var _a, _b;
		const requestParams = {
			group_id: groupId,
			board_type: 0,
			page: (_a = options.page) !== null && _a !== void 0 ? _a : 1,
			count: (_b = options.count) !== null && _b !== void 0 ? _b : 20,
			last_id: 0,
			last_type: 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(requestParams));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response, (result) => {
			const data = result.data;
			data.items.forEach((item) => {
				if (item.boardType != BoardType.Poll) {
					const detailData = item.data;
					if (typeof detailData.params === "string") {detailData.params = JSON.parse(detailData.params);}
				}
			});
			return data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getListReminder.js
const getListReminderFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/oneone/list`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/listReminder`)
	};
	/**
	* Get list reminder
	*
	* @param options - The options for the request
	* @param threadId - The ID of the thread
	* @param type - The type of the thread (User or Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function getListReminder(options, threadId, type = ThreadType$1.User) {
		var _a, _b, _c, _d;
		const requestParams = Object.assign({ objectData: JSON.stringify(type === ThreadType$1.User ? {
			uid: threadId,
			board_type: 1,
			page: (_a = options.page) !== null && _a !== void 0 ? _a : 1,
			count: (_b = options.count) !== null && _b !== void 0 ? _b : 20,
			last_id: 0,
			last_type: 0
		} : {
			group_id: threadId,
			board_type: 1,
			page: (_c = options.page) !== null && _c !== void 0 ? _c : 1,
			count: (_d = options.count) !== null && _d !== void 0 ? _d : 20,
			last_id: 0,
			last_type: 0
		}) }, type === ThreadType$1.Group && { imei: ctx.imei });
		const encryptedParams = utils.encodeAES(JSON.stringify(requestParams));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL[type], { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response, (result) => {
			return JSON.parse(result.data);
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getMultiUsersByPhones.js
const getMultiUsersByPhonesFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/profile/multiget`);
	/**
	* Get multiple user(s) by their phone numbers.
	*
	* @param phoneNumbers Phone number(s)
	* @param avatarSize Avatar size (default: AvatarSize.Large)
	*
	* @throws {ZaloApiError}
	*/
	return async function getMultiUsersByPhones(phoneNumbers, avatarSize = AvatarSize.Large) {
		if (!phoneNumbers) {throw new ZaloApiError("Missing phoneNumbers");}
		if (!Array.isArray(phoneNumbers)) {phoneNumbers = [phoneNumbers];}
		phoneNumbers = phoneNumbers.map((phone) => {
			if (phone.startsWith("0")) {
				if (ctx.language == "vi") {phone = "84" + phone.slice(1);}
			}
			return phone;
		});
		const params = {
			phones: phoneNumbers,
			avatar_size: avatarSize,
			language: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getMute.js
const getMuteFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/getmute`);
	/**
	* Get mute
	*
	* @throws {ZaloApiError}
	*/
	return async function getMute() {
		const params = { imei: ctx.imei };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getOwnId.js
const getOwnIdFactory = apiFactory()((_, ctx) => {
	return () => ctx.uid;
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getPendingGroupMembers.js
const getPendingGroupMembersFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/pending-mems/list`);
	/**
	* Get pending group members
	*
	* @param groupId - The id of the group to get the pending members
	*
	* @note Only the group leader and deputy group leader can view
	*
	* @throws {ZaloApiError}
	*/
	return async function getPendingGroupMembers(groupId) {
		const params = {
			grid: groupId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getPinConversations.js
const getPinConversationsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/pinconvers/list`);
	/**
	* Get pin conversations
	*
	* @throws {ZaloApiError}
	*/
	return async function getPinConversations() {
		const params = { imei: ctx.imei };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getPollDetail.js
const getPollDetailFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/poll/detail`);
	/**
	* Get poll detail
	*
	* @param pollId Poll ID
	*
	* @throws {ZaloApiError}
	*/
	return async function getPollDetail(pollId) {
		if (!pollId) {throw new ZaloApiError("Missing poll id");}
		const params = {
			poll_id: pollId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getProductCatalogList.js
const getProductCatalogListFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.catalog[0]}/api/prodcatalog/product/list`);
	/**
	* Get product catalog list?
	*
	* @param payload payload
	*
	* @note this API is used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function getProductCatalogList(payload) {
		var _a, _b, _c, _d;
		const params = {
			catalog_id: payload.catalogId,
			limit: (_a = payload.limit) !== null && _a !== void 0 ? _a : 100,
			version_catalog: (_b = payload.versionCatalog) !== null && _b !== void 0 ? _b : 0,
			last_product_id: (_c = payload.lastProductId) !== null && _c !== void 0 ? _c : -1,
			page: (_d = payload.page) !== null && _d !== void 0 ? _d : 0
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getQR.js
const getQRFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/mget-qr`);
	/**
	* Get QR code for users
	*
	* @param userId User ID or list of user IDs
	*
	* @throws {ZaloApiError}
	*/
	return async function getQR(userId) {
		if (typeof userId == "string") {userId = [userId];}
		const params = { fids: userId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getQuickMessageList.js
const getQuickMessageListFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.quick_message[0]}/api/quickmessage/list`);
	/**
	* Get quick message list
	*
	* @throws {ZaloApiError}
	*/
	return async function getQuickMessageList() {
		const params = {
			version: 0,
			lang: 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getRelatedFriendGroup.js
const getRelatedFriendGroupFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/group/related`);
	/**
	* Get related friend group
	*
	* @param friendId friend ids
	*
	* @note this API is used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function getRelatedFriendGroup(friendId) {
		const friendIds = Array.isArray(friendId) ? friendId : [friendId];
		const params = {
			friend_ids: JSON.stringify(friendIds),
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getReminder.js
const getReminderFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/topic/getReminder`);
	/**
	* Get reminder details from a group
	*
	* @param reminderId Reminder ID
	*
	* @throws {ZaloApiError}
	*/
	return async function getReminder(reminderId) {
		const params = {
			eventId: reminderId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getReminderResponses.js
const getReminderResponsesFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/topic/listResponseEvent`);
	/**
	* Get reminder responses
	*
	* @param reminderId reminder id
	*
	* @throws {ZaloApiError}
	*/
	return async function getReminderResponses(reminderId) {
		const params = { eventId: reminderId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getSentFriendRequest.js
const getSentFriendRequestFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/requested/list`);
	/**
	* Get friend requested
	*
	* @note Zalo might throw an error with code 112 if you have no friend requests.
	*
	* @throws {ZaloApiError}
	*/
	return async function getSentFriendRequest() {
		const params = { imei: ctx.imei };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getSettings.js
const getSettingsFactory = apiFactory()((_api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`https://wpa.chat.zalo.me/api/setting/me`);
	/**
	* Get my account settings
	*
	* @throws {ZaloApiError}
	*/
	return async function getSettings() {
		const encryptedParams = utils.encodeAES(JSON.stringify({}));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getStickerCategoryDetail.js
const getStickerCategoryDetailFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.sticker[0]}/api/message/sticker/category/sticker_detail`);
	/**
	* Get sticker category detail
	*
	* @param cateId Sticker category ID
	*
	* @throws {ZaloApiError}
	*/
	return async function getStickerCategoryDetail(cateId) {
		const params = { cid: cateId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getStickers.js
const getStickersFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.sticker}/api/message/sticker`);
	/**
	* Get stickers by keyword
	*
	* @param keyword Keyword to search for
	* @returns Sticker IDs
	*
	* @throws {ZaloApiError}
	*/
	return async function getStickers(keyword) {
		if (!keyword) {throw new ZaloApiError("Missing keyword");}
		const params = {
			keyword,
			gif: 1,
			guggy: 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const finalServiceUrl = new URL(serviceURL);
		finalServiceUrl.pathname = finalServiceUrl.pathname + "/suggest/stickers";
		const response = await utils.request(utils.makeURL(finalServiceUrl.toString(), { params: encryptedParams }));
		return utils.resolve(response, (result) => {
			const suggestions = result.data;
			const stickerIds = [];
			if (suggestions.sugg_sticker) {suggestions.sugg_sticker.forEach((sticker) => stickerIds.push(sticker.sticker_id));}
			return stickerIds;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getStickersDetail.js
const getStickersDetailFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.sticker}/api/message/sticker/sticker_detail`);
	/**
	* Get stickers detail by sticker IDs
	*
	* @param stickerIds Sticker IDs to search for
	*
	* @throws {ZaloApiError}
	*/
	return async function getStickersDetail(stickerIds) {
		if (!stickerIds) {throw new ZaloApiError("Missing sticker id");}
		if (!Array.isArray(stickerIds)) {stickerIds = [stickerIds];}
		if (stickerIds.length == 0) {throw new ZaloApiError("Missing sticker id");}
		const stickers = [];
		const tasks = stickerIds.map((stickerId) => getStickerDetail(stickerId));
		(await Promise.allSettled(tasks)).forEach((result) => {
			if (result.status === "fulfilled") {stickers.push(result.value);}
		});
		return stickers;
	};
	async function getStickerDetail(stickerId) {
		const params = { sid: stickerId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		return resolveResponse(ctx, await utils.request(utils.makeURL(serviceURL, { params: encryptedParams })));
	}
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getUnreadMark.js
const getUnreadMarkFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/conv/getUnreadMark`);
	/**
	* Get unread mark
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function getUnreadMark() {
		const encryptedParams = utils.encodeAES(JSON.stringify({}));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response, (result) => {
			const data = result.data;
			if (typeof data.data === "string") {return {
				data: JSON.parse(data.data),
				status: data.status
			};}
			return data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/getUserInfo.js
const getUserInfoFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/friend/getprofiles/v2`);
	/**
	* Get user info using user id
	*
	* @param userId User id(s)
	* @param avatarSize Avatar size (default: AvatarSize.Small)
	*
	* @throws {ZaloApiError}
	*/
	return async function getUserInfo(userId, avatarSize = AvatarSize.Small) {
		if (!userId) {throw new ZaloApiError("Missing user id");}
		if (!Array.isArray(userId)) {userId = [userId];}
		userId = userId.map((id) => {
			if (id.split("_").length > 1) {return id;}
			return `${id}_0`;
		});
		const params = {
			phonebook_version: ctx.extraVer.phonebook,
			friend_pversion_map: userId,
			avatar_size: avatarSize,
			language: ctx.language,
			show_online_status: 1,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/inviteUserToGroups.js
const inviteUserToGroupsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/invite/multi`);
	/**
	* Invite user to group
	*
	* @param groupId group ID(s)
	* @param memberId member ID
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function inviteUserToGroups(userId, groupId) {
		const params = {
			grids: Array.isArray(groupId) ? groupId : [groupId],
			member: userId,
			memberType: -1,
			srcInteraction: 2,
			clientLang: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/joinGroupInviteBox.js
const joinGroupInviteBoxFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/inv-box/join`);
	/**
	* Join group invite box
	*
	* @param groupId - The group id
	*
	* @throws {ZaloApiError}
	*/
	return async function joinGroupInviteBox(groupId) {
		const params = {
			grid: groupId,
			lang: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/joinGroupLink.js
const joinGroupLinkFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/link/join`);
	/**
	* Join group via invite link
	*
	* @note Zalo might throw an error with code 240 if the group enabled membership approval, 178 if you are already a member.
	*
	* @param link - The link join group
	*
	* @throws {ZaloApiError}
	*/
	return async function joinGroupLink(link) {
		const params = {
			link,
			clientLang: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/keepAlive.js
const keepAliveFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.chat[0]}/keepalive`);
	/**
	* Keep Alive?
	*
	* @throws {ZaloApiError}
	*/
	return async function keepAlive() {
		const params = { imei: ctx.imei };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response, void 0, false);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/lastOnline.js
const lastOnlineFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/lastOnline`);
	/**
	* Get last online
	*
	* @param uid User ID
	*
	* @throws {ZaloApiError}
	*/
	return async function lastOnline(uid) {
		const params = {
			uid,
			conv_type: 1,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/leaveGroup.js
const leaveGroupFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/leave`);
	/**
	* Leave group
	*
	* @param groupId - groupId to leave
	* @param silent - Turn on/off silent leave group
	*
	* @note Zalo might throw an error with code 166 if you are not a member of the group
	*
	* @throws {ZaloApiError}
	*/
	return async function leaveGroup(groupId, silent = false) {
		const requestParams = {
			grids: [groupId],
			imei: ctx.imei,
			silent: silent ? 1 : 0,
			language: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(requestParams));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/lockPoll.js
const lockPollFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/poll/end`);
	/**
	* Lock a poll, preventing further votes.
	*
	* @param pollId Poll id to lock
	*
	* @throws {ZaloApiError}
	*/
	return async function lockPoll(pollId) {
		const params = {
			poll_id: pollId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/parseLink.js
const parseLinkFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.file[0]}/api/message/parselink`);
	/**
	* Parse link
	*
	* @param link link to parse
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function parseLink(link) {
		const params = {
			link,
			version: 1,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/rejectFriendRequest.js
const rejectFriendRequestFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/reject`);
	/**
	* Reject a friend request from a User
	*
	* @param friendId
	*
	* @throws {ZaloApiError}
	*/
	return async function rejectFriendRequest(friendId) {
		const params = { fid: friendId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/removeFriend.js
const removeFriendFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/remove`);
	/**
	* Remove friend
	*
	* @param friendId - ID of the friend to remove
	*
	* @throws {ZaloApiError}
	*/
	return async function removeFriend(friendId) {
		const params = {
			fid: friendId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/removeFriendAlias.js
const removeFriendAliasFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.alias[0]}/api/alias/remove`);
	/**
	* Remove friend's alias
	*
	* @param friendId friend id
	*
	* @throws {ZaloApiError}
	*/
	return async function removeFriendAlias(friendId) {
		const params = { friendId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/removeGroupBlockedMember.js
const removeGroupBlockedMemberFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/blockedmems/remove`);
	/**
	* Remove group blocked member
	*
	* @param memberId member id(s)
	* @param groupId group id
	*
	* @throws {ZaloApiError}
	*/
	return async function removeGroupBlockedMember(memberId, groupId) {
		if (!Array.isArray(memberId)) {memberId = [memberId];}
		const params = {
			grid: groupId,
			members: memberId
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/removeGroupDeputy.js
const removeGroupDeputyFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/admins/remove`);
	/**
	* Remove group deputy
	*
	* @param memberId user Id or list of user Ids
	* @param groupId group Id
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function removeGroupDeputy(memberId, groupId) {
		if (!Array.isArray(memberId)) {memberId = [memberId];}
		const params = {
			grid: groupId,
			members: memberId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/removeQuickMessage.js
const removeQuickMessageFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.quick_message[0]}/api/quickmessage/delete`);
	/**
	* Remove quick message
	*
	* @param itemIds - The id(s) of the quick message(s) to remove (number or number[])
	*
	* @note Zalo might throw an error with code 212 if the item does not exist
	*
	* @throws {ZaloApiError}
	*/
	return async function removeQuickMessage(itemIds) {
		const params = { itemIds: Array.isArray(itemIds) ? itemIds : [itemIds] };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/removeReminder.js
const removeReminderFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/oneone/remove`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/topic/remove`)
	};
	/**
	* Remove a reminder in a (user/group)
	*
	* @param reminderId Reminder ID to remove reminder from
	* @param threadId (User/Group) ID to remove reminder from
	* @param type Thread type (User or Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function removeReminder(reminderId, threadId, type = ThreadType$1.User) {
		const params = type === ThreadType$1.User ? {
			uid: threadId,
			reminderId
		} : {
			grid: threadId,
			topicId: reminderId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/removeUnreadMark.js
const removeUnreadMarkFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/conv/removeUnreadMark`);
	/**
	* Remove unread mark from conversation
	*
	* @param threadId Thread ID
	* @param type Thread type (User/Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function removeUnreadMark(threadId, type = ThreadType$1.User) {
		const timestamp = Date.now();
		const isGroup = type === ThreadType$1.Group;
		const requestParams = { param: JSON.stringify({
			[isGroup ? "convsGroup" : "convsUser"]: [threadId],
			[isGroup ? "convsUser" : "convsGroup"]: [],
			[isGroup ? "convsGroupData" : "convsUserData"]: [{
				id: threadId,
				ts: timestamp
			}],
			[isGroup ? "convsUserData" : "convsGroupData"]: []
		}) };
		const encryptedParams = utils.encodeAES(JSON.stringify(requestParams));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response, (result) => {
			const data = result.data;
			if (typeof data.data === "string") {return {
				data: JSON.parse(data.data),
				status: data.status
			};}
			return result.data;
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/removeUserFromGroup.js
const removeUserFromGroupFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/kickout`);
	/**
	* Remove user from existing group
	*
	* @param memberId User ID or list of user IDs to remove
	* @param groupId Group ID
	*
	* @note Zalo might throw an error with code 165 if the user is not in the group, 166 if you don't have enough permissions or is not in the group
	*
	* @throws {ZaloApiError}
	*/
	return async function removeUserFromGroup(memberId, groupId) {
		if (!Array.isArray(memberId)) {memberId = [memberId];}
		const params = {
			grid: groupId,
			members: memberId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/resetHiddenConversPin.js
const resetHiddenConversPinFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/hiddenconvers/reset`);
	/**
	* Reset hidden conversation pin
	*
	* @throws {ZaloApiError}
	*/
	return async function resetHiddenConversPin() {
		const encryptedParams = utils.encodeAES(JSON.stringify({}));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/reuseAvatar.js
const reuseAvatarFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/reuse-avatar`);
	/**
	* Reuse avatar
	*
	* @param photoId photo id from getAvatarList api
	*
	* @throws {ZaloApiError}
	*/
	return async function reuseAvatar(photoId) {
		const params = {
			photoId,
			isPostSocial: 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/reviewPendingMemberRequest.js
var ReviewPendingMemberRequestStatus;
(function(ReviewPendingMemberRequestStatus) {
	ReviewPendingMemberRequestStatus[ReviewPendingMemberRequestStatus["SUCCESS"] = 0] = "SUCCESS";
	ReviewPendingMemberRequestStatus[ReviewPendingMemberRequestStatus["NOT_IN_PENDING_LIST"] = 170] = "NOT_IN_PENDING_LIST";
	ReviewPendingMemberRequestStatus[ReviewPendingMemberRequestStatus["ALREADY_IN_GROUP"] = 178] = "ALREADY_IN_GROUP";
	ReviewPendingMemberRequestStatus[ReviewPendingMemberRequestStatus["INSUFFICIENT_PERMISSION"] = 166] = "INSUFFICIENT_PERMISSION";
})(ReviewPendingMemberRequestStatus || (ReviewPendingMemberRequestStatus = {}));
const reviewPendingMemberRequestFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/pending-mems/review`);
	/**
	* Review pending member(s) request
	*
	* @param payload - The payload containing data to review the pending member(s) request
	* @param groupId - The id of the group to review the pending member(s) request
	*
	* @note Only the group leader and deputy group leader can review
	*
	* @throws {ZaloApiError}
	*/
	return async function reviewPendingMemberRequest(payload, groupId) {
		if (!Array.isArray(payload.members)) {payload.members = [payload.members];}
		const params = {
			grid: groupId,
			members: payload.members,
			isApprove: payload.isApprove ? 1 : 0
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/searchSticker.js
const searchStickerFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.sticker[0]}/api/message/sticker/search`);
	/**
	* Search stickers
	*
	* @param keyword Keyword to search stickers
	* @param limit Limit of stickers to return (default: 50)
	*
	* @throws {ZaloApiError}
	*/
	return async function searchSticker(keyword, limit = 50) {
		const params = {
			keyword,
			limit,
			srcType: 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendBankCard.js
const sendBankCardFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.zimsg[0]}/api/transfer/card`);
	/**
	* Send bank card
	*
	* @param payload The payload containing the bank card information
	* @param threadId The ID of the thread to send the bank card to
	* @param type The type of thread to send the bank card to
	*
	* @throws {ZaloApiError}
	*/
	return async function sendBankCard(payload, threadId, type = ThreadType$1.User) {
		var _a;
		const params = {
			binBank: payload.binBank,
			numAccBank: payload.numAccBank,
			nameAccBank: ((_a = payload.nameAccBank) === null || _a === void 0 ? void 0 : _a.toUpperCase()) || "---",
			cliMsgId: Date.now().toString(),
			tsMsg: Date.now(),
			destUid: threadId,
			destType: type === ThreadType$1.Group ? 1 : 0
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendCard.js
const sendCardFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/message/forward`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/group/forward`)
	};
	/**
	* Send a card to a User - Group
	*
	* @param userId Unique ID for Card
	* @param phoneNumber Optional phone number for sending card to a User
	* @param ttl Time to live in milliseconds (default: 0)
	* @param threadId ID of the conversation
	* @param type Message type (User or GroupMessage)
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function sendCard(options, threadId, type = ThreadType$1.User) {
		var _a;
		const QRCodeURL = (await api.getQR(options.userId))[options.userId];
		const clientId = Date.now().toString();
		const params = {
			ttl: (_a = options.ttl) !== null && _a !== void 0 ? _a : 0,
			msgType: 6,
			clientId,
			msgInfo: {
				contactUid: options.userId,
				qrCodeUrl: QRCodeURL
			}
		};
		if (options.phoneNumber) {params.msgInfo.phone = options.phoneNumber;}
		if (type == ThreadType$1.Group) {
			params.visibility = 0;
			params.grid = threadId;
		} else {
			params.toId = threadId;
			params.imei = ctx.imei;
		}
		params.msgInfo = JSON.stringify(params.msgInfo);
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendDeliveredEvent.js
const sendDeliveredEventFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/deliveredv2`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/deliveredv2`)
	};
	/**
	* Send message delivered event
	*
	* @param isSeen Whether the message is seen or not
	* @param messages List of messages to send delivered event
	* @param type Messages type (User or Group), defaults to User
	*
	* @throws {ZaloApiError}
	*/
	return async function sendDeliveredEvent(isSeen, messages, type = ThreadType$1.User) {
		if (!messages) {throw new ZaloApiError("messages are missing or not in a valid array format.");}
		if (!Array.isArray(messages)) {messages = [messages];}
		if (messages.length === 0 || messages.length > 50) {throw new ZaloApiError("messages must contain between 1 and 50 messages.");}
		const idTo = messages[0].idTo;
		if (type === ThreadType$1.Group && !messages.every((msg) => msg.idTo === idTo)) {throw new ZaloApiError("All messages must have the same idTo for Group thread");}
		const msgInfos = Object.assign({
			seen: isSeen ? 1 : 0,
			data: messages.map((msg) => ({
				cmi: msg.cliMsgId,
				gmi: msg.msgId,
				si: msg.uidFrom,
				di: msg.idTo === ctx.uid ? "0" : msg.idTo,
				mt: msg.msgType,
				st: msg.st || 0 === msg.st ? 0 : -1,
				at: msg.at || 0 === msg.at ? 0 : -1,
				cmd: msg.cmd || 0 === msg.cmd ? 0 : -1,
				ts: parseInt(`${msg.ts}`) || 0 === parseInt(`${msg.ts}`) ? 0 : -1
			}))
		}, type === ThreadType$1.User ? {} : { grid: idTo });
		const params = Object.assign({ msgInfos: JSON.stringify(msgInfos) }, type === ThreadType$1.User ? {} : { imei: ctx.imei });
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendFriendRequest.js
const sendFriendRequestFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/sendreq`);
	/**
	* Send a friend request to a user.
	*
	* @param msg message sent with friend request
	* @param userId User ID to send friend request to
	*
	* @note Zalo might throw an error with code 225 if the user is already friends with you,
	*          215 if the user might have blocked you,
	*          222 if user has already sent you a friend request, your request will be treated as acceptance instead.
	*
	* @throws {ZaloApiError}
	*/
	return async function sendFriendRequest(msg, userId) {
		const params = {
			toid: userId,
			msg,
			reqsrc: 30,
			imei: ctx.imei,
			language: ctx.language,
			srcParams: JSON.stringify({ uidTo: userId })
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendLink.js
const sendLinkFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/link`, { nretry: 0 }),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/sendlink`, { nretry: 0 })
	};
	/**
	* Send link
	*
	* @param options Link and ttl
	* @param threadId Thread ID
	* @param type Thread type
	*
	* @throws {ZaloApiError}
	*/
	return async function sendLink(options, threadId, type = ThreadType$1.User) {
		var _a;
		const res = await api.parseLink(options.link);
		const params = {
			msg: options.msg && options.msg.trim() ? options.msg.includes(options.link) ? options.msg : options.msg + " " + options.link : options.link,
			href: res.data.href,
			src: res.data.src,
			title: res.data.title,
			desc: res.data.desc,
			thumb: res.data.thumb,
			type: 2,
			media: JSON.stringify(res.data.media),
			ttl: (_a = options.ttl) !== null && _a !== void 0 ? _a : 0,
			clientId: Date.now()
		};
		if (type == ThreadType$1.Group) {
			params.grid = threadId;
			params.imei = ctx.imei;
		} else {
			params.toId = threadId;
			params.mentionInfo = "";
		}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendMessage.js
const attachmentUrlType = {
	image: "photo_original/send?",
	gif: "gif?",
	video: "asyncfile/msg?",
	others: "asyncfile/msg?"
};
function prepareQMSGAttach(quote) {
	const quoteData = quote;
	if (typeof quoteData.content == "string") {return quoteData.propertyExt;}
	if (quoteData.msgType == "chat.todo") {return { properties: {
		color: 0,
		size: 0,
		type: 0,
		subType: 0,
		ext: "{\"shouldParseLinkOrContact\":0}"
	} };}
	return Object.assign(Object.assign({}, quoteData.content), {
		thumbUrl: quoteData.content.thumb,
		oriUrl: quoteData.content.href,
		normalUrl: quoteData.content.href
	});
}
function prepareQMSG(quote) {
	const quoteData = quote;
	if (quoteData.msgType == "chat.todo" && typeof quoteData.content == "object" && typeof quoteData.content.params == "string") {return JSON.parse(quoteData.content.params).item.content;}
	return "";
}
var TextStyle;
(function(TextStyle) {
	TextStyle["Bold"] = "b";
	TextStyle["Italic"] = "i";
	TextStyle["Underline"] = "u";
	TextStyle["StrikeThrough"] = "s";
	TextStyle["Red"] = "c_db342e";
	TextStyle["Orange"] = "c_f27806";
	TextStyle["Yellow"] = "c_f7b503";
	TextStyle["Green"] = "c_15a85f";
	TextStyle["Small"] = "f_13";
	TextStyle["Big"] = "f_18";
	TextStyle["UnorderedList"] = "lst_1";
	TextStyle["OrderedList"] = "lst_2";
	TextStyle["Indent"] = "ind_$";
})(TextStyle || (TextStyle = {}));
var Urgency;
(function(Urgency) {
	Urgency[Urgency["Default"] = 0] = "Default";
	Urgency[Urgency["Important"] = 1] = "Important";
	Urgency[Urgency["Urgent"] = 2] = "Urgent";
})(Urgency || (Urgency = {}));
const sendMessageFactory = apiFactory()((api, ctx, utils) => {
	const serviceURLs = {
		message: {
			[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message`, { nretry: 0 }),
			[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group`, { nretry: 0 })
		},
		attachment: {
			[ThreadType$1.User]: `${api.zpwServiceMap.file[0]}/api/message/`,
			[ThreadType$1.Group]: `${api.zpwServiceMap.file[0]}/api/group/`
		}
	};
	const { sharefile } = ctx.settings.features;
	function isExceedMaxFile(totalFile) {
		return totalFile > sharefile.max_file;
	}
	function isExceedMaxFileSize(fileSize) {
		return fileSize > sharefile.max_size_share_file_v3 * 1024 * 1024;
	}
	function getGroupLayoutId() {
		return Date.now();
	}
	async function send(data) {
		if (!Array.isArray(data)) {data = [data];}
		const requests = [];
		for (const each of data) {requests.push((async () => {
			return await resolveResponse(ctx, await utils.request(each.url, {
				method: "POST",
				body: each.body,
				headers: each.headers
			}));
		})());}
		return await Promise.all(requests);
	}
	async function upthumb(source, url) {
		const formData = new import_form_data.default();
		const buffer = typeof source == "string" ? await fs$1.readFile(source) : source.data;
		formData.append("fileContent", buffer, {
			filename: "blob",
			contentType: "image/png"
		});
		const params = {
			clientId: Date.now(),
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		return await resolveResponse(ctx, await utils.request(utils.makeURL(url + "upthumb?", { params: encryptedParams }), {
			method: "POST",
			headers: formData.getHeaders(),
			body: formData.getBuffer()
		}));
	}
	function handleMentions(type, msg, mentions) {
		let totalMentionLen = 0;
		const mentionsFinal = Array.isArray(mentions) && type == ThreadType$1.Group ? mentions.filter((m) => m.pos >= 0 && m.uid && m.len > 0).map((m) => {
			totalMentionLen += m.len;
			return {
				pos: m.pos,
				uid: m.uid,
				len: m.len,
				type: m.uid == "-1" ? 1 : 0
			};
		}) : [];
		if (totalMentionLen > msg.length) {throw new ZaloApiError("Invalid mentions: total mention characters exceed message length");}
		return {
			mentionsFinal,
			msgFinal: msg
		};
	}
	function handleStyles(params, styles) {
		if (styles) {Object.assign(params, { textProperties: JSON.stringify({
			styles: styles.map((e) => {
				var _a;
				const styleFinal = Object.assign(Object.assign({}, e), {
					indentSize: void 0,
					st: e.st == TextStyle.Indent ? TextStyle.Indent.replace(/\$/g, `${(_a = e.indentSize) !== null && _a !== void 0 ? _a : 1}0`) : e.st
				});
				removeUndefinedKeys(styleFinal);
				return styleFinal;
			}),
			ver: 0
		}) });}
	}
	function handleUrgency(params, urgency) {
		if (urgency == Urgency.Important || urgency == Urgency.Urgent) {Object.assign(params, { metaData: { urgency } });}
	}
	async function handleMessage({ msg, styles, urgency, mentions, quote, ttl }, threadId, type) {
		if (!msg || msg.length == 0) {throw new ZaloApiError("Missing message content");}
		const isGroupMessage = type == ThreadType$1.Group;
		const { mentionsFinal, msgFinal } = handleMentions(type, msg, mentions);
		msg = msgFinal;
		if (quote) {
			if (typeof quote.content != "string" && quote.msgType == "webchat") {throw new ZaloApiError("This kind of `webchat` quote type is not available");}
			if (quote.msgType == "group.poll") {throw new ZaloApiError("The `group.poll` quote type is not available");}
		}
		const isMentionsValid = mentionsFinal.length > 0 && isGroupMessage;
		const params = quote ? {
			toid: isGroupMessage ? void 0 : threadId,
			grid: isGroupMessage ? threadId : void 0,
			message: msg,
			clientId: Date.now(),
			mentionInfo: isMentionsValid ? JSON.stringify(mentionsFinal) : void 0,
			qmsgOwner: quote.uidFrom,
			qmsgId: quote.msgId,
			qmsgCliId: quote.cliMsgId,
			qmsgType: getClientMessageType(quote.msgType),
			qmsgTs: quote.ts,
			qmsg: typeof quote.content == "string" ? quote.content : prepareQMSG(quote),
			imei: isGroupMessage ? void 0 : ctx.imei,
			visibility: isGroupMessage ? 0 : void 0,
			qmsgAttach: isGroupMessage ? JSON.stringify(prepareQMSGAttach(quote)) : void 0,
			qmsgTTL: quote.ttl,
			ttl: ttl !== null && ttl !== void 0 ? ttl : 0
		} : {
			message: msg,
			clientId: Date.now(),
			mentionInfo: isMentionsValid ? JSON.stringify(mentionsFinal) : void 0,
			imei: isGroupMessage ? void 0 : ctx.imei,
			ttl: ttl !== null && ttl !== void 0 ? ttl : 0,
			visibility: isGroupMessage ? 0 : void 0,
			toid: isGroupMessage ? void 0 : threadId,
			grid: isGroupMessage ? threadId : void 0
		};
		handleStyles(params, styles);
		handleUrgency(params, urgency);
		removeUndefinedKeys(params);
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const finalServiceUrl = new URL(serviceURLs.message[type]);
		if (quote) {finalServiceUrl.pathname = finalServiceUrl.pathname + "/quote";}
		else {finalServiceUrl.pathname = finalServiceUrl.pathname + "/" + (isGroupMessage ? params.mentionInfo ? "mention" : "sendmsg" : "sms");}
		return {
			url: finalServiceUrl.toString(),
			body: new URLSearchParams({ params: encryptedParams })
		};
	}
	async function handleAttachment({ msg, attachments, mentions, quote, ttl, urgency }, threadId, type) {
		if (!attachments) {throw new ZaloApiError("Missing attachments");}
		if (!Array.isArray(attachments)) {attachments = [attachments];}
		if (attachments.length == 0) {throw new ZaloApiError("Missing attachments");}
		const firstSource = attachments[0];
		const firstExtFile = getFileExtension(typeof firstSource == "string" ? firstSource : firstSource.filename);
		const isSingleFile = attachments.length == 1;
		const isGroupMessage = type == ThreadType$1.Group;
		const canBeDesc = isSingleFile && [
			"jpg",
			"jpeg",
			"png",
			"webp"
		].includes(firstExtFile);
		const gifFiles = attachments.filter((e) => getFileExtension(typeof e == "string" ? e : e.filename) == "gif");
		attachments = attachments.filter((e) => getFileExtension(typeof e == "string" ? e : e.filename) != "gif");
		const uploadAttachment = attachments.length == 0 ? [] : await api.uploadAttachment(attachments, threadId, type);
		const attachmentsData = [];
		let indexInGroupLayout = 0;
		const groupLayoutId = getGroupLayoutId().toString();
		const { mentionsFinal, msgFinal } = handleMentions(type, msg, mentions);
		msg = msgFinal;
		const isMentionsValid = mentionsFinal.length > 0 && isGroupMessage && attachments.length == 1;
		const isMultiFile = attachments.length > 1;
		let clientId = Date.now();
		for (const attachment of uploadAttachment) {
			let data;
			switch (attachment.fileType) {
				case "image":
					data = {
						fileType: attachment.fileType,
						params: {
							photoId: attachment.photoId,
							clientId: (clientId++).toString(),
							desc: msg,
							width: attachment.width,
							height: attachment.height,
							toid: isGroupMessage ? void 0 : String(threadId),
							grid: isGroupMessage ? String(threadId) : void 0,
							rawUrl: attachment.normalUrl,
							hdUrl: attachment.hdUrl,
							thumbUrl: attachment.thumbUrl,
							oriUrl: isGroupMessage ? attachment.normalUrl : void 0,
							normalUrl: isGroupMessage ? void 0 : attachment.normalUrl,
							hdSize: String(attachment.totalSize),
							zsource: -1,
							ttl: ttl !== null && ttl !== void 0 ? ttl : 0,
							jcp: "{\"convertible\":\"jxl\"}",
							groupLayoutId: isMultiFile ? groupLayoutId : void 0,
							isGroupLayout: isMultiFile ? 1 : void 0,
							idInGroup: isMultiFile ? indexInGroupLayout++ : void 0,
							totalItemInGroup: isMultiFile ? uploadAttachment.length : void 0,
							extMsgProp: isMultiFile ? `{"groupMediaMsg":{"groupLayoutId":"${groupLayoutId}"}}` : void 0,
							mentionInfo: isMentionsValid && canBeDesc && !quote ? JSON.stringify(mentionsFinal) : void 0
						},
						body: new URLSearchParams()
					};
					break;
				case "video":
					data = {
						fileType: attachment.fileType,
						params: {
							fileId: attachment.fileId,
							checksum: attachment.checksum,
							checksumSha: "",
							extention: getFileExtension(attachment.fileName),
							totalSize: attachment.totalSize,
							fileName: attachment.fileName,
							clientId: attachment.clientFileId,
							fType: 1,
							fileCount: 0,
							fdata: "{}",
							toid: isGroupMessage ? void 0 : String(threadId),
							grid: isGroupMessage ? String(threadId) : void 0,
							fileUrl: attachment.fileUrl,
							zsource: -1,
							ttl: ttl !== null && ttl !== void 0 ? ttl : 0
						},
						body: new URLSearchParams()
					};
					break;
				case "others":
					data = {
						fileType: attachment.fileType,
						params: {
							fileId: attachment.fileId,
							checksum: attachment.checksum,
							checksumSha: "",
							extention: getFileExtension(attachment.fileName),
							totalSize: attachment.totalSize,
							fileName: attachment.fileName,
							clientId: attachment.clientFileId,
							fType: 1,
							fileCount: 0,
							fdata: "{}",
							toid: isGroupMessage ? void 0 : String(threadId),
							grid: isGroupMessage ? String(threadId) : void 0,
							fileUrl: attachment.fileUrl,
							zsource: -1,
							ttl: ttl !== null && ttl !== void 0 ? ttl : 0
						},
						body: new URLSearchParams()
					};
					break;
			}
			handleUrgency(data.params, urgency);
			removeUndefinedKeys(data.params);
			const encryptedParams = utils.encodeAES(JSON.stringify(data.params));
			if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
			data.body.append("params", encryptedParams);
			attachmentsData.push(data);
		}
		for (const gif of gifFiles) {
			const isFilePath = typeof gif == "string";
			const gifData = isFilePath ? await getGifMetaData(ctx, gif) : Object.assign(Object.assign({}, gif.metadata), { fileName: gif.filename });
			if (isExceedMaxFileSize(gifData.totalSize)) {throw new ZaloApiError(`File ${isFilePath ? getFileName(gif) : gif.filename} size exceed maximum size of ${sharefile.max_size_share_file_v3}MB`);}
			const _upthumb = await upthumb(gif, serviceURLs.attachment[ThreadType$1.User]);
			const formData = new import_form_data.default();
			formData.append("chunkContent", isFilePath ? await fs$1.readFile(gif) : gif.data, {
				filename: isFilePath ? getFileName(gif) : gif.filename,
				contentType: "application/octet-stream"
			});
			const params = {
				clientId: Date.now().toString(),
				fileName: gifData.fileName,
				totalSize: gifData.totalSize,
				width: gifData.width,
				height: gifData.height,
				msg,
				type: 1,
				ttl: ttl !== null && ttl !== void 0 ? ttl : 0,
				visibility: isGroupMessage ? 0 : void 0,
				toid: isGroupMessage ? void 0 : threadId,
				grid: isGroupMessage ? threadId : void 0,
				thumb: _upthumb.url,
				checksum: (await getMd5LargeFileObject(gif, gifData.totalSize)).data,
				totalChunk: 1,
				chunkId: 1
			};
			handleUrgency(params, urgency);
			removeUndefinedKeys(params);
			const encryptedParams = utils.encodeAES(JSON.stringify(params));
			if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
			attachmentsData.push({
				query: {
					params: encryptedParams,
					type: "1"
				},
				body: formData.getBuffer(),
				headers: formData.getHeaders(),
				fileType: "gif"
			});
		}
		const responses = [];
		for (const data of attachmentsData) {responses.push({
			url: utils.makeURL(serviceURLs.attachment[type] + attachmentUrlType[data.fileType], Object.assign({ nretry: "0" }, data.query || {})),
			body: data.body,
			headers: data.fileType == "gif" ? data.headers : {}
		});}
		return responses;
	}
	/**
	* Send a message to a thread
	*
	* @param message Message content
	* @param threadId group or user id
	* @param type Message type (User or Group)
	* @param quote Message or GroupMessage instance (optional), used for quoting
	*
	* @throws {ZaloApiError | ZaloApiMissingImageMetadataGetter}
	*/
	return async function sendMessage(message, threadId, type = ThreadType$1.User) {
		if (!message) {throw new ZaloApiError("Missing message content");}
		if (!threadId) {throw new ZaloApiError("Missing threadId");}
		if (typeof message == "string") {message = { msg: message };}
		let { msg, attachments, mentions } = message;
		const { quote, ttl, styles, urgency } = message;
		if (attachments && !Array.isArray(attachments)) {attachments = [attachments];}
		if (!msg && (!attachments || attachments && attachments.length == 0)) {throw new ZaloApiError("Missing message content");}
		if (attachments && isExceedMaxFile(attachments.length)) {throw new ZaloApiError("Exceed maximum file of " + sharefile.max_file);}
		const responses = {
			message: null,
			attachment: []
		};
		if (attachments && attachments.length > 0) {
			const firstExtFile = getFileExtension(typeof attachments[0] == "string" ? attachments[0] : attachments[0].filename);
			if (!(attachments.length == 1 && [
				"jpg",
				"jpeg",
				"png",
				"webp"
			].includes(firstExtFile)) && msg.length > 0 || msg.length > 0 && quote) {
				await handleMessage(message, threadId, type).then(async (data) => {
					responses.message = (await send(data))[0];
				});
				msg = "";
				mentions = void 0;
			}
			responses.attachment = await send(await handleAttachment({
				msg,
				mentions,
				attachments,
				quote,
				ttl,
				styles,
				urgency
			}, threadId, type));
			msg = "";
		}
		if (msg.length > 0) {responses.message = (await send(await handleMessage(message, threadId, type)))[0];}
		return responses;
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendReport.js
var ReportReason;
(function(ReportReason) {
	ReportReason[ReportReason["Sensitive"] = 1] = "Sensitive";
	ReportReason[ReportReason["Annoy"] = 2] = "Annoy";
	ReportReason[ReportReason["Fraud"] = 3] = "Fraud";
	ReportReason[ReportReason["Other"] = 0] = "Other";
})(ReportReason || (ReportReason = {}));
const sendReportFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/report/abuse-v2`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/reportabuse`)
	};
	/**
	* Send report to Zalo
	*
	* @param options Report options
	* @param threadId The threadID to report
	* @param type Thread type, default direct
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function sendReport(options, threadId, type = ThreadType$1.User) {
		const params = type == ThreadType$1.User ? {
			idTo: threadId,
			objId: "person.profile",
			reason: options.reason.toString(),
			content: options.reason == ReportReason.Other ? options.content : void 0
		} : {
			uidTo: threadId,
			type: 14,
			reason: options.reason,
			content: options.reason == ReportReason.Other ? options.content : "",
			imei: ctx.imei
		};
		removeUndefinedKeys(params);
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendSeenEvent.js
const sendSeenEventFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/seenv2`, { nretry: 0 }),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/seenv2`, { nretry: 0 })
	};
	/**
	* Send message seen event
	*
	* @param messages List of messages to send seen event
	* @param type Messages type (User or Group), defaults to User
	*
	* @throws {ZaloApiError}
	*/
	return async function sendSeenEvent(messages, type = ThreadType$1.User) {
		if (!messages) {throw new ZaloApiError("messages are missing or not in a valid array format.");}
		if (!Array.isArray(messages)) {messages = [messages];}
		if (messages.length === 0 || messages.length > 50) {throw new ZaloApiError("messages must contain between 1 and 50 messages.");}
		const isGroup = type === ThreadType$1.Group;
		const threadId = isGroup ? messages[0].idTo : messages[0].uidFrom;
		const msgInfos = {
			data: messages.map((msg) => {
				if ((isGroup ? msg.idTo : msg.uidFrom) !== threadId) {throw new ZaloApiError("All messages must belong to the same thread.");}
				return {
					cmi: msg.cliMsgId,
					gmi: msg.msgId,
					si: msg.uidFrom,
					di: msg.idTo === ctx.uid ? "0" : msg.idTo,
					mt: msg.msgType,
					st: msg.st || 0 === msg.st ? 0 : -1,
					at: msg.at || 0 === msg.at ? 0 : -1,
					cmd: msg.cmd || 0 === msg.cmd ? 0 : -1,
					ts: parseInt(`${msg.ts}`) || 0 === parseInt(`${msg.ts}`) ? 0 : -1
				};
			}),
			[isGroup ? "grid" : "senderId"]: threadId
		};
		const params = Object.assign({ msgInfos: JSON.stringify(msgInfos) }, isGroup ? { imei: ctx.imei } : {});
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendSticker.js
const sendStickerFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/sticker`, { nretry: "0" }),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/sticker`, { nretry: "0" })
	};
	/**
	* Send a sticker to a thread
	*
	* @param sticker Sticker object
	* @param threadId group or user id
	* @param type Message type (User or GroupMessage)
	*
	* @throws {ZaloApiError}
	*/
	return async function sendSticker(sticker, threadId, type = ThreadType$1.User) {
		if (!sticker) {throw new ZaloApiError("Missing sticker");}
		if (!threadId) {throw new ZaloApiError("Missing threadId");}
		if (!sticker.id) {throw new ZaloApiError("Missing sticker id");}
		if (sticker.cateId === void 0 || sticker.cateId === null) {throw new ZaloApiError("Missing sticker cateId");}
		if (!sticker.type) {throw new ZaloApiError("Missing sticker type");}
		const isGroupMessage = type === ThreadType$1.Group;
		const params = {
			stickerId: sticker.id,
			cateId: sticker.cateId,
			type: sticker.type,
			clientId: Date.now(),
			imei: ctx.imei,
			zsource: 101,
			toid: isGroupMessage ? void 0 : threadId,
			grid: isGroupMessage ? threadId : void 0
		};
		removeUndefinedKeys(params);
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendTypingEvent.js
const sendTypingEventFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/typing`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/typing`)
	};
	/**
	* Send typing event
	*
	* @param threadId The ID of the User or Group to send the typing event to
	* @param type The type of thread (User or Group)
	* @param destType The destination type (User or Page), for User threads only, defaults to User
	*
	* @throws {ZaloApiError}
	*/
	return async function sendTypingEvent(threadId, type = ThreadType$1.User, destType = DestType.User) {
		if (!threadId) {throw new ZaloApiError("Missing threadId");}
		const params = Object.assign(Object.assign({ [type === ThreadType$1.User ? "toid" : "grid"]: threadId }, type === ThreadType$1.User ? { destType } : {}), { imei: ctx.imei });
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendVideo.js
const sendVideoFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/message/forward`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/group/forward`)
	};
	/**
	* Send a video to a User - Group
	*
	* @param options send video options
	* @param threadId ID of the user or group to send the video to
	* @param type Type of thread (USER or GROUP)
	*
	* @throws {ZaloApiError}
	*
	* @examples Example Video Resolutions:
	*   - **Standard Videos**:
	*       - 3840x2160 (4K UHD): Width 3840px, Height 2160px.
	*       - 1920x1080 (Full HD): Width 1920px, Height 1080px.
	*       - 1280x720 (HD): Width 1280px, Height 720px.
	*   - **Document-Oriented Videos** (Portrait):
	*       - 3840x2160 (4K UHD): Width 3840px, Height 2160px.
	*       - 720x1280 (HD): Width 720px, Height 1280px.
	*       - 1440x2560 (2K): Width 1440px, Height 2560px.
	*
	*/
	return async function sendVideo(options, threadId, type = ThreadType$1.User) {
		var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
		let fileSize = 0;
		const clientId = Date.now();
		try {
			const headResponse = await utils.request(options.videoUrl, { method: "HEAD" }, true);
			if (headResponse.ok) {fileSize = parseInt(headResponse.headers.get("content-length") || "0");}
		} catch (error) {
			throw new ZaloApiError(`Unable to get video content: ${error instanceof Error ? error.message : String(error)}`);
		}
		const params = type === ThreadType$1.User ? {
			toId: threadId,
			clientId: String(clientId),
			ttl: (_a = options.ttl) !== null && _a !== void 0 ? _a : 0,
			zsource: 704,
			msgType: 5,
			msgInfo: JSON.stringify({
				videoUrl: options.videoUrl,
				thumbUrl: options.thumbnailUrl,
				duration: (_b = options.duration) !== null && _b !== void 0 ? _b : 0,
				width: (_c = options.width) !== null && _c !== void 0 ? _c : 1280,
				height: (_d = options.height) !== null && _d !== void 0 ? _d : 720,
				fileSize,
				properties: {
					color: -1,
					size: -1,
					type: 1003,
					subType: 0,
					ext: {
						sSrcType: -1,
						sSrcStr: "",
						msg_warning_type: 0
					}
				},
				title: (_e = options.msg) !== null && _e !== void 0 ? _e : ""
			}),
			imei: ctx.imei
		} : {
			grid: threadId,
			visibility: 0,
			clientId: String(clientId),
			ttl: (_f = options.ttl) !== null && _f !== void 0 ? _f : 0,
			zsource: 704,
			msgType: 5,
			msgInfo: JSON.stringify({
				videoUrl: options.videoUrl,
				thumbUrl: options.thumbnailUrl,
				duration: (_g = options.duration) !== null && _g !== void 0 ? _g : 0,
				width: (_h = options.width) !== null && _h !== void 0 ? _h : 1280,
				height: (_j = options.height) !== null && _j !== void 0 ? _j : 720,
				fileSize,
				properties: {
					color: -1,
					size: -1,
					type: 1003,
					subType: 0,
					ext: {
						sSrcType: -1,
						sSrcStr: "",
						msg_warning_type: 0
					}
				},
				title: (_k = options.msg) !== null && _k !== void 0 ? _k : ""
			}),
			imei: ctx.imei
		};
		if (type !== ThreadType$1.User && type !== ThreadType$1.Group) {throw new ZaloApiError("Thread type is invalid");}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sendVoice.js
const sendVoiceFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/message/forward`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/group/forward`)
	};
	/**
	* Send a voice to a User - Group
	*
	* @param options voice options
	* @param threadId ID of the user or group to send the voice to
	* @param type Type of thread, default user
	*
	* @throws {ZaloApiError}
	*/
	return async function sendVoice(options, threadId, type = ThreadType$1.User) {
		var _a, _b;
		let fileSize = null;
		const clientId = Date.now().toString();
		try {
			const headResponse = await utils.request(options.voiceUrl, { method: "HEAD" }, true);
			if (headResponse.ok) {fileSize = parseInt(headResponse.headers.get("content-length") || "0");}
		} catch (error) {
			throw new ZaloApiError(`Unable to get voice content: ${error instanceof Error ? error.message : String(error)}`);
		}
		const params = type === ThreadType$1.User ? {
			toId: threadId,
			ttl: (_a = options.ttl) !== null && _a !== void 0 ? _a : 0,
			zsource: -1,
			msgType: 3,
			clientId,
			msgInfo: JSON.stringify({
				voiceUrl: options.voiceUrl,
				m4aUrl: options.voiceUrl,
				fileSize: fileSize !== null && fileSize !== void 0 ? fileSize : 0
			}),
			imei: ctx.imei
		} : {
			grid: threadId,
			visibility: 0,
			ttl: (_b = options.ttl) !== null && _b !== void 0 ? _b : 0,
			zsource: -1,
			msgType: 3,
			clientId,
			msgInfo: JSON.stringify({
				voiceUrl: options.voiceUrl,
				m4aUrl: options.voiceUrl,
				fileSize: fileSize !== null && fileSize !== void 0 ? fileSize : 0
			}),
			imei: ctx.imei
		};
		if (type !== ThreadType$1.User && type !== ThreadType$1.Group) {throw new ZaloApiError("Thread type is invalid");}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/setHiddenConversations.js
const setHiddenConversationsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/hiddenconvers/add-remove`);
	/**
	* Set hidden conversations
	*
	* @param hidden - Hide or unhide conversations
	* @param threadId Thread ID(s)
	* @param type Thread type (User/Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function setHiddenConversations(hidden, threadId, type = ThreadType$1.User) {
		threadId = Array.isArray(threadId) ? threadId : [threadId];
		if (threadId.length === 0) {throw new ZaloApiError("threadId is required");}
		const is_group = type === ThreadType$1.Group ? 1 : 0;
		const params = {
			[hidden ? "add_threads" : "del_threads"]: JSON.stringify(threadId.map((id) => ({
				thread_id: id,
				is_group
			}))),
			[hidden ? "del_threads" : "add_threads"]: "[]",
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/setMute.js
var MuteDuration;
(function(MuteDuration) {
	MuteDuration[MuteDuration["ONE_HOUR"] = 3600] = "ONE_HOUR";
	MuteDuration[MuteDuration["FOUR_HOURS"] = 14400] = "FOUR_HOURS";
	MuteDuration[MuteDuration["FOREVER"] = -1] = "FOREVER";
	MuteDuration["UNTIL_8AM"] = "until8AM";
})(MuteDuration || (MuteDuration = {}));
var MuteAction;
(function(MuteAction) {
	MuteAction[MuteAction["MUTE"] = 1] = "MUTE";
	MuteAction[MuteAction["UNMUTE"] = 3] = "UNMUTE";
})(MuteAction || (MuteAction = {}));
const setMuteFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/setmute`);
	/**
	* Set mute
	*
	* @param params - Mute parameters
	* @param threadID - ID of the thread to mute
	* @param type - Type of thread (User or Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function setMute(params = {}, threadID, type = ThreadType$1.User) {
		const { duration = MuteDuration.FOREVER, action = MuteAction.MUTE } = params;
		let muteDuration;
		if (action === MuteAction.UNMUTE) {muteDuration = -1;}
		else if (duration === MuteDuration.FOREVER) {muteDuration = -1;}
		else if (duration === MuteDuration.UNTIL_8AM) {
			const now = /* @__PURE__ */ new Date();
			const next8AM = new Date(now);
			next8AM.setHours(8, 0, 0, 0);
			if (now.getHours() >= 8) {next8AM.setDate(next8AM.getDate() + 1);}
			muteDuration = Math.floor((next8AM.getTime() - now.getTime()) / 1e3);
		} else {muteDuration = duration;}
		const requestParams = {
			toid: threadID,
			duration: muteDuration,
			action,
			startTime: Math.floor(Date.now() / 1e3),
			muteType: type === ThreadType$1.User ? 1 : 2,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(requestParams));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/setPinnedConversations.js
const setPinnedConversationsFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/pinconvers/updatev2`);
	/**
	* Pin and unpin conversations of threads)
	*
	* @param pinned Should pin conversations
	* @param threadId The ID(s) of the thread
	* @param type Type of thread, default User
	*
	* @throws {ZaloApiError}
	*
	*/
	return async function setPinnedConversations(pinned, threadId, type = ThreadType$1.User) {
		if (typeof threadId == "string") {threadId = [threadId];}
		const params = {
			actionType: pinned ? 1 : 2,
			conversations: type == ThreadType$1.Group ? threadId.map((id) => `g${id}`) : threadId.map((id) => `u${id}`)
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/sharePoll.js
const sharePollFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/poll/share`);
	/**
	* Share a poll
	*
	* @param pollId poll id to share
	*
	* @throws {ZaloApiError}
	*/
	return async function sharePoll(pollId) {
		const params = {
			poll_id: pollId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/unblockUser.js
const unblockUserFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/unblock`);
	/**
	* Unblock a User
	*
	* @param userId The ID of the User to unblock
	*
	* @throws {ZaloApiError}
	*/
	return async function unblockUser(userId) {
		const params = {
			fid: userId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/undo.js
const undoFactory = apiFactory()((api, ctx, utils) => {
	const URLType = {
		[ThreadType$1.User]: utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/undo`),
		[ThreadType$1.Group]: utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/undomsg`)
	};
	/**
	* Undo a message
	*
	* @param payload Undo payload containing message ID and client message ID
	* @param threadId group or user id
	* @param type Message type (User or Group), default is User
	*
	* @throws {ZaloApiError}
	*/
	return async function undo(payload, threadId, type = ThreadType$1.User) {
		const params = {
			msgId: payload.msgId,
			clientId: Date.now(),
			cliMsgIdUndo: payload.cliMsgId
		};
		if (type == ThreadType$1.Group) {
			params["grid"] = threadId;
			params["visibility"] = 0;
			params["imei"] = ctx.imei;
		} else {params["toid"] = threadId;}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(URLType[type], {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/undoFriendRequest.js
const undoFriendRequestFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.friend[0]}/api/friend/undo`);
	/**
	* Undo send a friend request to a user.
	*
	* @param options
	*
	* @throws {ZaloApiError}
	*/
	return async function undoFriendRequest(friendId) {
		const params = { fid: friendId };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateActiveStatus.js
const updateActiveStatusFactory = apiFactory()((api, ctx, utils) => {
	const pingURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/ping`);
	const deactiveURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/deactive`);
	/**
	* Update active status?
	*
	* @param active
	*
	* @throws {ZaloApiError}
	*/
	return async function updateActiveStatus(active) {
		const params = {
			status: active ? 1 : 0,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const targetURL = active ? pingURL : deactiveURL;
		const response = await utils.request(utils.makeURL(targetURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateArchivedChatList.js
const updateArchivedChatListFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.label[0]}/api/archivedchat/update`);
	/**
	* Archive conversations
	*
	* @param isArchived - true to archive, false to unarchive
	* @param conversations - List of conversations to archive/unarchive
	*
	* @throws {ZaloApiError}
	*/
	return async function updateArchivedChatList(isArchived, conversations) {
		if (!Array.isArray(conversations)) {conversations = [conversations];}
		const params = {
			actionType: isArchived ? 0 : 1,
			ids: conversations,
			imei: ctx.imei,
			version: Date.now()
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateAutoDeleteChat.js
var ChatTTL;
(function(ChatTTL) {
	ChatTTL[ChatTTL["NO_DELETE"] = 0] = "NO_DELETE";
	ChatTTL[ChatTTL["ONE_DAY"] = 864e5] = "ONE_DAY";
	ChatTTL[ChatTTL["SEVEN_DAYS"] = 6048e5] = "SEVEN_DAYS";
	ChatTTL[ChatTTL["FOURTEEN_DAYS"] = 12096e5] = "FOURTEEN_DAYS";
})(ChatTTL || (ChatTTL = {}));
const updateAutoDeleteChatFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/conv/autodelete/updateConvers`);
	/**
	* Auto delete chat
	*
	* @param ttl The time to live of the chat
	* @param threadId The thread ID to auto delete chat
	* @param type Type of thread (User or Group)
	*
	* @throws {ZaloApiError}
	*/
	return async function updateAutoDeleteChat(ttl, threadId, type = ThreadType$1.User) {
		const params = {
			threadId,
			isGroup: type === ThreadType$1.Group ? 1 : 0,
			ttl,
			clientLang: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateAutoReply.js
const updateAutoReplyFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.auto_reply[0]}/api/autoreply/update`);
	/**
	* Update auto reply
	*
	* @param payload payload
	*
	* @note this API used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function updateAutoReply(payload) {
		const uids = Array.isArray(payload.uids) ? payload.uids : [payload.uids];
		const resultUids = payload.scope === 2 || payload.scope === 3 ? uids : [];
		const params = {
			cliLang: ctx.language,
			id: payload.id,
			enable: payload.isEnable,
			content: payload.content,
			startTime: payload.startTime,
			endTime: payload.endTime,
			recurrence: ["RRULE:FREQ=DAILY;"],
			scope: payload.scope,
			uids: resultUids
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateCatalog.js
const updateCatalogFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.catalog[0]}/api/prodcatalog/catalog/update`);
	/**
	* Update catalog?
	*
	* @param payload payload
	*
	* @note this API is used for zBusiness
	* @throws {ZaloApiError}
	*/
	return async function updateCatalog(payload) {
		const params = {
			catalog_id: payload.catalogId,
			catalog_name: payload.catalogName,
			catalog_photo: ""
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateGroupSettings.js
const updateGroupSettingsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/setting/update`);
	/**
	* Update group settings
	*
	* @param options Options
	* @param groupId Group ID
	*
	* @note Zalo might throw an error with code 166 if you don't have enough permissions to change the settings.
	*
	* @throws {ZaloApiError}
	*/
	return async function updateGroupSettings(options, groupId) {
		const params = {
			blockName: options.blockName ? 1 : 0,
			signAdminMsg: options.signAdminMsg ? 1 : 0,
			setTopicOnly: options.setTopicOnly ? 1 : 0,
			enableMsgHistory: options.enableMsgHistory ? 1 : 0,
			joinAppr: options.joinAppr ? 1 : 0,
			lockCreatePost: options.lockCreatePost ? 1 : 0,
			lockCreatePoll: options.lockCreatePoll ? 1 : 0,
			lockSendMsg: options.lockSendMsg ? 1 : 0,
			lockViewMember: options.lockViewMember ? 1 : 0,
			bannFeature: 0,
			dirtyMedia: 0,
			banDuration: 0,
			blocked_members: [],
			grid: groupId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateHiddenConversPin.js
const updateHiddenConversPinFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.conversation[0]}/api/hiddenconvers/update-pin`);
	const pinRegex = /^\d{4}$/;
	/**
	* Update hidden conversation pin
	*
	* @param pin The pin to update (must be a 4-digit number between 0000-9999)
	*
	* @throws {ZaloApiError}
	*/
	return async function updateHiddenConversPin(pin) {
		if (!pinRegex.test(pin)) {throw new ZaloApiError("Pin must be a 4-digit number between 0000-9999");}
		const params = {
			new_pin: encryptPin(pin),
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateLabels.js
const updateLabelsFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.label[0]}/api/convlabel/update`);
	/**
	* Update labels
	*
	* @param label label data
	*
	* @throws {ZaloApiError}
	*/
	return async function updateLabels(payload) {
		const params = {
			labelData: JSON.stringify(payload.labelData),
			version: payload.version,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		const unFormatted = await utils.resolve(response);
		return {
			labelData: JSON.parse(unFormatted.labelData),
			version: unFormatted.version,
			lastUpdateTime: unFormatted.lastUpdateTime
		};
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateLang.js
var UpdateLangAvailableLanguages;
(function(UpdateLangAvailableLanguages) {
	UpdateLangAvailableLanguages["VI"] = "VI";
	UpdateLangAvailableLanguages["EN"] = "EN";
})(UpdateLangAvailableLanguages || (UpdateLangAvailableLanguages = {}));
const updateLangFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/updatelang`);
	/**
	* Update language?
	*
	* @param language language to update (VI, EN)
	*
	* @note Calling this API alone will not update the user's language.
	* @throws {ZaloApiError}
	*/
	return async function updateLang(language = UpdateLangAvailableLanguages.VI) {
		const params = { language };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateProductCatalog.js
const updateProductCatalogFactory = apiFactory()((api, _, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.catalog[0]}/api/prodcatalog/product/update`);
	/**
	* Update product catalog?
	*
	* @param payload payload
	*
	* @note this API is used for zBusiness - Maximum 5 media files are supported
	* @throws {ZaloApiError}
	*/
	return async function updateProductCatalog(payload) {
		const productPhoto = payload.product_photos || [];
		if (payload.files && payload.files.length == 0) {
			if (payload.files.length > 5) {throw new ZaloApiError("Maximum 5 media files are allowed");}
			for (const mediaFile of payload.files) {
				const uploadMedia = await api.uploadProductPhoto({ file: mediaFile });
				const url = uploadMedia.normalUrl || uploadMedia.hdUrl;
				productPhoto.push(url);
			}
		}
		if (productPhoto.length > 5) {throw new ZaloApiError("Maximum 5 media files are allowed");}
		const params = {
			product_id: payload.productId,
			product_name: payload.productName,
			price: payload.price,
			description: payload.description,
			product_photos: productPhoto,
			catalog_id: payload.catalogId,
			currency_unit: "₫",
			create_time: payload.createTime
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateProfile.js
const updateProfileFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/update`);
	/**
	* Change account setting information
	*
	* @param payload payload
	*
	* @note If your account is a Business Account, include the biz.cate field; otherwise the category will be removed.
	* You may leave the other biz fields empty if you don’t want to change them.
	*
	* @throws {ZaloApiError}
	*/
	return async function updateProfile(payload) {
		var _a, _b, _c, _d, _e;
		const params = {
			profile: JSON.stringify({
				name: payload.profile.name,
				dob: payload.profile.dob,
				gender: payload.profile.gender
			}),
			biz: JSON.stringify({
				desc: (_a = payload.biz) === null || _a === void 0 ? void 0 : _a.description,
				cate: (_b = payload.biz) === null || _b === void 0 ? void 0 : _b.cate,
				addr: (_c = payload.biz) === null || _c === void 0 ? void 0 : _c.address,
				website: (_d = payload.biz) === null || _d === void 0 ? void 0 : _d.website,
				email: (_e = payload.biz) === null || _e === void 0 ? void 0 : _e.email
			}),
			language: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(serviceURL, {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateProfileBio.js
const updateProfileBioFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/status`);
	/**
	* Update profile bio
	*
	* @param status status for update bio
	*
	* @throws {ZaloApiError}
	*/
	return async function updateProfileBio(status) {
		const params = { status };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), {
			method: "POST",
			body: new URLSearchParams({ params: encryptedParams })
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateQuickMessage.js
const updateQuickMessageFactory = apiFactory()((api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.quick_message[0]}/api/quickmessage/update`);
	/**
	* Update quick message
	*
	* @param updatePayload - The payload containing data to update the quick message
	* @param itemId - The id of the quick message to update
	*
	* @note Zalo might throw an error with code 212 if the itemId does not exist.
	*
	* @throws {ZaloApiError}
	*/
	return async function updateQuickMessage(updatePayload, itemId) {
		const isType = !updatePayload.media ? 0 : 1;
		const params = {
			itemId,
			keyword: updatePayload.keyword,
			message: {
				title: updatePayload.title,
				params: ""
			},
			type: isType
		};
		if (isType === 1) {
			if (!updatePayload.media) {throw new ZaloApiError("Media is required");}
			const uploadMedia = await api.uploadProductPhoto({ file: updatePayload.media });
			const photoId = uploadMedia.photoId;
			const thumbUrl = uploadMedia.thumbUrl;
			const normalUrl = uploadMedia.normalUrl;
			const hdUrl = uploadMedia.hdUrl;
			params.media = { items: [{
				type: 0,
				photoId,
				title: "",
				width: "",
				height: "",
				previewThumb: thumbUrl,
				rawUrl: normalUrl || hdUrl,
				thumbUrl,
				normalUrl: normalUrl || hdUrl,
				hdUrl: hdUrl || normalUrl
			}] };
		}
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/updateSettings.js
var UpdateSettingsType;
(function(UpdateSettingsType) {
	UpdateSettingsType["ViewBirthday"] = "view_birthday";
	UpdateSettingsType["ShowOnlineStatus"] = "show_online_status";
	UpdateSettingsType["DisplaySeenStatus"] = "display_seen_status";
	UpdateSettingsType["ReceiveMessage"] = "receive_message";
	UpdateSettingsType["AcceptCall"] = "accept_stranger_call";
	UpdateSettingsType["AddFriendViaPhone"] = "add_friend_via_phone";
	UpdateSettingsType["AddFriendViaQR"] = "add_friend_via_qr";
	UpdateSettingsType["AddFriendViaGroup"] = "add_friend_via_group";
	UpdateSettingsType["AddFriendViaContact"] = "add_friend_via_contact";
	UpdateSettingsType["DisplayOnRecommendFriend"] = "display_on_recommend_friend";
	UpdateSettingsType["ArchivedChat"] = "archivedChatStatus";
	UpdateSettingsType["QuickMessage"] = "quickMessageStatus";
})(UpdateSettingsType || (UpdateSettingsType = {}));
const updateSettingsFactory = apiFactory()((_api, _ctx, utils) => {
	const serviceURL = utils.makeURL(`https://wpa.chat.zalo.me/api/setting/update`);
	/**
	* Set account settings
	*
	* @param type The type of setting to update
	* @param value
	*
	* ViewBirthday
	* * 0: hide
	* * 1: show full day/month/year
	* * 2: show day/month
	*
	* ShowOnlineStatus
	* * 0: hide
	* * 1: show
	*
	* DisplaySeenStatus
	* * 0: hide
	* * 1: show
	*
	* ReceiveMessage
	* * 1: everyone
	* * 2: only friends
	*
	* AcceptCall
	* * 2: only friends
	* * 3: everyone
	* * 4: friends and person who contacted
	*
	* AddFriendViaPhone
	* * 0: disable
	* * 1: enable
	*
	* AddFriendViaQR
	* * 0: disable
	* * 1: enable
	*
	* AddFriendViaGroup
	* * 0: disable
	* * 1: enable
	*
	* AddFriendViaContact
	* * 0: disable
	* * 1: enable
	*
	* DisplayOnRecommendFriend
	* * 0: disable
	* * 1: enable
	*
	* ArchivedChat
	* * 0: disable
	* * 1: enable
	*
	* QuickMessage
	* * 0: disable
	* * 1: enable
	*
	* @throws {ZaloApiError}
	*/
	return async function updateSettings(type, value) {
		const params = { [type]: value };
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/upgradeGroupToCommunity.js
const upgradeGroupToCommunityFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/upgrade/community`);
	/**
	* Upgrade group to community
	*
	* @param groupId Group ID upgrade
	*
	* @note Zalo account identity must be verified and the account must be over 18 to use
	* @code 185 The limit on the number of communities that can own has been reached
	* @throws {ZaloApiError}
	*/
	return async function upgradeGroupToCommunity(groupId) {
		const params = {
			grId: groupId,
			language: ctx.language
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/uploadAttachment.js
const urlType = {
	image: "photo_original/upload",
	video: "asyncfile/upload",
	others: "asyncfile/upload"
};
const uploadAttachmentFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = `${api.zpwServiceMap.file[0]}/api`;
	const { sharefile } = ctx.settings.features;
	function isExceedMaxFile(totalFile) {
		return totalFile > sharefile.max_file;
	}
	function isExceedMaxFileSize(fileSize) {
		return fileSize > sharefile.max_size_share_file_v3 * 1024 * 1024;
	}
	function isExtensionValid(ext) {
		return sharefile.restricted_ext_file.indexOf(ext) == -1;
	}
	/**
	* Upload an attachment to a thread
	*
	* @param sources path to files or attachment sources
	* @param threadId Group or User ID
	* @param type Message type (User or Group)
	*
	* @throws {ZaloApiError | ZaloApiMissingImageMetadataGetter}
	*/
	return async function uploadAttachment(sources, threadId, type = ThreadType$1.User) {
		if (!sources) {throw new ZaloApiError("Missing sources");}
		if (!Array.isArray(sources)) {sources = [sources];}
		if (sources.length == 0) {throw new ZaloApiError("Missing sources");}
		if (isExceedMaxFile(sources.length)) {throw new ZaloApiError("Exceed maximum file of " + sharefile.max_file);}
		if (!threadId) {throw new ZaloApiError("Missing threadId");}
		const chunkSize = ctx.settings.features.sharefile.chunk_size_file;
		const isGroupMessage = type == ThreadType$1.Group;
		const attachmentsData = [];
		const url = `${serviceURL}/${isGroupMessage ? "group" : "message"}/`;
		const typeParam = isGroupMessage ? "11" : "2";
		let clientId = Date.now();
		for (const source of sources) {
			const isFilePath = typeof source == "string";
			const isBuffer = typeof source == "object" && source.data instanceof Buffer;
			if (!isFilePath && !isBuffer) {throw new ZaloApiError("Invalid source type");}
			if (!isFilePath && !source.filename) {throw new ZaloApiError("Missing filename");}
			if (isFilePath && !fs.existsSync(source)) {throw new ZaloApiError("File not found");}
			const extFile = getFileExtension(isFilePath ? source : source.filename).toLowerCase();
			const fileName = isFilePath ? getFileName(source) : source.filename;
			if (!isExtensionValid(extFile)) {throw new ZaloApiError(`File extension "${extFile}" is not allowed`);}
			const data = {
				filePath: isFilePath ? source : source.filename,
				chunkContent: [],
				params: {},
				source
			};
			if (isGroupMessage) {data.params.grid = threadId;}
			else {data.params.toid = threadId;}
			switch (extFile) {
				case "jpg":
				case "jpeg":
				case "png":
				case "webp": {
					const imageData = isFilePath ? await getImageMetaData(ctx, source) : Object.assign(Object.assign({}, source.metadata), { fileName });
					if (isExceedMaxFileSize(imageData.totalSize)) {throw new ZaloApiError(`File ${fileName} size exceed maximum size of ${sharefile.max_size_share_file_v3}MB`);}
					data.fileData = imageData;
					data.fileType = "image";
					data.params.totalChunk = Math.ceil(data.fileData.totalSize / chunkSize);
					data.params.fileName = fileName;
					data.params.clientId = clientId++;
					data.params.totalSize = imageData.totalSize;
					data.params.imei = ctx.imei;
					data.params.isE2EE = 0;
					data.params.jxl = 0;
					data.params.chunkId = 1;
					break;
				}
				case "mp4": {
					const videoSize = isFilePath ? await getFileSize(source) : source.metadata.totalSize;
					if (isExceedMaxFileSize(videoSize)) {throw new ZaloApiError(`File ${fileName} size exceed maximum size of ${sharefile.max_size_share_file_v3}MB`);}
					data.fileType = "video";
					data.fileData = {
						fileName,
						totalSize: videoSize
					};
					data.params.totalChunk = Math.ceil(data.fileData.totalSize / chunkSize);
					data.params.fileName = fileName;
					data.params.clientId = clientId++;
					data.params.totalSize = videoSize;
					data.params.imei = ctx.imei;
					data.params.isE2EE = 0;
					data.params.jxl = 0;
					data.params.chunkId = 1;
					break;
				}
				default: {
					const fileSize = isFilePath ? await getFileSize(source) : source.metadata.totalSize;
					if (isExceedMaxFileSize(fileSize)) {throw new ZaloApiError(`File ${fileName} size exceed maximum size of ${sharefile.max_size_share_file_v3}MB`);}
					data.fileType = "others";
					data.fileData = {
						fileName,
						totalSize: fileSize
					};
					data.params.totalChunk = Math.ceil(data.fileData.totalSize / chunkSize);
					data.params.fileName = fileName;
					data.params.clientId = clientId++;
					data.params.totalSize = fileSize;
					data.params.imei = ctx.imei;
					data.params.isE2EE = 0;
					data.params.jxl = 0;
					data.params.chunkId = 1;
					break;
				}
			}
			const fileBuffer = isFilePath ? await fs.promises.readFile(source) : source.data;
			for (let i = 0; i < data.params.totalChunk; i++) {
				const formData = new import_form_data.default();
				const slicedBuffer = fileBuffer.subarray(i * chunkSize, (i + 1) * chunkSize);
				formData.append("chunkContent", slicedBuffer, {
					filename: fileName,
					contentType: "application/octet-stream"
				});
				data.chunkContent[i] = formData;
			}
			attachmentsData.push(data);
		}
		const requests = [], results = [];
		for (let atmIndex = 0; atmIndex < attachmentsData.length; atmIndex++) {
			const data = attachmentsData[atmIndex];
			for (let i = 0; i < data.params.totalChunk; i++) {
				const encryptedParams = utils.encodeAES(JSON.stringify(data.params));
				if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt message");}
				requests.push(utils.request(utils.makeURL(url + urlType[data.fileType], {
					type: typeParam,
					params: encryptedParams
				}), {
					method: "POST",
					headers: data.chunkContent[i].getHeaders(),
					body: data.chunkContent[i].getBuffer()
				}).then(async (response) => {
					/**
					* @TODO: better type rather than any
					*/
					const resData = await resolveResponse(ctx, response);
					if (resData && resData.fileId != "-1" && resData.photoId != "-1") {await new Promise((resolve) => {
						if (data.fileType == "video" || data.fileType == "others") {
							const uploadCallback = async (wsData) => {
								results[atmIndex] = Object.assign(Object.assign(Object.assign({ fileType: data.fileType }, resData), wsData), {
									totalSize: data.fileData.totalSize,
									fileName: data.fileData.fileName,
									checksum: (await getMd5LargeFileObject(data.source, data.fileData.totalSize)).data
								});
								resolve();
							};
							ctx.uploadCallbacks.set(resData.fileId.toString(), uploadCallback);
						}
						if (data.fileType == "image") {
							results[atmIndex] = {
								fileType: "image",
								width: data.fileData.width,
								height: data.fileData.height,
								totalSize: data.fileData.totalSize,
								hdSize: data.fileData.totalSize,
								finished: resData.finished,
								normalUrl: resData.normalUrl,
								hdUrl: resData.hdUrl,
								thumbUrl: resData.thumbUrl,
								chunkId: resData.chunkId,
								photoId: resData.photoId,
								clientFileId: resData.clientFileId
							};
							resolve();
						}
					});}
				}));
				data.params.chunkId++;
			}
		}
		await Promise.all(requests);
		return results;
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/uploadProductPhoto.js
const uploadProductPhotoFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.file[0]}/api/product/upload/photo`);
	/**
	* Upload product photo for api quick message, product catalog or custom local storage
	*
	* @param payload file path or attachment source
	*
	* @throws {ZaloApiError | ZaloApiMissingImageMetadataGetter}
	*/
	return async function uploadProductPhoto(payload) {
		const isSourceFilePath = typeof payload.file == "string";
		const fileSize = (isSourceFilePath ? await getImageMetaData(ctx, payload.file) : payload.file.metadata).totalSize || 0;
		const fileBuffer = isSourceFilePath ? await fs.promises.readFile(payload.file) : payload.file.data;
		const formData = new import_form_data.default();
		formData.append("chunkContent", fileBuffer, {
			filename: "undefined",
			contentType: "application/octet-stream"
		});
		const params = {
			totalChunk: 1,
			fileName: `Base64_Img_Picker_${Date.now()}.jpg`,
			clientId: Date.now(),
			totalSize: fileSize,
			imei: ctx.imei,
			chunkId: 1,
			toid: ctx.loginInfo.send2me_id,
			featureId: 1
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), {
			method: "POST",
			headers: formData.getHeaders(),
			body: formData.getBuffer()
		});
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/votePoll.js
const votePollFactory = apiFactory()((api, ctx, utils) => {
	const serviceURL = utils.makeURL(`${api.zpwServiceMap.group[0]}/api/poll/vote`);
	/**
	* Vote on a poll
	*
	* @param pollId The ID of the poll to vote on
	* @param optionId The ID(s) of the option to vote on
	*
	* @throws ZaloApiError
	*/
	return async function votePoll(pollId, optionId) {
		if (!Array.isArray(optionId)) {optionId = [optionId];}
		const params = {
			poll_id: pollId,
			option_ids: optionId,
			imei: ctx.imei
		};
		const encryptedParams = utils.encodeAES(JSON.stringify(params));
		if (!encryptedParams) {throw new ZaloApiError("Failed to encrypt params");}
		const response = await utils.request(utils.makeURL(serviceURL, { params: encryptedParams }), { method: "GET" });
		return utils.resolve(response);
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis/custom.js
const customFactory = apiFactory()((api, ctx, utils) => {
	return function custom(name, callback) {
		Object.defineProperty(api, name, {
			value: function(props) {
				return callback({
					ctx,
					utils,
					props
				});
			},
			writable: false,
			enumerable: false,
			configurable: false
		});
	};
});
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/apis.js
var API = class {
	constructor(ctx, zpwServiceMap, wsUrls) {
		this.zpwServiceMap = zpwServiceMap;
		this.listener = new Listener(ctx, wsUrls);
		this.acceptFriendRequest = acceptFriendRequestFactory(ctx, this);
		this.addGroupBlockedMember = addGroupBlockedMemberFactory(ctx, this);
		this.addGroupDeputy = addGroupDeputyFactory(ctx, this);
		this.addPollOptions = addPollOptionsFactory(ctx, this);
		this.addQuickMessage = addQuickMessageFactory(ctx, this);
		this.addReaction = addReactionFactory(ctx, this);
		this.addUnreadMark = addUnreadMarkFactory(ctx, this);
		this.addUserToGroup = addUserToGroupFactory(ctx, this);
		this.blockUser = blockUserFactory(ctx, this);
		this.blockViewFeed = blockViewFeedFactory(ctx, this);
		this.changeAccountAvatar = changeAccountAvatarFactory(ctx, this);
		this.changeFriendAlias = changeFriendAliasFactory(ctx, this);
		this.changeGroupAvatar = changeGroupAvatarFactory(ctx, this);
		this.changeGroupName = changeGroupNameFactory(ctx, this);
		this.changeGroupOwner = changeGroupOwnerFactory(ctx, this);
		this.createAutoReply = createAutoReplyFactory(ctx, this);
		this.createCatalog = createCatalogFactory(ctx, this);
		this.createGroup = createGroupFactory(ctx, this);
		this.createNote = createNoteFactory(ctx, this);
		this.createPoll = createPollFactory(ctx, this);
		this.createProductCatalog = createProductCatalogFactory(ctx, this);
		this.createReminder = createReminderFactory(ctx, this);
		this.deleteAutoReply = deleteAutoReplyFactory(ctx, this);
		this.deleteAvatar = deleteAvatarFactory(ctx, this);
		this.deleteCatalog = deleteCatalogFactory(ctx, this);
		this.deleteChat = deleteChatFactory(ctx, this);
		this.deleteGroupInviteBox = deleteGroupInviteBoxFactory(ctx, this);
		this.deleteMessage = deleteMessageFactory(ctx, this);
		this.deleteProductCatalog = deleteProductCatalogFactory(ctx, this);
		this.disableGroupLink = disableGroupLinkFactory(ctx, this);
		this.disperseGroup = disperseGroupFactory(ctx, this);
		this.editNote = editNoteFactory(ctx, this);
		this.editReminder = editReminderFactory(ctx, this);
		this.enableGroupLink = enableGroupLinkFactory(ctx, this);
		this.fetchAccountInfo = fetchAccountInfoFactory(ctx, this);
		this.findUser = findUserFactory(ctx, this);
		this.findUserByUsername = findUserByUsernameFactory(ctx, this);
		this.forwardMessage = forwardMessageFactory(ctx, this);
		this.getAliasList = getAliasListFactory(ctx, this);
		this.getAllFriends = getAllFriendsFactory(ctx, this);
		this.getAllGroups = getAllGroupsFactory(ctx, this);
		this.getArchivedChatList = getArchivedChatListFactory(ctx, this);
		this.getAutoDeleteChat = getAutoDeleteChatFactory(ctx, this);
		this.getAutoReplyList = getAutoReplyListFactory(ctx, this);
		this.getAvatarList = getAvatarListFactory(ctx, this);
		this.getAvatarUrlProfile = getAvatarUrlProfileFactory(ctx, this);
		this.getBizAccount = getBizAccountFactory(ctx, this);
		this.getCatalogList = getCatalogListFactory(ctx, this);
		this.getCloseFriends = getCloseFriendsFactory(ctx, this);
		this.getContext = getContextFactory(ctx, this);
		this.getCookie = getCookieFactory(ctx, this);
		this.getFriendBoardList = getFriendBoardListFactory(ctx, this);
		this.getFriendOnlines = getFriendOnlinesFactory(ctx, this);
		this.getFriendRecommendations = getFriendRecommendationsFactory(ctx, this);
		this.getFriendRequestStatus = getFriendRequestStatusFactory(ctx, this);
		this.getFullAvatar = getFullAvatarFactory(ctx, this);
		this.getGroupBlockedMember = getGroupBlockedMemberFactory(ctx, this);
		this.getGroupChatHistory = getGroupChatHistoryFactory(ctx, this);
		this.getGroupInfo = getGroupInfoFactory(ctx, this);
		this.getGroupInviteBoxInfo = getGroupInviteBoxInfoFactory(ctx, this);
		this.getGroupInviteBoxList = getGroupInviteBoxListFactory(ctx, this);
		this.getGroupLinkDetail = getGroupLinkDetailFactory(ctx, this);
		this.getGroupLinkInfo = getGroupLinkInfoFactory(ctx, this);
		this.getGroupMembersInfo = getGroupMembersInfoFactory(ctx, this);
		this.getHiddenConversations = getHiddenConversationsFactory(ctx, this);
		this.getLabels = getLabelsFactory(ctx, this);
		this.getListBoard = getListBoardFactory(ctx, this);
		this.getListReminder = getListReminderFactory(ctx, this);
		this.getMultiUsersByPhones = getMultiUsersByPhonesFactory(ctx, this);
		this.getMute = getMuteFactory(ctx, this);
		this.getOwnId = getOwnIdFactory(ctx, this);
		this.getPendingGroupMembers = getPendingGroupMembersFactory(ctx, this);
		this.getPinConversations = getPinConversationsFactory(ctx, this);
		this.getPollDetail = getPollDetailFactory(ctx, this);
		this.getProductCatalogList = getProductCatalogListFactory(ctx, this);
		this.getQR = getQRFactory(ctx, this);
		this.getQuickMessageList = getQuickMessageListFactory(ctx, this);
		this.getRelatedFriendGroup = getRelatedFriendGroupFactory(ctx, this);
		this.getReminder = getReminderFactory(ctx, this);
		this.getReminderResponses = getReminderResponsesFactory(ctx, this);
		this.getSentFriendRequest = getSentFriendRequestFactory(ctx, this);
		this.getSettings = getSettingsFactory(ctx, this);
		this.getStickerCategoryDetail = getStickerCategoryDetailFactory(ctx, this);
		this.getStickers = getStickersFactory(ctx, this);
		this.getStickersDetail = getStickersDetailFactory(ctx, this);
		this.getUnreadMark = getUnreadMarkFactory(ctx, this);
		this.getUserInfo = getUserInfoFactory(ctx, this);
		this.inviteUserToGroups = inviteUserToGroupsFactory(ctx, this);
		this.joinGroupInviteBox = joinGroupInviteBoxFactory(ctx, this);
		this.joinGroupLink = joinGroupLinkFactory(ctx, this);
		this.keepAlive = keepAliveFactory(ctx, this);
		this.lastOnline = lastOnlineFactory(ctx, this);
		this.leaveGroup = leaveGroupFactory(ctx, this);
		this.lockPoll = lockPollFactory(ctx, this);
		this.parseLink = parseLinkFactory(ctx, this);
		this.rejectFriendRequest = rejectFriendRequestFactory(ctx, this);
		this.removeFriend = removeFriendFactory(ctx, this);
		this.removeFriendAlias = removeFriendAliasFactory(ctx, this);
		this.removeGroupBlockedMember = removeGroupBlockedMemberFactory(ctx, this);
		this.removeGroupDeputy = removeGroupDeputyFactory(ctx, this);
		this.removeQuickMessage = removeQuickMessageFactory(ctx, this);
		this.removeReminder = removeReminderFactory(ctx, this);
		this.removeUnreadMark = removeUnreadMarkFactory(ctx, this);
		this.removeUserFromGroup = removeUserFromGroupFactory(ctx, this);
		this.resetHiddenConversPin = resetHiddenConversPinFactory(ctx, this);
		this.reuseAvatar = reuseAvatarFactory(ctx, this);
		this.reviewPendingMemberRequest = reviewPendingMemberRequestFactory(ctx, this);
		this.searchSticker = searchStickerFactory(ctx, this);
		this.sendBankCard = sendBankCardFactory(ctx, this);
		this.sendCard = sendCardFactory(ctx, this);
		this.sendDeliveredEvent = sendDeliveredEventFactory(ctx, this);
		this.sendFriendRequest = sendFriendRequestFactory(ctx, this);
		this.sendLink = sendLinkFactory(ctx, this);
		this.sendMessage = sendMessageFactory(ctx, this);
		this.sendReport = sendReportFactory(ctx, this);
		this.sendSeenEvent = sendSeenEventFactory(ctx, this);
		this.sendSticker = sendStickerFactory(ctx, this);
		this.sendTypingEvent = sendTypingEventFactory(ctx, this);
		this.sendVideo = sendVideoFactory(ctx, this);
		this.sendVoice = sendVoiceFactory(ctx, this);
		this.setHiddenConversations = setHiddenConversationsFactory(ctx, this);
		this.setMute = setMuteFactory(ctx, this);
		this.setPinnedConversations = setPinnedConversationsFactory(ctx, this);
		this.sharePoll = sharePollFactory(ctx, this);
		this.unblockUser = unblockUserFactory(ctx, this);
		this.undo = undoFactory(ctx, this);
		this.undoFriendRequest = undoFriendRequestFactory(ctx, this);
		this.updateActiveStatus = updateActiveStatusFactory(ctx, this);
		this.updateArchivedChatList = updateArchivedChatListFactory(ctx, this);
		this.updateAutoDeleteChat = updateAutoDeleteChatFactory(ctx, this);
		this.updateAutoReply = updateAutoReplyFactory(ctx, this);
		this.updateCatalog = updateCatalogFactory(ctx, this);
		this.updateGroupSettings = updateGroupSettingsFactory(ctx, this);
		this.updateHiddenConversPin = updateHiddenConversPinFactory(ctx, this);
		this.updateLabels = updateLabelsFactory(ctx, this);
		this.updateLang = updateLangFactory(ctx, this);
		this.updateProductCatalog = updateProductCatalogFactory(ctx, this);
		this.updateProfile = updateProfileFactory(ctx, this);
		this.updateProfileBio = updateProfileBioFactory(ctx, this);
		this.updateQuickMessage = updateQuickMessageFactory(ctx, this);
		this.updateSettings = updateSettingsFactory(ctx, this);
		this.upgradeGroupToCommunity = upgradeGroupToCommunityFactory(ctx, this);
		this.uploadAttachment = uploadAttachmentFactory(ctx, this);
		this.uploadProductPhoto = uploadProductPhotoFactory(ctx, this);
		this.votePoll = votePollFactory(ctx, this);
		this.custom = customFactory(ctx, this);
	}
};
//#endregion
//#region node_modules/.pnpm/zca-js@2.1.1/node_modules/zca-js/dist/zalo.js
var Zalo$1 = class {
	constructor(options = {}) {
		this.options = options;
		this.enableEncryptParam = true;
	}
	parseCookies(cookie) {
		const cookieArr = Array.isArray(cookie) ? cookie : cookie.cookies;
		cookieArr.forEach((e, i) => {
			if (typeof e.domain == "string" && e.domain.startsWith(".")) {cookieArr[i].domain = e.domain.slice(1);}
		});
		const jar = new import_cookie.CookieJar();
		for (const each of cookieArr) {try {
			const cookieObj = import_cookie.Cookie.fromJSON(Object.assign(Object.assign({}, each), { key: each.key || each.name }));
			if (cookieObj) {
				const domain = cookieObj.domain || "chat.zalo.me";
				const url = `https://${domain.startsWith(".") ? domain.slice(1) : domain}`;
				jar.setCookieSync(cookieObj, url);
			}
		} catch (error) {
			logger({ options: { logging: this.options.logging } }).error("Failed to set cookie:", error);
		}}
		return jar;
	}
	validateParams(credentials) {
		if (!credentials.imei || !credentials.cookie || !credentials.userAgent) {throw new ZaloApiError("Missing required params");}
	}
	async login(credentials) {
		const ctx = createContext(this.options.apiType, this.options.apiVersion);
		Object.assign(ctx.options, this.options);
		return this.loginCookie(ctx, credentials);
	}
	async loginCookie(ctx, credentials) {
		await checkUpdate(ctx);
		this.validateParams(credentials);
		ctx.imei = credentials.imei;
		ctx.cookie = this.parseCookies(credentials.cookie);
		ctx.userAgent = credentials.userAgent;
		ctx.language = credentials.language || "vi";
		const loginData = await login(ctx, this.enableEncryptParam);
		const serverInfo = await getServerInfo(ctx, this.enableEncryptParam);
		const loginInfo = loginData === null || loginData === void 0 ? void 0 : loginData.data;
		if (!loginData || !loginInfo || !serverInfo) {throw new ZaloApiError("Đăng nhập thất bại");}
		ctx.secretKey = loginInfo.zpw_enk;
		ctx.uid = loginInfo.uid;
		ctx.settings = serverInfo.setttings || serverInfo.settings;
		ctx.extraVer = serverInfo.extra_ver;
		ctx.loginInfo = loginInfo;
		if (!isContextSession(ctx)) {throw new ZaloApiError("Khởi tạo ngữ cảnh thất bại.");}
		logger(ctx).info("Logged in as", loginInfo.uid);
		return new API(ctx, loginInfo.zpw_service_map_v3, loginInfo.zpw_ws);
	}
	async loginQR(options, callback) {
		if (!options) {options = {};}
		if (!options.userAgent) {options.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";}
		if (!options.language) {options.language = "vi";}
		const ctx = createContext(this.options.apiType, this.options.apiVersion);
		Object.assign(ctx.options, this.options);
		const loginQRResult = await loginQR(ctx, options, callback);
		if (!loginQRResult) {throw new ZaloApiError("Unable to login with QRCode");}
		const imei = generateZaloUUID(options.userAgent);
		if (callback) {callback({
			type: LoginQRCallbackEventType$1.GotLoginInfo,
			data: {
				cookie: loginQRResult.cookies,
				imei,
				userAgent: options.userAgent
			},
			actions: null
		});}
		return this.loginCookie(ctx, {
			cookie: loginQRResult.cookies,
			imei,
			userAgent: options.userAgent,
			language: options.language
		});
	}
};
//#endregion
//#region extensions/zalouser/src/zca-client.ts
const zcaJs = /* @__PURE__ */ __exportAll({
	API: () => API,
	AutoReplyScope: () => AutoReplyScope,
	AvatarSize: () => AvatarSize,
	BinBankCard: () => BinBankCard,
	BoardType: () => BoardType,
	BusinessCategory: () => BusinessCategory,
	BusinessCategoryName: () => BusinessCategoryName,
	ChatTTL: () => ChatTTL,
	CloseReason: () => CloseReason,
	DestType: () => DestType,
	FriendEventType: () => FriendEventType,
	FriendRecommendationsType: () => FriendRecommendationsType,
	Gender: () => Gender,
	GroupDeliveredMessage: () => GroupDeliveredMessage,
	GroupEventType: () => GroupEventType,
	GroupMessage: () => GroupMessage,
	GroupSeenMessage: () => GroupSeenMessage,
	GroupTopicType: () => GroupTopicType,
	GroupType: () => GroupType,
	GroupTyping: () => GroupTyping,
	LoginQRCallbackEventType: () => LoginQRCallbackEventType$1,
	MuteAction: () => MuteAction,
	MuteDuration: () => MuteDuration,
	Reaction: () => Reaction,
	Reactions: () => Reactions$1,
	ReminderRepeatMode: () => ReminderRepeatMode,
	ReportReason: () => ReportReason,
	ReviewPendingMemberRequestStatus: () => ReviewPendingMemberRequestStatus,
	TextStyle: () => TextStyle,
	ThreadType: () => ThreadType$1,
	Undo: () => Undo,
	UpdateLangAvailableLanguages: () => UpdateLangAvailableLanguages,
	UpdateSettingsType: () => UpdateSettingsType,
	Urgency: () => Urgency,
	UserDeliveredMessage: () => UserDeliveredMessage,
	UserMessage: () => UserMessage,
	UserSeenMessage: () => UserSeenMessage,
	UserTyping: () => UserTyping,
	Zalo: () => Zalo$1,
	ZaloApiError: () => ZaloApiError,
	ZaloApiLoginQRAborted: () => ZaloApiLoginQRAborted,
	ZaloApiLoginQRDeclined: () => ZaloApiLoginQRDeclined,
	ZaloApiMissingImageMetadataGetter: () => ZaloApiMissingImageMetadataGetter,
	initializeFriendEvent: () => initializeFriendEvent,
	initializeGroupEvent: () => initializeGroupEvent
});
zcaJs.ThreadType;
const LoginQRCallbackEventType = zcaJs.LoginQRCallbackEventType;
const Reactions = zcaJs.Reactions;
const Zalo = zcaJs.Zalo;
new Map([
	["like", Reactions.LIKE],
	["👍", Reactions.LIKE],
	[":+1:", Reactions.LIKE],
	["heart", Reactions.HEART],
	["❤️", Reactions.HEART],
	["<3", Reactions.HEART],
	["haha", Reactions.HAHA],
	["laugh", Reactions.HAHA],
	["😂", Reactions.HAHA],
	["wow", Reactions.WOW],
	["😮", Reactions.WOW],
	["cry", Reactions.CRY],
	["😢", Reactions.CRY],
	["angry", Reactions.ANGRY],
	["😡", Reactions.ANGRY]
]);
//#endregion
//#region extensions/zalouser/src/runtime.ts
const { setRuntime: setZalouserRuntime, getRuntime: getZalouserRuntime } = createPluginRuntimeStore("Zalouser runtime not initialized");
//#endregion
//#region extensions/zalouser/src/zalo-js.ts
const API_LOGIN_TIMEOUT_MS = 2e4;
const QR_LOGIN_TTL_MS = 3 * 6e4;
const DEFAULT_QR_START_TIMEOUT_MS = 3e4;
const DEFAULT_QR_WAIT_TIMEOUT_MS = 12e4;
const GROUP_INFO_CHUNK_SIZE = 80;
const apiByProfile = /* @__PURE__ */ new Map();
const apiInitByProfile = /* @__PURE__ */ new Map();
const activeQrLogins = /* @__PURE__ */ new Map();
const activeListeners = /* @__PURE__ */ new Map();
const groupContextCache = /* @__PURE__ */ new Map();
function resolveStateDir(env = process.env) {
	return getZalouserRuntime().state.resolveStateDir(env, os.homedir);
}
function resolveCredentialsDir(env = process.env) {
	return path.join(resolveStateDir(env), "credentials", "zalouser");
}
function credentialsFilename(profile) {
	const trimmed = profile.trim().toLowerCase();
	if (!trimmed || trimmed === "default") {return "credentials.json";}
	return `credentials-${encodeURIComponent(trimmed)}.json`;
}
function resolveCredentialsPath(profile, env = process.env) {
	return path.join(resolveCredentialsDir(env), credentialsFilename(profile));
}
function withTimeout(promise, timeoutMs, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(label));
		}, timeoutMs);
		promise.then((result) => {
			clearTimeout(timer);
			resolve(result);
		}).catch((err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeProfile(profile) {
	const trimmed = profile?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : "default";
}
function toErrorMessage(error) {
	if (error instanceof Error) {return error.message;}
	return String(error);
}
function normalizeAccountInfoUser(info) {
	if (!info || typeof info !== "object") {return null;}
	if ("profile" in info) {
		const profile = info.profile;
		if (profile && typeof profile === "object") {return profile;}
		return null;
	}
	return info;
}
function mapFriend(friend) {
	return {
		userId: String(friend.userId),
		displayName: friend.displayName || friend.zaloName || friend.username || String(friend.userId),
		avatar: friend.avatar || void 0
	};
}
function mapGroup(groupId, group) {
	const totalMember = typeof group.totalMember === "number" && Number.isFinite(group.totalMember) ? group.totalMember : void 0;
	return {
		groupId: String(groupId),
		name: group.name?.trim() || String(groupId),
		memberCount: totalMember
	};
}
function readCredentials(profile) {
	const filePath = resolveCredentialsPath(profile);
	try {
		if (!fs.existsSync(filePath)) {return null;}
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.imei !== "string" || !parsed.imei || !parsed.cookie || typeof parsed.userAgent !== "string" || !parsed.userAgent) {return null;}
		return {
			imei: parsed.imei,
			cookie: parsed.cookie,
			userAgent: parsed.userAgent,
			language: typeof parsed.language === "string" ? parsed.language : void 0,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
			lastUsedAt: typeof parsed.lastUsedAt === "string" ? parsed.lastUsedAt : void 0
		};
	} catch {
		return null;
	}
}
function touchCredentials(profile) {
	const existing = readCredentials(profile);
	if (!existing) {return;}
	const next = {
		...existing,
		lastUsedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	const dir = resolveCredentialsDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(resolveCredentialsPath(profile), JSON.stringify(next, null, 2), "utf-8");
}
function writeCredentials(profile, credentials) {
	const dir = resolveCredentialsDir();
	fs.mkdirSync(dir, { recursive: true });
	const existing = readCredentials(profile);
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const next = {
		...credentials,
		createdAt: existing?.createdAt ?? now,
		lastUsedAt: now
	};
	fs.writeFileSync(resolveCredentialsPath(profile), JSON.stringify(next, null, 2), "utf-8");
}
function clearCredentials(profile) {
	const filePath = resolveCredentialsPath(profile);
	try {
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
			return true;
		}
	} catch {}
	return false;
}
async function ensureApi(profileInput, timeoutMs = API_LOGIN_TIMEOUT_MS) {
	const profile = normalizeProfile(profileInput);
	const cached = apiByProfile.get(profile);
	if (cached) {return cached;}
	const pending = apiInitByProfile.get(profile);
	if (pending) {return await pending;}
	const initPromise = (async () => {
		const stored = readCredentials(profile);
		if (!stored) {throw new Error(`No saved Zalo session for profile \"${profile}\"`);}
		const api = await withTimeout(new Zalo({
			logging: false,
			selfListen: false
		}).login({
			imei: stored.imei,
			cookie: stored.cookie,
			userAgent: stored.userAgent,
			language: stored.language
		}), timeoutMs, `Timed out restoring Zalo session for profile "${profile}"`);
		apiByProfile.set(profile, api);
		touchCredentials(profile);
		return api;
	})();
	apiInitByProfile.set(profile, initPromise);
	try {
		return await initPromise;
	} catch (error) {
		apiByProfile.delete(profile);
		throw error;
	} finally {
		apiInitByProfile.delete(profile);
	}
}
function invalidateApi(profileInput) {
	const profile = normalizeProfile(profileInput);
	const api = apiByProfile.get(profile);
	if (api) {try {
		api.listener.stop();
	} catch {}}
	apiByProfile.delete(profile);
	apiInitByProfile.delete(profile);
}
function isQrLoginFresh(login) {
	return Date.now() - login.startedAt < QR_LOGIN_TTL_MS;
}
function resetQrLogin(profileInput) {
	const profile = normalizeProfile(profileInput);
	const active = activeQrLogins.get(profile);
	if (!active) {return;}
	try {
		active.abort?.();
	} catch {}
	activeQrLogins.delete(profile);
}
async function fetchGroupsByIds(api, ids) {
	const result = /* @__PURE__ */ new Map();
	for (let index = 0; index < ids.length; index += GROUP_INFO_CHUNK_SIZE) {
		const chunk = ids.slice(index, index + GROUP_INFO_CHUNK_SIZE);
		if (chunk.length === 0) {continue;}
		const map = (await api.getGroupInfo(chunk)).gridInfoMap ?? {};
		for (const [groupId, info] of Object.entries(map)) {result.set(groupId, info);}
	}
	return result;
}
function clearCachedGroupContext(profile) {
	for (const key of groupContextCache.keys()) {if (key.startsWith(`${profile}:`)) groupContextCache.delete(key);}
}
function zalouserSessionExists(profileInput) {
	return readCredentials(normalizeProfile(profileInput)) !== null;
}
async function checkZaloAuthenticated(profileInput) {
	const profile = normalizeProfile(profileInput);
	if (!zalouserSessionExists(profile)) {return false;}
	try {
		await withTimeout((await ensureApi(profile, 12e3)).fetchAccountInfo(), 12e3, "Timed out checking Zalo session");
		return true;
	} catch {
		invalidateApi(profile);
		return false;
	}
}
async function getZaloUserInfo(profileInput) {
	const user = normalizeAccountInfoUser(await (await ensureApi(normalizeProfile(profileInput))).fetchAccountInfo());
	if (!user?.userId) {return null;}
	return {
		userId: String(user.userId),
		displayName: user.displayName || user.zaloName || String(user.userId),
		avatar: user.avatar || void 0
	};
}
async function listZaloFriends(profileInput) {
	return (await (await ensureApi(normalizeProfile(profileInput))).getAllFriends()).map(mapFriend);
}
async function listZaloGroups(profileInput) {
	const api = await ensureApi(normalizeProfile(profileInput));
	const allGroups = await api.getAllGroups();
	const ids = Object.keys(allGroups.gridVerMap ?? {});
	if (ids.length === 0) {return [];}
	const details = await fetchGroupsByIds(api, ids);
	const rows = [];
	for (const id of ids) {
		const info = details.get(id);
		if (!info) {
			rows.push({
				groupId: id,
				name: id
			});
			continue;
		}
		rows.push(mapGroup(id, info));
	}
	return rows;
}
async function startZaloQrLogin(params) {
	const profile = normalizeProfile(params.profile);
	if (!params.force && await checkZaloAuthenticated(profile)) {
		const info = await getZaloUserInfo(profile).catch(() => null);
		return { message: `Zalo is already linked${info?.displayName ? ` (${info.displayName})` : ""}.` };
	}
	if (params.force) {await logoutZaloProfile(profile);}
	const existing = activeQrLogins.get(profile);
	if (existing && isQrLoginFresh(existing)) {
		if (existing.qrDataUrl) {return {
			qrDataUrl: existing.qrDataUrl,
			message: "QR already active. Scan it with the Zalo app."
		};}
	} else if (existing) {resetQrLogin(profile);}
	if (!activeQrLogins.has(profile)) {
		const login = {
			id: randomUUID(),
			profile,
			startedAt: Date.now(),
			connected: false,
			waitPromise: Promise.resolve()
		};
		login.waitPromise = (async () => {
			let capturedCredentials = null;
			try {
				const api = await new Zalo({
					logging: false,
					selfListen: false
				}).loginQR(void 0, (event) => {
					const current = activeQrLogins.get(profile);
					if (!current || current.id !== login.id) {return;}
					if (event.actions?.abort) {current.abort = () => {
						try {
							event.actions?.abort?.();
						} catch {}
					};}
					switch (event.type) {
						case LoginQRCallbackEventType.QRCodeGenerated: {
							const image = event.data.image.replace(/^data:image\/png;base64,/, "");
							current.qrDataUrl = image.startsWith("data:image") ? image : `data:image/png;base64,${image}`;
							break;
						}
						case LoginQRCallbackEventType.QRCodeExpired:
							try {
								event.actions.retry();
							} catch {
								current.error = "QR expired before confirmation. Start login again.";
							}
							break;
						case LoginQRCallbackEventType.QRCodeDeclined:
							current.error = "QR login was declined on the phone.";
							break;
						case LoginQRCallbackEventType.GotLoginInfo:
							capturedCredentials = {
								imei: event.data.imei,
								cookie: event.data.cookie,
								userAgent: event.data.userAgent
							};
							break;
						default: break;
					}
				});
				const current = activeQrLogins.get(profile);
				if (!current || current.id !== login.id) {return;}
				if (!capturedCredentials) {
					const ctx = api.getContext();
					const cookieJson = api.getCookie().toJSON();
					capturedCredentials = {
						imei: ctx.imei,
						cookie: cookieJson?.cookies ?? [],
						userAgent: ctx.userAgent,
						language: ctx.language
					};
				}
				writeCredentials(profile, capturedCredentials);
				invalidateApi(profile);
				apiByProfile.set(profile, api);
				current.connected = true;
			} catch (error) {
				const current = activeQrLogins.get(profile);
				if (current && current.id === login.id) {current.error = toErrorMessage(error);}
			}
		})();
		activeQrLogins.set(profile, login);
	}
	const active = activeQrLogins.get(profile);
	if (!active) {return { message: "Failed to initialize Zalo QR login." };}
	const timeoutMs = Math.max(params.timeoutMs ?? DEFAULT_QR_START_TIMEOUT_MS, 3e3);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (active.error) {
			resetQrLogin(profile);
			return { message: `Failed to start QR login: ${active.error}` };
		}
		if (active.connected) {
			resetQrLogin(profile);
			return { message: "Zalo already connected." };
		}
		if (active.qrDataUrl) {return {
			qrDataUrl: active.qrDataUrl,
			message: "Scan this QR with the Zalo app."
		};}
		await delay(150);
	}
	return { message: "Still preparing QR. Call wait to continue checking login status." };
}
async function waitForZaloQrLogin(params) {
	const profile = normalizeProfile(params.profile);
	const active = activeQrLogins.get(profile);
	if (!active) {
		const connected = await checkZaloAuthenticated(profile);
		return {
			connected,
			message: connected ? "Zalo session is ready." : "No active Zalo QR login in progress."
		};
	}
	if (!isQrLoginFresh(active)) {
		resetQrLogin(profile);
		return {
			connected: false,
			message: "QR login expired. Start again to generate a fresh QR code."
		};
	}
	const timeoutMs = Math.max(params.timeoutMs ?? DEFAULT_QR_WAIT_TIMEOUT_MS, 1e3);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (active.error) {
			const message = `Zalo login failed: ${active.error}`;
			resetQrLogin(profile);
			return {
				connected: false,
				message
			};
		}
		if (active.connected) {
			resetQrLogin(profile);
			return {
				connected: true,
				message: "Login successful."
			};
		}
		await Promise.race([active.waitPromise, delay(400)]);
	}
	return {
		connected: false,
		message: "Still waiting for QR scan confirmation."
	};
}
async function logoutZaloProfile(profileInput) {
	const profile = normalizeProfile(profileInput);
	resetQrLogin(profile);
	clearCachedGroupContext(profile);
	const listener = activeListeners.get(profile);
	if (listener) {
		try {
			listener.stop();
		} catch {}
		activeListeners.delete(profile);
	}
	invalidateApi(profile);
	const cleared = clearCredentials(profile);
	return {
		cleared,
		loggedOut: true,
		message: cleared ? "Logged out and cleared local session." : "No local session to clear."
	};
}
async function resolveZaloGroupsByEntries(params) {
	const groups = await listZaloGroups(params.profile);
	const byName = /* @__PURE__ */ new Map();
	for (const group of groups) {
		const key = group.name.trim().toLowerCase();
		if (!key) {continue;}
		const list = byName.get(key) ?? [];
		list.push(group);
		byName.set(key, list);
	}
	return params.entries.map((input) => {
		const trimmed = input.trim();
		if (!trimmed) {return {
			input,
			resolved: false
		};}
		if (/^\d+$/.test(trimmed)) {return {
			input,
			resolved: true,
			id: trimmed
		};}
		const match = (byName.get(trimmed.toLowerCase()) ?? [])[0];
		return match ? {
			input,
			resolved: true,
			id: match.groupId
		} : {
			input,
			resolved: false
		};
	});
}
async function resolveZaloAllowFromEntries(params) {
	const friends = await listZaloFriends(params.profile);
	const byName = /* @__PURE__ */ new Map();
	for (const friend of friends) {
		const key = friend.displayName.trim().toLowerCase();
		if (!key) {continue;}
		const list = byName.get(key) ?? [];
		list.push(friend);
		byName.set(key, list);
	}
	return params.entries.map((input) => {
		const trimmed = input.trim();
		if (!trimmed) {return {
			input,
			resolved: false
		};}
		if (/^\d+$/.test(trimmed)) {return {
			input,
			resolved: true,
			id: trimmed
		};}
		const matches = byName.get(trimmed.toLowerCase()) ?? [];
		const match = matches[0];
		if (!match) {return {
			input,
			resolved: false
		};}
		return {
			input,
			resolved: true,
			id: match.userId,
			note: matches.length > 1 ? "multiple matches; chose first" : void 0
		};
	});
}
//#endregion
//#region extensions/zalouser/src/accounts.ts
const { listAccountIds: listZalouserAccountIds, resolveDefaultAccountId: resolveDefaultZalouserAccountId } = createAccountListHelpers("zalouser");
function resolveAccountConfig(cfg, accountId) {
	const accounts = (cfg.channels?.zalouser)?.accounts;
	if (!accounts || typeof accounts !== "object") {return;}
	return accounts[accountId];
}
function mergeZalouserAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignored2, ...base } = cfg.channels?.zalouser ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	return {
		...base,
		...account
	};
}
function resolveProfile(config, accountId) {
	if (config.profile?.trim()) {return config.profile.trim();}
	if (process.env.ZALOUSER_PROFILE?.trim()) {return process.env.ZALOUSER_PROFILE.trim();}
	if (process.env.ZCA_PROFILE?.trim()) {return process.env.ZCA_PROFILE.trim();}
	if (accountId !== "default") {return accountId;}
	return "default";
}
function resolveZalouserAccountBase(params) {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = (params.cfg.channels?.zalouser)?.enabled !== false;
	const merged = mergeZalouserAccountConfig(params.cfg, accountId);
	return {
		accountId,
		enabled: baseEnabled && merged.enabled !== false,
		merged,
		profile: resolveProfile(merged, accountId)
	};
}
function resolveZalouserAccountSync(params) {
	const { accountId, enabled, merged, profile } = resolveZalouserAccountBase(params);
	return {
		accountId,
		name: merged.name?.trim() || void 0,
		enabled,
		profile,
		authenticated: false,
		config: merged
	};
}
//#endregion
//#region extensions/zalouser/src/qr-temp-file.ts
async function writeQrDataUrlToTempFile(qrDataUrl, profile) {
	const base64 = (qrDataUrl.trim().match(/^data:image\/png;base64,(.+)$/i)?.[1] ?? "").trim();
	if (!base64) {return null;}
	const safeProfile = profile.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
	const filePath = path.join(resolvePreferredOpenClawTmpDir(), `openclaw-zalouser-qr-${safeProfile}.png`);
	await fs$1.writeFile(filePath, Buffer.from(base64, "base64"));
	return filePath;
}
//#endregion
//#region extensions/zalouser/src/setup-surface.ts
const channel = "zalouser";
function setZalouserAccountScopedConfig(cfg, accountId, defaultPatch, accountPatch = defaultPatch) {
	return patchScopedAccountConfig({
		cfg,
		channelKey: channel,
		accountId,
		patch: defaultPatch,
		accountPatch
	});
}
function setZalouserDmPolicy(cfg, dmPolicy) {
	return setTopLevelChannelDmPolicyWithAllowFrom({
		cfg,
		channel,
		dmPolicy
	});
}
function setZalouserGroupPolicy(cfg, accountId, groupPolicy) {
	return setZalouserAccountScopedConfig(cfg, accountId, { groupPolicy });
}
function setZalouserGroupAllowlist(cfg, accountId, groupKeys) {
	return setZalouserAccountScopedConfig(cfg, accountId, { groups: Object.fromEntries(groupKeys.map((key) => [key, { allow: true }])) });
}
async function noteZalouserHelp(prompter) {
	await prompter.note([
		"Zalo Personal Account login via QR code.",
		"",
		"This plugin uses zca-js directly (no external CLI dependency).",
		"",
		`Docs: ${formatDocsLink("/channels/zalouser", "zalouser")}`
	].join("\n"), "Zalo Personal Setup");
}
async function promptZalouserAllowFrom(params) {
	const { cfg, prompter, accountId } = params;
	const resolved = resolveZalouserAccountSync({
		cfg,
		accountId
	});
	const existingAllowFrom = resolved.config.allowFrom ?? [];
	const parseInput = (raw) => raw.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
	while (true) {
		const entry = await prompter.text({
			message: "Zalouser allowFrom (name or user id)",
			placeholder: "Alice, 123456789",
			initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		const parts = parseInput(String(entry));
		const resolvedEntries = await resolveZaloAllowFromEntries({
			profile: resolved.profile,
			entries: parts
		});
		const unresolved = resolvedEntries.filter((item) => !item.resolved).map((item) => item.input);
		if (unresolved.length > 0) {
			await prompter.note(`Could not resolve: ${unresolved.join(", ")}. Use numeric user ids or exact friend names.`, "Zalo Personal allowlist");
			continue;
		}
		const unique = mergeAllowFromEntries(existingAllowFrom, resolvedEntries.filter((item) => item.resolved && item.id).map((item) => item.id));
		const notes = resolvedEntries.filter((item) => item.note).map((item) => `${item.input} -> ${item.id} (${item.note})`);
		if (notes.length > 0) {await prompter.note(notes.join("\n"), "Zalo Personal allowlist");}
		return setZalouserAccountScopedConfig(cfg, accountId, {
			dmPolicy: "allowlist",
			allowFrom: unique
		});
	}
}
const zalouserSetupWizard = {
	channel,
	status: {
		configuredLabel: "logged in",
		unconfiguredLabel: "needs QR login",
		configuredHint: "recommended · logged in",
		unconfiguredHint: "recommended · QR login",
		configuredScore: 1,
		unconfiguredScore: 15,
		resolveConfigured: async ({ cfg }) => {
			const ids = listZalouserAccountIds(cfg);
			for (const accountId of ids) {if (await checkZaloAuthenticated(resolveZalouserAccountSync({
				cfg,
				accountId
			}).profile)) return true;}
			return false;
		},
		resolveStatusLines: async ({ cfg, configured }) => {
			return [`Zalo Personal: ${configured ? "logged in" : "needs QR login"}`];
		}
	},
	prepare: async ({ cfg, accountId, prompter }) => {
		let next = cfg;
		const account = resolveZalouserAccountSync({
			cfg: next,
			accountId
		});
		if (!await checkZaloAuthenticated(account.profile)) {
			await noteZalouserHelp(prompter);
			if (await prompter.confirm({
				message: "Login via QR code now?",
				initialValue: true
			})) {
				const start = await startZaloQrLogin({
					profile: account.profile,
					timeoutMs: 35e3
				});
				if (start.qrDataUrl) {
					const qrPath = await writeQrDataUrlToTempFile(start.qrDataUrl, account.profile);
					await prompter.note([
						start.message,
						qrPath ? `QR image saved to: ${qrPath}` : "Could not write QR image file; use gateway web login UI instead.",
						"Scan + approve on phone, then continue."
					].join("\n"), "QR Login");
					if (await prompter.confirm({
						message: "Did you scan and approve the QR on your phone?",
						initialValue: true
					})) {
						const waited = await waitForZaloQrLogin({
							profile: account.profile,
							timeoutMs: 12e4
						});
						await prompter.note(waited.message, waited.connected ? "Success" : "Login pending");
					}
				} else {await prompter.note(start.message, "Login pending");}
			}
		} else if (!await prompter.confirm({
			message: "Zalo Personal already logged in. Keep session?",
			initialValue: true
		})) {
			await logoutZaloProfile(account.profile);
			const start = await startZaloQrLogin({
				profile: account.profile,
				force: true,
				timeoutMs: 35e3
			});
			if (start.qrDataUrl) {
				const qrPath = await writeQrDataUrlToTempFile(start.qrDataUrl, account.profile);
				await prompter.note([start.message, qrPath ? `QR image saved to: ${qrPath}` : void 0].filter(Boolean).join("\n"), "QR Login");
				const waited = await waitForZaloQrLogin({
					profile: account.profile,
					timeoutMs: 12e4
				});
				await prompter.note(waited.message, waited.connected ? "Success" : "Login pending");
			}
		}
		next = setZalouserAccountScopedConfig(next, accountId, { profile: account.profile !== "default" ? account.profile : void 0 }, {
			profile: account.profile,
			enabled: true
		});
		return { cfg: next };
	},
	credentials: [],
	groupAccess: {
		label: "Zalo groups",
		placeholder: "Family, Work, 123456789",
		currentPolicy: ({ cfg, accountId }) => resolveZalouserAccountSync({
			cfg,
			accountId
		}).config.groupPolicy ?? "allowlist",
		currentEntries: ({ cfg, accountId }) => Object.keys(resolveZalouserAccountSync({
			cfg,
			accountId
		}).config.groups ?? {}),
		updatePrompt: ({ cfg, accountId }) => Boolean(resolveZalouserAccountSync({
			cfg,
			accountId
		}).config.groups),
		setPolicy: ({ cfg, accountId, policy }) => setZalouserGroupPolicy(cfg, accountId, policy),
		resolveAllowlist: async ({ cfg, accountId, entries, prompter }) => {
			if (entries.length === 0) {return [];}
			const updatedAccount = resolveZalouserAccountSync({
				cfg,
				accountId
			});
			try {
				const resolved = await resolveZaloGroupsByEntries({
					profile: updatedAccount.profile,
					entries
				});
				const resolvedIds = resolved.filter((entry) => entry.resolved && entry.id).map((entry) => entry.id);
				const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
				const keys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
				const resolution = formatResolvedUnresolvedNote({
					resolved: resolvedIds,
					unresolved
				});
				if (resolution) {await prompter.note(resolution, "Zalo groups");}
				return keys;
			} catch (err) {
				await prompter.note(`Group lookup failed; keeping entries as typed. ${String(err)}`, "Zalo groups");
				return entries.map((entry) => entry.trim()).filter(Boolean);
			}
		},
		applyAllowlist: ({ cfg, accountId, resolved }) => setZalouserGroupAllowlist(cfg, accountId, resolved)
	},
	finalize: async ({ cfg, accountId, forceAllowFrom, prompter }) => {
		let next = cfg;
		if (forceAllowFrom) {next = await promptZalouserAllowFrom({
			cfg: next,
			prompter,
			accountId
		});}
		return { cfg: next };
	},
	dmPolicy: {
		label: "Zalo Personal",
		channel,
		policyKey: "channels.zalouser.dmPolicy",
		allowFromKey: "channels.zalouser.allowFrom",
		getCurrent: (cfg) => cfg.channels?.zalouser?.dmPolicy ?? "pairing",
		setPolicy: (cfg, policy) => setZalouserDmPolicy(cfg, policy),
		promptAllowFrom: async ({ cfg, prompter, accountId }) => {
			return await promptZalouserAllowFrom({
				cfg,
				prompter,
				accountId: accountId && normalizeAccountId(accountId) ? normalizeAccountId(accountId) ?? "default" : resolveDefaultZalouserAccountId(cfg)
			});
		}
	}
};
//#endregion
export { DEFAULT_ACCOUNT_ID, MarkdownConfigSchema, ToolPolicySchema, addWildcardAllowFrom, applyAccountNameToChannelSection, applySetupAccountConfigPatch, buildBaseAccountStatusSnapshot, buildChannelConfigSchema, buildChannelSendResult, chunkTextForOutbound, createAccountListHelpers, createReplyPrefixOptions, createScopedPairingAccess, createTypingCallbacks, deleteAccountFromConfigSection, emptyPluginConfigSchema, evaluateGroupRouteAccessForPolicy, formatAllowFromLowercase, formatPairingApproveHint, formatResolvedUnresolvedNote, isDangerousNameMatchingEnabled, isNumericTargetId, issuePairingChallenge, loadOutboundMediaFromUrl, mergeAllowFromEntries, mergeAllowlist, migrateBaseNameToDefaultAccount, normalizeAccountId, patchScopedAccountConfig, resolveChannelAccountConfigBasePath, resolveDefaultGroupPolicy, resolveMentionGatingWithBypass, resolveOpenProviderRuntimeGroupPolicy, resolveOutboundMediaUrls, resolvePreferredOpenClawTmpDir, resolveSenderCommandAuthorization, resolveSenderScopedGroupPolicy, sendMediaWithLeadingCaption, sendPayloadWithChunkedTextAndMedia, setAccountEnabledInConfigSection, setTopLevelChannelDmPolicyWithAllowFrom, summarizeMapping, warnMissingProviderGroupPolicyFallbackOnce, zalouserSetupAdapter, zalouserSetupWizard };
