import { i as OpenClawConfig } from "../../types.openclaw-DIZy8jcb.js";
import { S as MarkdownTableMode } from "../../types.base-DCoxbfrn.js";
import { a as GroupToolPolicyConfig } from "../../types.tools-B8rv6fwX.js";
import { D as TelegramGroupConfig, M as TelegramTopicConfig, O as TelegramInlineButtonsScope, S as TelegramDirectConfig, T as TelegramExecApprovalConfig, k as TelegramNetworkConfig, m as ResolvedReactionLevel$1, p as ReactionLevel } from "../../types.channels-qd_8k3sY.js";
import { s as ExecApprovalRequest } from "../../exec-approvals-BpVWMnuu.js";
import { n as ChannelOutboundAdapter } from "../../outbound.types-COmT4EQP.js";
import { F as ChannelStatusIssue, m as ChannelGroupContext, r as ChannelAccountSnapshot } from "../../types.core-1gFCH89g.js";
import { r as ReplyPayload } from "../../reply-payload-DjPL5qa-.js";
import { o as PluginApprovalRequest } from "../../plugin-approvals-BiH4NDIm.js";
import { n as NormalizedLocation } from "../../location-BFiiAtE9.js";
import { o as readChannelAllowFromStore } from "../../pairing-store-CktJmUe0.js";
import { n as TelegramCredentialStatus, r as inspectTelegramAccount, t as InspectedTelegramAccount } from "../../account-inspect-UJ2UIcQ1.js";
import { g as TelegramInlineButtons, h as TelegramButtonStyle, u as sendMessageTelegram } from "../../send-obC9RB9S.js";
import { a as normalizeTelegramCommandName, i as normalizeTelegramCommandDescription, n as TelegramCustomCommandInput, o as resolveTelegramCustomCommands, r as TelegramCustomCommandIssue, t as TELEGRAM_COMMAND_NAME_PATTERN } from "../../command-config-DxymjVNM.js";
import { _ as buildTelegramExecApprovalPendingPayload, a as ParsedTelegramTopicConversation, b as NormalizedAllowFrom, d as CachedSticker, f as cacheSticker, g as searchStickers, h as getCachedSticker, l as DescribeStickerParams, m as getCacheStats, o as parseTelegramTopicConversation, p as getAllCachedStickers, u as describeStickerImage, v as shouldSuppressTelegramExecApprovalForwardingFallback } from "../../runtime-api-Zxj3dKD1.js";
import { i as resetTelegramProbeFetcherCacheForTests, n as TelegramProbeOptions, r as probeTelegram, t as TelegramProbe } from "../../probe-C8eFLBs7.js";
import { t as TelegramTokenResolution } from "../../token-B1nbLimM.js";
import { n as isNumericTelegramUserId, r as normalizeTelegramAllowFromEntry, t as isNumericTelegramSenderUserId } from "../../allow-from-BAXNm7lw.js";
import { a as listEnabledTelegramAccounts, c as resolveDefaultTelegramAccountId, d as resolveTelegramPollActionGateState, f as mergeTelegramAccountConfig, i as createTelegramActionGate, l as resolveTelegramAccount, n as TelegramMediaRuntimeOptions, o as listTelegramAccountIds, p as resolveTelegramAccountConfig, r as TelegramPollActionGateState, s as resetMissingDefaultWarnFlag, t as ResolvedTelegramAccount, u as resolveTelegramMediaRuntimeOptions } from "../../accounts-BXd9oFDv.js";
import { t as telegramPlugin } from "../../channel-D7NC_3WU.js";
import { t as telegramSetupPlugin } from "../../channel.setup-DoACrArR.js";
import { _ as resolveModelSelection, a as ButtonRow, c as ProviderInfo, d as buildModelSelectionCallbackData, f as buildModelsKeyboard, g as parseModelCallbackData, h as getModelsPageSize, i as buildTelegramModelsProviderChannelData, l as ResolveModelSelectionResult, m as calculateTotalPages, n as TelegramInteractiveHandlerRegistration, o as ModelsKeyboardParams, p as buildProviderKeyboard, r as buildCommandsPaginationKeyboard, s as ParsedModelCallback, t as TelegramInteractiveHandlerContext, u as buildBrowseProvidersButton } from "../../interactive-dispatch-BcAjPbeo.js";
import { n as listTelegramDirectoryPeersFromConfig, t as listTelegramDirectoryGroupsFromConfig } from "../../directory-config-A7wtB2j4.js";
import { t as collectTelegramSecurityAuditFindings } from "../../security-audit-nVSuJbd0.js";
import { n as readTelegramUpdateOffset, r as writeTelegramUpdateOffset, t as deleteTelegramUpdateOffset } from "../../update-offset-store-DQE_UErP.js";

//#region node_modules/@grammyjs/types/markup.d.ts
/** This object represents one button of an inline keyboard. Exactly one of the optional fields must be used to specify type of the button. */
interface InlineKeyboardMarkup {
  /** Array of button rows, each represented by an Array of InlineKeyboardButton objects */
  inline_keyboard: InlineKeyboardButton[][];
}
declare namespace InlineKeyboardButton {
  interface AbstractInlineKeyboardButton {
    /** Label text on the button */
    text: string;
    /** Unique identifier of the custom emoji shown before the text of the button. Can only be used by bots that purchased additional usernames on Fragment or in the messages directly sent by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription. */
    icon_custom_emoji_id?: string;
    /** Style of the button. Must be one of “danger” (red), “success” (green) or “primary” (blue). If omitted, then an app-specific style is used. */
    style?: "danger" | "success" | "primary";
  }
  interface UrlButton extends AbstractInlineKeyboardButton {
    /** HTTP or tg:// URL to be opened when the button is pressed. Links tg://user?id=<user_id> can be used to mention a user by their identifier without using a username, if this is allowed by their privacy settings. */
    url: string;
  }
  interface CallbackButton extends AbstractInlineKeyboardButton {
    /** Data to be sent in a callback query to the bot when the button is pressed, 1-64 bytes */
    callback_data: string;
  }
  interface WebAppButton extends AbstractInlineKeyboardButton {
    /** Description of the Web App that will be launched when the user presses the button. The Web App will be able to send an arbitrary message on behalf of the user using the method answerWebAppQuery. Available only in private chats between a user and the bot. Not supported for messages sent on behalf of a Telegram Business account. */
    web_app: WebAppInfo;
  }
  interface LoginButton extends AbstractInlineKeyboardButton {
    /** An HTTPS URL used to automatically authorize the user. Can be used as a replacement for the Telegram Login Widget. */
    login_url: LoginUrl;
  }
  interface SwitchInlineButton extends AbstractInlineKeyboardButton {
    /** If set, pressing the button will prompt the user to select one of their chats, open that chat and insert the bot's username and the specified inline query in the input field. May be empty, in which case just the bot's username will be inserted. Not supported for messages sent in channel direct messages chats and on behalf of a Telegram Business account. */
    switch_inline_query: string;
  }
  interface SwitchInlineCurrentChatButton extends AbstractInlineKeyboardButton {
    /** If set, pressing the button will insert the bot's username and the specified inline query in the current chat's input field. May be empty, in which case only the bot's username will be inserted.
         This offers a quick way for the user to open your bot in inline mode in the same chat - good for selecting something from multiple options. Not supported in channels and for messages sent in channel direct messages chats and on behalf of a Telegram Business account. */
    switch_inline_query_current_chat: string;
  }
  interface SwitchInlineChosenChatButton extends AbstractInlineKeyboardButton {
    /** If set, pressing the button will prompt the user to select one of their chats of the specified type, open that chat and insert the bot's username and the specified inline query in the input field. Not supported for messages sent in channel direct messages chats and on behalf of a Telegram Business account. */
    switch_inline_query_chosen_chat: SwitchInlineQueryChosenChat;
  }
  interface CopyTextButtonButton extends AbstractInlineKeyboardButton {
    /** Description of the button that copies the specified text to the clipboard. */
    copy_text: CopyTextButton;
  }
  interface GameButton extends AbstractInlineKeyboardButton {
    /** Description of the game that will be launched when the user presses the button.
         NOTE: This type of button must always be the first button in the first row. */
    callback_game: CallbackGame;
  }
  interface PayButton extends AbstractInlineKeyboardButton {
    /** Specify True, to send a Pay button. Substrings “⭐” and “XTR” in the buttons's text will be replaced with a Telegram Star icon.
         NOTE: This type of button must always be the first button in the first row and can only be used in invoice messages. */
    pay: boolean;
  }
}
/** This object represents one button of an inline keyboard. Exactly one of the fields other than text, icon_custom_emoji_id, and style must be used to specify the type of the button. */
type InlineKeyboardButton = InlineKeyboardButton.CallbackButton | InlineKeyboardButton.GameButton | InlineKeyboardButton.LoginButton | InlineKeyboardButton.PayButton | InlineKeyboardButton.SwitchInlineButton | InlineKeyboardButton.SwitchInlineCurrentChatButton | InlineKeyboardButton.SwitchInlineChosenChatButton | InlineKeyboardButton.CopyTextButtonButton | InlineKeyboardButton.UrlButton | InlineKeyboardButton.WebAppButton;
/** This object represents a parameter of the inline keyboard button used to automatically authorize a user. Serves as a great replacement for the Telegram Login Widget when the user is coming from Telegram. All the user needs to do is tap/click a button and confirm that they want to log in.
Telegram apps support these buttons as of version 5.7. */
interface LoginUrl {
  /** An HTTPS URL to be opened with user authorization data added to the query string when the button is pressed. If the user refuses to provide authorization data, the original URL without information about the user will be opened. The data added is the same as described in Receiving authorization data.
     NOTE: You must always check the hash of the received data to verify the authentication and the integrity of the data as described in Checking authorization. */
  url: string;
  /** New text of the button in forwarded messages. */
  forward_text?: string;
  /** Username of a bot, which will be used for user authorization. See Setting up a bot for more details. If not specified, the current bot's username will be assumed. The url's domain must be the same as the domain linked with the bot. See Linking your domain to the bot for more details. */
  bot_username?: string;
  /** Pass True to request the permission for your bot to send messages to the user. */
  request_write_access?: boolean;
}
/** This object represents an inline button that switches the current user to inline mode in a chosen chat, with an optional default inline query. */
interface SwitchInlineQueryChosenChat {
  /** The default inline query to be inserted in the input field. If left empty, only the bot's username will be inserted */
  query?: string;
  /** True, if private chats with users can be chosen */
  allow_user_chats?: boolean;
  /** True, if private chats with bots can be chosen */
  allow_bot_chats?: boolean;
  /** True, if group and supergroup chats can be chosen */
  allow_group_chats?: boolean;
  /** True, if channel chats can be chosen */
  allow_channel_chats?: boolean;
}
/** A placeholder, currently holds no information. Use BotFather to set up your game. */
interface CallbackGame {}
/** This object represents an inline keyboard button that copies specified text to the clipboard. */
interface CopyTextButton {
  /** The text to be copied to the clipboard; 1-256 characters */
  text: string;
}
/** Describes a Web App. */
interface WebAppInfo {
  /** An HTTPS URL of a Web App to be opened with additional data as specified in Initializing Web Apps */
  url: string;
}
//#endregion
//#region node_modules/@grammyjs/types/passport.d.ts
/** Describes Telegram Passport data shared with the bot by the user. */
interface PassportData {
  /** Array with information about documents and other Telegram Passport elements that was shared with the bot */
  data: EncryptedPassportElement[];
  /** Encrypted credentials required to decrypt the data */
  credentials: EncryptedCredentials;
}
/** This object represents a file uploaded to Telegram Passport. Currently all Telegram Passport files are in JPEG format when decrypted and don't exceed 10MB. */
interface PassportFile {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** File size in bytes */
  file_size: number;
  /** Unix time when the file was uploaded */
  file_date: number;
}
/** Describes documents or other Telegram Passport elements shared with the bot by the user. */
interface EncryptedPassportElement {
  /** Element type. One of “personal_details”, “passport”, “driver_license”, “identity_card”, “internal_passport”, “address”, “utility_bill”, “bank_statement”, “rental_agreement”, “passport_registration”, “temporary_registration”, “phone_number”, “email”. */
  type: "personal_details" | "passport" | "driver_license" | "identity_card" | "internal_passport" | "address" | "utility_bill" | "bank_statement" | "rental_agreement" | "passport_registration" | "temporary_registration" | "phone_number" | "email";
  /** Base64-encoded encrypted Telegram Passport element data provided by the user; available only for “personal_details”, “passport”, “driver_license”, “identity_card”, “internal_passport” and “address” types. Can be decrypted and verified using the accompanying EncryptedCredentials. */
  data?: string;
  /** User's verified phone number; available only for “phone_number” type */
  phone_number?: string;
  /** User's verified email address; available only for “email” type */
  email?: string;
  /** Array of encrypted files with documents provided by the user; available only for “utility_bill”, “bank_statement”, “rental_agreement”, “passport_registration” and “temporary_registration” types. Files can be decrypted and verified using the accompanying EncryptedCredentials. */
  files?: PassportFile[];
  /** Encrypted file with the front side of the document, provided by the user; available only for “passport”, “driver_license”, “identity_card” and “internal_passport”. The file can be decrypted and verified using the accompanying EncryptedCredentials. */
  front_side?: PassportFile;
  /** Encrypted file with the reverse side of the document, provided by the user; available only for “driver_license” and “identity_card”. The file can be decrypted and verified using the accompanying EncryptedCredentials. */
  reverse_side?: PassportFile;
  /** Encrypted file with the selfie of the user holding a document, provided by the user; available if requested for “passport”, “driver_license”, “identity_card” and “internal_passport”. The file can be decrypted and verified using the accompanying EncryptedCredentials. */
  selfie?: PassportFile;
  /** Array of encrypted files with translated versions of documents provided by the user; available if requested for “passport”, “driver_license”, “identity_card”, “internal_passport”, “utility_bill”, “bank_statement”, “rental_agreement”, “passport_registration” and “temporary_registration” types. Files can be decrypted and verified using the accompanying EncryptedCredentials. */
  translation?: PassportFile[];
  /** Base64-encoded element hash for using in PassportElementErrorUnspecified */
  hash: string;
}
/** Describes data required for decrypting and authenticating EncryptedPassportElement. See the Telegram Passport Documentation for a complete description of the data decryption and authentication processes. */
interface EncryptedCredentials {
  /** Base64-encoded encrypted JSON-serialized data with unique user's payload, data hashes and secrets required for EncryptedPassportElement decryption and authentication */
  data: string;
  /** Base64-encoded data hash for data authentication */
  hash: string;
  /** Base64-encoded secret, encrypted with the bot's public RSA key, required for data decryption */
  secret: string;
}
//#endregion
//#region node_modules/@grammyjs/types/payment.d.ts
/** This object contains basic information about an invoice. */
interface Invoice {
  /** Product name */
  title: string;
  /** Product description */
  description: string;
  /** Unique bot deep-linking parameter that can be used to generate this invoice */
  start_parameter: string;
  /** Three-letter ISO 4217 currency code, or “XTR” for payments in Telegram Stars */
  currency: string;
  /** Total price in the smallest units of the currency (integer, not float/double). For example, for a price of US$ 1.45 pass amount = 145. See the exp parameter in currencies.json, it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). */
  total_amount: number;
}
/** This object represents a shipping address. */
interface ShippingAddress {
  /** Two-letter ISO 3166-1 alpha-2 country code */
  country_code: string;
  /** State, if applicable */
  state: string;
  /** City */
  city: string;
  /** First line for the address */
  street_line1: string;
  /** Second line for the address */
  street_line2: string;
  /** Address post code */
  post_code: string;
}
/** This object represents information about an order. */
interface OrderInfo {
  /** User name */
  name?: string;
  /** User's phone number */
  phone_number?: string;
  /** User email */
  email?: string;
  /** User shipping address */
  shipping_address?: ShippingAddress;
}
/** This object contains basic information about a successful payment. Note that if the buyer initiates a chargeback with the relevant payment provider following this transaction, the funds may be debited from your balance. This is outside of Telegram's control. */
interface SuccessfulPayment {
  /** Three-letter ISO 4217 currency code, or “XTR” for payments in Telegram Stars */
  currency: string;
  /** Total price in the smallest units of the currency (integer, not float/double). For example, for a price of US$ 1.45 pass amount = 145. See the exp parameter in currencies.json, it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). */
  total_amount: number;
  /** Bot specified invoice payload */
  invoice_payload: string;
  /** Expiration date of the subscription, in Unix time; for recurring payments only */
  subscription_expiration_date?: number;
  /** True, if the payment is a recurring payment for a subscription */
  is_recurring?: true;
  /** True, if the payment is the first payment for a subscription */
  is_first_recurring?: true;
  /** Identifier of the shipping option chosen by the user */
  shipping_option_id?: string;
  /** Order information provided by the user */
  order_info?: OrderInfo;
  /** Telegram payment identifier */
  telegram_payment_charge_id: string;
  /** Provider payment identifier */
  provider_payment_charge_id: string;
}
/** This object contains basic information about a refunded payment. */
interface RefundedPayment {
  /** Three-letter ISO 4217 currency code, or “XTR” for payments in Telegram Stars. Currently, always “XTR” */
  currency: string;
  /** Total refunded price in the smallest units of the currency (integer, not float/double). For example, for a price of US$ 1.45, total_amount = 145. See the exp parameter in currencies.json, it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). */
  total_amount: number;
  /** Bot-specified invoice payload */
  invoice_payload: string;
  /** Telegram payment identifier */
  telegram_payment_charge_id: string;
  /** Provider payment identifier */
  provider_payment_charge_id?: string;
}
/** This object describes the background of a gift. */
interface GiftBackground {
  /** Center color of the background in RGB format */
  center_color: number;
  /** Edge color of the background in RGB format */
  edge_color: number;
  /** Text color of the background in RGB format */
  text_color: number;
}
/** This object represents a gift that can be sent by the bot. */
interface Gift {
  /** Unique identifier of the gift */
  id: string;
  /** Information about the chat that published the gift */
  publisher_chat?: Chat;
  /** The sticker that represents the gift */
  sticker: Sticker;
  /** Background of the gift */
  background?: GiftBackground;
  /** True, if the gift can only be purchased by Telegram Premium subscribers */
  is_premium?: true;
  /** True, if the gift can be used (after being upgraded) to customize a user's appearance */
  has_colors?: true;
  /** The number of Telegram Stars that must be paid to send the sticker */
  star_count: number;
  /** The number of Telegram Stars that must be paid to upgrade the gift to a unique one */
  upgrade_star_count?: number;
  /** The total number of different unique gifts that can be obtained by upgrading the gift */
  unique_gift_variant_count?: number;
  /** The total number of gifts of this type that can be sent by all users; for limited gifts only */
  total_count?: number;
  /** The number of remaining gifts of this type that can be sent by all users; for limited gifts only */
  remaining_count?: number;
  /** The total number of gifts of this type that can be sent by the bot; for limited gifts only */
  personal_total_count?: number;
  /** The number of remaining gifts of this type that can be sent by the bot; for limited gifts only */
  personal_remaining_count?: number;
}
/** This object describes the model of a unique gift. */
interface UniqueGiftModel {
  /** Name of the model */
  name: string;
  /** The sticker that represents the unique gift */
  sticker: Sticker;
  /** The number of unique gifts that receive this model for every 1000 gift upgrades. Always 0 for crafted gifts. */
  rarity_per_mille: number;
  /** Rarity of the model if it is a crafted model. Currently, can be “uncommon”, “rare”, “epic”, or “legendary”. */
  rarity?: "uncommon" | "rare" | "epic" | "legendary";
}
/** This object describes the symbol shown on the pattern of a unique gift. */
interface UniqueGiftSymbol {
  /** Name of the symbol */
  name: string;
  /** The sticker that represents the unique gift */
  sticker: Sticker;
  /** The number of unique gifts that receive this model for every 1000 gifts upgraded */
  rarity_per_mille: number;
}
/** This object describes the colors of the backdrop of a unique gift. */
interface UniqueGiftBackdropColors {
  /** The color in the center of the backdrop in RGB format */
  center_color: number;
  /** The color on the edges of the backdrop in RGB format */
  edge_color: number;
  /** The color to be applied to the symbol in RGB format */
  symbol_color: number;
  /** The color for the text on the backdrop in RGB format */
  text_color: number;
}
/** This object describes the backdrop of a unique gift. */
interface UniqueGiftBackdrop {
  /** Name of the backdrop */
  name: string;
  /** Colors of the backdrop */
  colors: UniqueGiftBackdropColors;
  /** The number of unique gifts that receive this backdrop for every 1000 gifts upgraded */
  rarity_per_mille: number;
}
/** This object describes a unique gift that was upgraded from a regular gift. */
interface UniqueGift {
  /** Identifier of the regular gift from which the gift was upgraded */
  gift_id: string;
  /** Human-readable name of the regular gift from which this unique gift was upgraded */
  base_name: string;
  /** Unique name of the gift. This name can be used in https://t.me/nft/... links and story areas */
  name: string;
  /** Information about the chat that published the gift */
  publisher_chat?: Chat;
  /** True, if the original regular gift was exclusively purchaseable by Telegram Premium subscribers */
  is_premium?: true;
  /** True, if the gift is assigned from the TON blockchain and can't be resold or transferred in Telegram */
  is_from_blockchain?: true;
  /** Unique number of the upgraded gift among gifts upgraded from the same regular gift */
  number: number;
  /** Model of the gift */
  model: UniqueGiftModel;
  /** Symbol of the gift */
  symbol: UniqueGiftSymbol;
  /** Backdrop of the gift */
  backdrop: UniqueGiftBackdrop;
  /** The color scheme that can be used by the gift's owner for the chat's name, replies to messages and link previews */
  colors?: UniqueGiftColors;
  /** True, if the gift was used to craft another gift and isn't available anymore */
  is_burned?: true;
}
/** This object contains information about the color scheme for a user's name, message replies and link previews based on a unique gift. */
interface UniqueGiftColors {
  /** Custom emoji identifier of the unique gift's model */
  model_custom_emoji_id: string;
  /** Custom emoji identifier of the unique gift's symbol */
  symbol_custom_emoji_id: string;
  /** Main color used in light themes; RGB format */
  light_theme_main_color: number;
  /** List of 1-3 additional colors used in light themes; RGB format */
  light_theme_other_colors: number[];
  /** Main color used in dark themes; RGB format */
  dark_theme_main_color: number;
  /** List of 1-3 additional colors used in dark themes; RGB format */
  dark_theme_other_colors: number[];
}
/** Describes a service message about a regular gift that was sent or received. */
interface GiftInfo {
  /** Information about the gift */
  gift: Gift;
  /** Unique identifier of the received gift for the bot; only present for gifts received on behalf of business accounts */
  owned_gift_id?: string;
  /** Number of Telegram Stars that can be claimed by the receiver by converting the gift; omitted if conversion to Telegram Stars is impossible */
  convert_star_count?: number;
  /** Number of Telegram Stars that were prepaid by the sender for the ability to upgrade the gift */
  prepaid_upgrade_star_count?: number;
  /** True, if the gift can be upgraded to a unique gift */
  can_be_upgraded?: true;
  /** True, if the gift's upgrade was purchased after the gift was sent */
  is_upgrade_separate?: true;
  /** Unique number reserved for this gift when upgraded. See the number field in UniqueGift */
  unique_gift_number?: number;
  /** Text of the message that was added to the gift */
  text?: string;
  /** Special entities that appear in the text */
  entities?: MessageEntity[];
  /** True, if the sender and gift text are shown only to the gift receiver; otherwise, everyone will be able to see them */
  is_private?: true;
}
/** Describes a service message about a unique gift that was sent or received. */
interface UniqueGiftInfo {
  /** Information about the gift */
  gift: UniqueGift;
  /** Origin of the gift. Currently, either “upgrade” for gifts upgraded from regular gifts, “transfer” for gifts transferred from other users or channels, “resale” for gifts bought from other users, “gifted_upgrade” for upgrades purchased after the gift was sent, or “offer” for gifts bought or sold through gift purchase offers */
  origin: "upgrade" | "transfer" | "resale" | "gifted_upgrade" | "offer";
  /** Unique identifier of the received gift for the bot; only present for gifts received on behalf of business accounts */
  owned_gift_id?: string;
  /** Number of Telegram Stars that must be paid to transfer the gift; omitted if the bot cannot transfer the gift */
  transfer_star_count?: number;
  /** For gifts bought from other users, the currency in which the payment for the gift was done. Currently, one of “XTR” for Telegram Stars or “TON” for toncoins. */
  last_resale_currency?: "XTR" | "TON";
  /** For gifts bought from other users, the price paid for the gift in either Telegram Stars or nanotoncoins */
  last_resale_amount?: number;
  /** Point in time (Unix timestamp) when the gift can be transferred. If it is in the past, then the gift can be transferred now */
  next_transfer_date?: number;
}
/** Describes a service message about a change in the price of paid messages within a chat. */
interface PaidMessagePriceChanged {
  /** The new number of Telegram Stars that must be paid by non-administrator users of the supergroup chat for each sent message */
  paid_message_star_count: number;
}
/** Describes an amount of Telegram Stars. */
interface StarAmount {
  /** Integer amount of Telegram Stars, rounded to 0; can be negative */
  amount: number;
  /** The number of 1/1000000000 shares of Telegram Stars; from -999999999 to 999999999; can be negative if and only if amount is non-positive */
  nanostar_amount?: number;
}
/** Describes the price of a suggested post. */
interface SuggestedPostPrice {
  /** Currency in which the post will be paid. Currently, must be one of “XTR” for Telegram Stars or “TON” for toncoins */
  currency: "XTR" | "TON";
  /** The amount of the currency that will be paid for the post in the smallest units of the currency, i.e. Telegram Stars or nanotoncoins. Currently, price in Telegram Stars must be between 5 and 100000, and price in nanotoncoins must be between 10000000 and 10000000000000. */
  amount: number;
}
/** Contains information about a suggested post. */
interface SuggestedPostInfo {
  /** State of the suggested post. Currently, it can be one of “pending”, “approved”, “declined”. */
  state: "pending" | "approved" | "declined";
  /** Proposed price of the post. If the field is omitted, then the post is unpaid. */
  price?: SuggestedPostPrice;
  /** Proposed send date of the post. If the field is omitted, then the post can be published at any time within 30 days at the sole discretion of the user or administrator who approves it. */
  send_date?: number;
}
/** Describes a service message about the approval of a suggested post. */
interface SuggestedPostApproved {
  /** Message containing the suggested post. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  suggested_post_message?: Message;
  /** Amount paid for the post */
  price?: SuggestedPostPrice;
  /** Date when the post will be published */
  send_date: number;
}
/** Describes a service message about the failed approval of a suggested post. Currently, only caused by insufficient user funds at the time of approval. */
interface SuggestedPostApprovalFailed {
  /** Message containing the suggested post whose approval has failed. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  suggested_post_message?: Message;
  /** Expected price of the post */
  price: SuggestedPostPrice;
}
/** Describes a service message about the rejection of a suggested post. */
interface SuggestedPostDeclined {
  /** Message containing the suggested post. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  suggested_post_message?: Message;
  /** Comment with which the post was declined */
  comment?: string;
}
/** Describes a service message about a successful payment for a suggested post. */
interface SuggestedPostPaid {
  /** Message containing the suggested post. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  suggested_post_message?: Message;
  /** Currency in which the payment was made. Currently, one of “XTR” for Telegram Stars or “TON” for toncoins */
  currency: string;
  /** The amount of the currency that was received by the channel in nanotoncoins; for payments in toncoins only */
  amount?: number;
  /** The amount of Telegram Stars that was received by the channel; for payments in Telegram Stars only */
  star_amount?: StarAmount;
}
/** Describes a service message about a payment refund for a suggested post. */
interface SuggestedPostRefunded {
  /** Message containing the suggested post. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  suggested_post_message?: Message;
  /** Reason for the refund. Currently, one of “post_deleted” if the post was deleted within 24 hours of being posted or removed from scheduled messages without being posted, or “payment_refunded” if the payer refunded their payment. */
  reason: string;
}
//#endregion
//#region node_modules/@grammyjs/types/message.d.ts
type MsgWith<P extends keyof Message> = Record<P, NonNullable<Message[P]>>;
declare namespace Message {
  interface ServiceMessage {
    /** Unique message identifier inside this chat. In specific instances (e.g., message containing a video sent to a big chat), the server might automatically schedule a message instead of sending it immediately. In such cases, this field will be 0 and the relevant message will be unusable until it is actually sent */
    message_id: number;
    /** Unique identifier of a message thread or forum topic to which the message belongs; for supergroups and private chats only */
    message_thread_id?: number;
    /** Sender of the message; may be empty for messages sent to channels. For backward compatibility, if the message was sent on behalf of a chat, the field contains a fake sender user in non-channel chats */
    from?: User;
    /** Sender of the message when sent on behalf of a chat. For example, the supergroup itself for messages sent by its anonymous administrators or a linked channel for messages automatically forwarded to the channel's discussion group. For backward compatibility, if the message was sent on behalf of a chat, the field from contains a fake sender user in non-channel chats. */
    sender_chat?: Chat;
    /** Date the message was sent in Unix time. It is always a positive number, representing a valid date. */
    date: number;
    /** Unique identifier of the business connection from which the message was received. If non-empty, the message belongs to a chat of the corresponding business account that is independent from any potential bot chat which might share the same identifier. */
    business_connection_id?: string;
    /** Chat the message belongs to */
    chat: Chat;
    /** True, if the message is sent to a topic in a forum supergroup or a private chat with the bot */
    is_topic_message?: boolean;
    /** Information about the direct messages chat topic that contains the message */
    direct_messages_topic?: DirectMessagesTopic;
  }
  interface CommonMessage extends ServiceMessage {
    /** Tag or custom title of the sender of the message; for supergroups only */
    sender_tag?: string;
    /** If the sender of the message boosted the chat, the number of boosts added by the user */
    sender_boost_count?: number;
    /** The bot that actually sent the message on behalf of the business account. Available only for outgoing messages sent on behalf of the connected business account. */
    sender_business_bot?: User;
    /** Information about the original message for forwarded messages */
    forward_origin?: MessageOrigin;
    /** True, if the message is a channel post that was automatically forwarded to the connected discussion group */
    is_automatic_forward?: true;
    /** For replies in the same chat and message thread, the original message. Note that the Message object in this field will not contain further reply_to_message fields even if it itself is a reply. */
    reply_to_message?: ReplyMessage;
    /** Identifier of the specific checklist task that is being replied to */
    reply_to_checklist_task_id?: number;
    /** Persistent identifier of the specific poll option that is being replied to */
    reply_to_poll_option_id?: string;
    /** True, if the message is a paid post. Note that such posts must not be deleted for 24 hours to receive the payment and can't be edited. */
    is_paid_post?: true;
    /** Information about the message that is being replied to, which may come from another chat or forum topic */
    external_reply?: ExternalReplyInfo;
    /** For replies that quote part of the original message, the quoted part of the message */
    quote?: TextQuote;
    /** For replies to a story, the original message */
    reply_to_story?: Story;
    /** Bot through which the message was sent */
    via_bot?: User;
    /** Date the message was last edited in Unix time */
    edit_date?: number;
    /** True, if the message can't be forwarded */
    has_protected_content?: true;
    /** True, if the caption must be shown above the message media */
    show_caption_above_media?: true;
    /** True, if the message was sent by an implicit action, for example, as an away or a greeting business message, or as a scheduled message */
    is_from_offline?: true;
    /** Signature of the post author for messages in channels, or the custom title of an anonymous group administrator */
    author_signature?: string;
    /** Options used for link preview generation for the message, if it is a text message and link preview options were changed */
    link_preview_options?: LinkPreviewOptions;
    /** Unique identifier of the message effect added to the message */
    effect_id?: string;
    /** The number of Telegram Stars that were paid by the sender of the message to send it */
    paid_star_count?: number;
    /** Inline keyboard attached to the message. login_url buttons are represented as ordinary url buttons. */
    reply_markup?: InlineKeyboardMarkup;
  }
  interface CaptionableMessage extends CommonMessage {
    /** Caption for the animation, audio, document, photo, video or voice */
    caption?: string;
    /** For messages with a caption, special entities like usernames, URLs, bot commands, etc. that appear in the caption */
    caption_entities?: MessageEntity[];
  }
  interface MediaMessage extends CaptionableMessage {
    /** The unique identifier inside this chat of a media message group this message belongs to */
    media_group_id?: string;
    /** True, if the message media is covered by a spoiler animation */
    has_media_spoiler?: true;
  }
  type TextMessage = CommonMessage & MsgWith<"text"> & Partial<MsgWith<"entities">>;
  type AudioMessage = CaptionableMessage & MsgWith<"audio">;
  type DocumentMessage = CaptionableMessage & MsgWith<"document">;
  type AnimationMessage = DocumentMessage & MsgWith<"animation">;
  type PhotoMessage = MediaMessage & MsgWith<"photo">;
  type StickerMessage = CommonMessage & MsgWith<"sticker">;
  type StoryMessage = CommonMessage & MsgWith<"story">;
  type VideoMessage = MediaMessage & MsgWith<"video">;
  type VideoNoteMessage = CommonMessage & MsgWith<"video_note">;
  type VoiceMessage = CaptionableMessage & MsgWith<"voice">;
  type ContactMessage = CommonMessage & MsgWith<"contact">;
  type DiceMessage = CommonMessage & MsgWith<"dice">;
  type GameMessage = CommonMessage & MsgWith<"game">;
  type PollMessage = CommonMessage & MsgWith<"poll">;
  type VenueMessage = LocationMessage & MsgWith<"venue">;
  type LocationMessage = CommonMessage & MsgWith<"location">;
  type PaidMediaMessage = CommonMessage & MsgWith<"paid_media">;
  type DirectMessagePriceChangedMessage = ServiceMessage & MsgWith<"direct_message_price_changed">;
  type ChecklistMessage = CommonMessage & MsgWith<"checklist">;
  type ChecklistTasksDoneMessage = ServiceMessage & MsgWith<"checklist_tasks_done">;
  type ChecklistTasksAddedMessage = ServiceMessage & MsgWith<"checklist_tasks_added">;
  type SuggestedPostInfoMessage = ServiceMessage & MsgWith<"suggested_post_info">;
  type SuggestedPostApprovedMessage = ServiceMessage & MsgWith<"suggested_post_approved">;
  type SuggestedPostApprovalFailedMessage = ServiceMessage & MsgWith<"suggested_post_approval_failed">;
  type SuggestedPostDeclinedMessage = ServiceMessage & MsgWith<"suggested_post_declined">;
  type SuggestedPostPaidMessage = ServiceMessage & MsgWith<"suggested_post_paid">;
  type SuggestedPostRefundedMessage = ServiceMessage & MsgWith<"suggested_post_refunded">;
  type ChatOwnerLeftMessage = ServiceMessage & MsgWith<"chat_owner_left">;
  type ChatOwnerChangedMessage = ServiceMessage & MsgWith<"chat_owner_changed">;
  type NewChatMembersMessage = ServiceMessage & MsgWith<"new_chat_members">;
  type LeftChatMemberMessage = ServiceMessage & MsgWith<"left_chat_member">;
  type NewChatTitleMessage = ServiceMessage & MsgWith<"new_chat_title">;
  type NewChatPhotoMessage = ServiceMessage & MsgWith<"new_chat_photo">;
  type DeleteChatPhotoMessage = ServiceMessage & MsgWith<"delete_chat_photo">;
  type GroupChatCreatedMessage = ServiceMessage & MsgWith<"group_chat_created">;
  type SupergroupChatCreated = ServiceMessage & MsgWith<"supergroup_chat_created">;
  type ChannelChatCreatedMessage = ServiceMessage & MsgWith<"channel_chat_created">;
  type ManagedBotCreatedMessage = ServiceMessage & MsgWith<"managed_bot_created">;
  type PollOptionAddedMessage = ServiceMessage & MsgWith<"poll_option_added">;
  type PollOptionDeletedMessage = ServiceMessage & MsgWith<"poll_option_deleted">;
  type MessageAutoDeleteTimerChangedMessage = ServiceMessage & MsgWith<"message_auto_delete_timer_changed">;
  type MigrateToChatIdMessage = ServiceMessage & MsgWith<"migrate_to_chat_id">;
  type MigrateFromChatIdMessage = ServiceMessage & MsgWith<"migrate_from_chat_id">;
  type PinnedMessageMessage = ServiceMessage & MsgWith<"pinned_message">;
  type InvoiceMessage = ServiceMessage & MsgWith<"invoice">;
  type SuccessfulPaymentMessage = ServiceMessage & MsgWith<"successful_payment">;
  type RefundedPaymentMessage = ServiceMessage & MsgWith<"refunded_payment">;
  type UsersSharedMessage = ServiceMessage & MsgWith<"users_shared">;
  type ChatSharedMessage = ServiceMessage & MsgWith<"chat_shared">;
  type ConnectedWebsiteMessage = ServiceMessage & MsgWith<"connected_website">;
  type WriteAccessAllowedMessage = ServiceMessage & MsgWith<"write_access_allowed">;
  type PassportDataMessage = ServiceMessage & MsgWith<"passport_data">;
  type ProximityAlertTriggeredMessage = ServiceMessage & MsgWith<"proximity_alert_triggered">;
  type BoostAddedMessage = ServiceMessage & MsgWith<"boost_added">;
  type ChatBackgroundSetMessage = ServiceMessage & MsgWith<"chat_background_set">;
  type ForumTopicCreatedMessage = ServiceMessage & MsgWith<"forum_topic_created">;
  type ForumTopicEditedMessage = ServiceMessage & MsgWith<"forum_topic_edited">;
  type ForumTopicClosedMessage = ServiceMessage & MsgWith<"forum_topic_closed">;
  type ForumTopicReopenedMessage = ServiceMessage & MsgWith<"forum_topic_reopened">;
  type GeneralForumTopicHiddenMessage = ServiceMessage & MsgWith<"general_forum_topic_hidden">;
  type GeneralForumTopicUnhiddenMessage = ServiceMessage & MsgWith<"general_forum_topic_unhidden">;
  type GiveawayCreatedMessage = ServiceMessage & MsgWith<"giveaway_created">;
  type GiveawayMessage = ServiceMessage & MsgWith<"giveaway">;
  type GiveawayWinnersMessage = ServiceMessage & MsgWith<"giveaway_winners">;
  type GiveawayCompletedMessage = ServiceMessage & MsgWith<"giveaway_completed">;
  type GiftMessage = ServiceMessage & MsgWith<"gift">;
  type UniqueGiftMessage = ServiceMessage & MsgWith<"unique_gift">;
  type GiftUpgradeSentMessage = ServiceMessage & MsgWith<"gift_upgrade_sent">;
  type PaidMessagePriceChangedMessage = ServiceMessage & MsgWith<"paid_message_price_changed">;
  type VideoChatScheduledMessage = ServiceMessage & MsgWith<"video_chat_scheduled">;
  type VideoChatStartedMessage = ServiceMessage & MsgWith<"video_chat_started">;
  type VideoChatEndedMessage = ServiceMessage & MsgWith<"video_chat_ended">;
  type VideoChatParticipantsInvitedMessage = ServiceMessage & MsgWith<"video_chat_participants_invited">;
  type WebAppDataMessage = ServiceMessage & MsgWith<"web_app_data">;
}
type ReplyMessage = Message & {
  reply_to_message: undefined;
};
/** This object represents a message. */
interface Message extends Message.MediaMessage {
  /** For text messages, the actual UTF-8 text of the message */
  text?: string;
  /** For text messages, special entities like usernames, URLs, bot commands, etc. that appear in the text */
  entities?: MessageEntity[];
  /** Message is an animation, information about the animation. For backward compatibility, when this field is set, the document field will also be set */
  animation?: Animation;
  /** Message is an audio file, information about the file */
  audio?: Audio;
  /** Message is a general file, information about the file */
  document?: Document;
  /** Message is a photo, available sizes of the photo */
  photo?: PhotoSize[];
  /** Message is a sticker, information about the sticker */
  sticker?: Sticker;
  /** Message is a forwarded story */
  story?: Story;
  /** Message is a video, information about the video */
  video?: Video;
  /** Message is a video note, information about the video message */
  video_note?: VideoNote;
  /** Message is a voice message, information about the file */
  voice?: Voice;
  /** Message is a shared contact, information about the contact */
  contact?: Contact;
  /** Message is a dice with random value */
  dice?: Dice;
  /** Message is a game, information about the game. More about games » */
  game?: Game;
  /** Message is a native poll, information about the poll */
  poll?: Poll;
  /** Message is a venue, information about the venue. For backward compatibility, when this field is set, the location field will also be set */
  venue?: Venue;
  /** Message is a shared location, information about the location */
  location?: Location;
  /** Message contains paid media; information about the paid media */
  paid_media?: PaidMediaInfo;
  /** Message is a checklist */
  checklist?: Checklist;
  /** Service message: some tasks in a checklist were marked as done or not done */
  checklist_tasks_done?: ChecklistTasksDone;
  /** Service message: tasks were added to a checklist */
  checklist_tasks_added?: ChecklistTasksAdded;
  /** Information about suggested post parameters if the message is a suggested post in a channel direct messages chat. If the message is an approved or declined suggested post, then it can't be edited. */
  suggested_post_info?: SuggestedPostInfo;
  /** Service message: a suggested post was approved */
  suggested_post_approved?: SuggestedPostApproved;
  /** Service message: approval of a suggested post has failed */
  suggested_post_approval_failed?: SuggestedPostApprovalFailed;
  /** Service message: a suggested post was declined */
  suggested_post_declined?: SuggestedPostDeclined;
  /** Service message: payment for a suggested post was received */
  suggested_post_paid?: SuggestedPostPaid;
  /** Service message: payment for a suggested post was refunded */
  suggested_post_refunded?: SuggestedPostRefunded;
  /** Service message: chat owner has left */
  chat_owner_left?: ChatOwnerLeft;
  /** Service message: chat owner has changed */
  chat_owner_changed?: ChatOwnerChanged;
  /** New members that were added to the group or supergroup and information about them (the bot itself may be one of these members) */
  new_chat_members?: User[];
  /** A member was removed from the group, information about them (this member may be the bot itself) */
  left_chat_member?: User;
  /** A chat title was changed to this value */
  new_chat_title?: string;
  /** A chat photo was change to this value */
  new_chat_photo?: PhotoSize[];
  /** Service message: the chat photo was deleted */
  delete_chat_photo?: true;
  /** Service message: the group has been created */
  group_chat_created?: true;
  /** Service message: the supergroup has been created. This field can't be received in a message coming through updates, because bot can't be a member of a supergroup when it is created. It can only be found in reply_to_message if someone replies to a very first message in a directly created supergroup. */
  supergroup_chat_created?: true;
  /** Service message: the channel has been created. This field can't be received in a message coming through updates, because bot can't be a member of a channel when it is created. It can only be found in reply_to_message if someone replies to a very first message in a channel. */
  channel_chat_created?: true;
  /** Service message: user created a bot that will be managed by the current bot */
  managed_bot_created?: ManagedBotCreated;
  /** Service message: answer option was added to a poll */
  poll_option_added?: PollOptionAdded;
  /** Service message: answer option was deleted from a poll */
  poll_option_deleted?: PollOptionDeleted;
  /** Service message: auto-delete timer settings changed in the chat */
  message_auto_delete_timer_changed?: MessageAutoDeleteTimerChanged;
  /** The group has been migrated to a supergroup with the specified identifier. */
  migrate_to_chat_id?: number;
  /** The supergroup has been migrated from a group with the specified identifier. */
  migrate_from_chat_id?: number;
  /** Specified message was pinned. Note that the Message object in this field will not contain further reply_to_message fields even if it itself is a reply. */
  pinned_message?: MaybeInaccessibleMessage;
  /** Message is an invoice for a payment, information about the invoice. More about payments » */
  invoice?: Invoice;
  /** Message is a service message about a successful payment, information about the payment. More about payments » */
  successful_payment?: SuccessfulPayment;
  /** Message is a service message about a refunded payment, information about the payment. More about payments » */
  refunded_payment?: RefundedPayment;
  /** Service message: users were shared with the bot */
  users_shared?: UsersShared;
  /** Service message: a chat was shared with the bot */
  chat_shared?: ChatShared;
  /** The domain name of the website on which the user has logged in. More about Telegram Login » */
  connected_website?: string;
  /** Service message: the user allowed the bot to write messages after adding it to the attachment or side menu, launching a Web App from a link, or accepting an explicit request from a Web App sent by the method requestWriteAccess */
  write_access_allowed?: WriteAccessAllowed;
  /** Telegram Passport data */
  passport_data?: PassportData;
  /** Service message. A user in the chat triggered another user's proximity alert while sharing Live Location. */
  proximity_alert_triggered?: ProximityAlertTriggered;
  /** Service message: user boosted the chat */
  boost_added?: ChatBoostAdded;
  chat_background_set?: ChatBackground;
  /** Service message: forum topic created */
  forum_topic_created?: ForumTopicCreated;
  /** Service message: forum topic edited */
  forum_topic_edited?: ForumTopicEdited;
  /** Service message: forum topic closed */
  forum_topic_closed?: ForumTopicClosed;
  /** Service message: forum topic reopened */
  forum_topic_reopened?: ForumTopicReopened;
  /** Service message: the 'General' forum topic hidden */
  general_forum_topic_hidden?: GeneralForumTopicHidden;
  /** Service message: the 'General' forum topic unhidden */
  general_forum_topic_unhidden?: GeneralForumTopicUnhidden;
  /** Service message: a scheduled giveaway was created */
  giveaway_created?: GiveawayCreated;
  /** The message is a scheduled giveaway message */
  giveaway?: Giveaway;
  /** A giveaway with public winners was completed */
  giveaway_winners?: GiveawayWinners;
  /** Service message: a giveaway without public winners was completed */
  giveaway_completed?: GiveawayCompleted;
  /** Service message: a regular gift was sent or received */
  gift?: GiftInfo;
  /** Service message: upgrade of a gift was purchased after the gift was sent */
  gift_upgrade_sent?: GiftInfo;
  /** Service message: a unique gift was sent or received */
  unique_gift?: UniqueGiftInfo;
  /** Service message: the price for paid messages has changed in the chat */
  paid_message_price_changed?: PaidMessagePriceChanged;
  /** Service message: the price for paid messages in the corresponding direct messages chat of a channel has changed */
  direct_message_price_changed?: DirectMessagePriceChanged;
  /** Service message: video chat scheduled */
  video_chat_scheduled?: VideoChatScheduled;
  /** Service message: video chat started */
  video_chat_started?: VideoChatStarted;
  /** Service message: video chat ended */
  video_chat_ended?: VideoChatEnded;
  /** Service message: new participants invited to a video chat */
  video_chat_participants_invited?: VideoChatParticipantsInvited;
  /** Service message: data sent by a Web App */
  web_app_data?: WebAppData;
}
/** This object describes a message that was deleted or is otherwise inaccessible to the bot. */
interface InaccessibleMessage extends Omit<Message, "chat" | "message_id" | "date"> {
  /** Chat the message belonged to */
  chat: Chat;
  /** Unique message identifier inside the chat */
  message_id: number;
  /** Always 0. The field can be used to differentiate regular and inaccessible messages. */
  date: 0;
}
/** This object describes a message that can be inaccessible to the bot. It can be one of

- Message
- InaccessibleMessage */
type MaybeInaccessibleMessage = Message | InaccessibleMessage;
declare namespace MessageEntity {
  interface AbstractMessageEntity {
    /** Type of the entity. Currently, can be “mention” (@username), “hashtag” (#hashtag or #hashtag@chatusername), “cashtag” ($USD or $USD@chatusername), “bot_command” (/start@jobs_bot), “url” (https://telegram.org), “email” (do-not-reply@telegram.org), “phone_number” (+1-212-555-0123), “bold” (bold text), “italic” (italic text), “underline” (underlined text), “strikethrough” (strikethrough text), “spoiler” (spoiler message), “blockquote” (block quotation), “expandable_blockquote” (collapsed-by-default block quotation), “code” (monowidth string), “pre” (monowidth block), “text_link” (for clickable text URLs), “text_mention” (for users without usernames), “custom_emoji” (for inline custom emoji stickers), or “date_time” (for formatted date and time) */
    type: string;
    /** Offset in UTF-16 code units to the start of the entity */
    offset: number;
    /** Length of the entity in UTF-16 code units */
    length: number;
  }
  interface CommonMessageEntity extends AbstractMessageEntity {
    type: "mention" | "hashtag" | "cashtag" | "bot_command" | "url" | "email" | "phone_number" | "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "blockquote" | "expandable_blockquote" | "code";
  }
  interface PreMessageEntity extends AbstractMessageEntity {
    type: "pre";
    /** For “pre” only, the programming language of the entity text */
    language?: string;
  }
  interface TextLinkMessageEntity extends AbstractMessageEntity {
    type: "text_link";
    /** For “text_link” only, URL that will be opened after user taps on the text */
    url: string;
  }
  interface TextMentionMessageEntity extends AbstractMessageEntity {
    type: "text_mention";
    /** For “text_mention” only, the mentioned user */
    user: User;
  }
  interface CustomEmojiMessageEntity extends AbstractMessageEntity {
    type: "custom_emoji";
    /** For “custom_emoji” only, unique identifier of the custom emoji. Use getCustomEmojiStickers to get full information about the sticker */
    custom_emoji_id: string;
  }
  interface DateTimeMessageEntity extends AbstractMessageEntity {
    type: "date_time";
    /** For “date_time” only, the Unix time associated with the entity */
    unix_time: number;
    /** For “date_time” only, the string that defines the formatting of the date and time. See date-time entity formatting for more details. */
    date_time_format: "r" | `${"w" | ""}${"d" | "D" | ""}${"t" | "T" | ""}`;
  }
}
/** This object represents one special entity in a text message. For example, hashtags, usernames, URLs, etc. */
type MessageEntity = MessageEntity.CommonMessageEntity | MessageEntity.CustomEmojiMessageEntity | MessageEntity.PreMessageEntity | MessageEntity.TextLinkMessageEntity | MessageEntity.TextMentionMessageEntity | MessageEntity.DateTimeMessageEntity;
/** This object contains information about the quoted part of a message that is replied to by the given message. */
interface TextQuote {
  /** Text of the quoted part of a message that is replied to by the given message */
  text: string;
  /** Special entities that appear in the quote. Currently, only bold, italic, underline, strikethrough, spoiler, custom_emoji, and date_time entities are kept in quotes. */
  entities?: MessageEntity[];
  /** Approximate quote position in the original message in UTF-16 code units as specified by the sender */
  position: number;
  /** True, if the quote was chosen manually by the message sender. Otherwise, the quote was added automatically by the server. */
  is_manual?: true;
}
/** This object contains information about a message that is being replied to, which may come from another chat or forum topic. */
interface ExternalReplyInfo {
  /** Origin of the message replied to by the given message */
  origin: MessageOrigin;
  /** Chat the original message belongs to. Available only if the chat is a supergroup or a channel. */
  chat?: Chat;
  /** Unique message identifier inside the original chat. Available only if the original chat is a supergroup or a channel. */
  message_id?: number;
  /** Options used for link preview generation for the original message, if it is a text message */
  link_preview_options?: LinkPreviewOptions;
  /** Message is an animation, information about the animation */
  animation?: Animation;
  /** Message is an audio file, information about the file */
  audio?: Audio;
  /** Message is a general file, information about the file */
  document?: Document;
  /** Message is a photo, available sizes of the photo */
  photo?: PhotoSize[];
  /** Message is a sticker, information about the sticker */
  sticker?: Sticker;
  /** Message is a forwarded story */
  story?: Story;
  /** Message is a video, information about the video */
  video?: Video;
  /** Message is a video note, information about the video message */
  video_note?: VideoNote;
  /** Message is a voice message, information about the file */
  voice?: Voice;
  /** True, if the message media is covered by a spoiler animation */
  has_media_spoiler?: true;
  /** Message is a shared contact, information about the contact */
  contact?: Contact;
  /** Message is a dice with random value */
  dice?: Dice;
  /** Message is a game, information about the game. More about games » */
  game?: Game;
  /** Message is a scheduled giveaway, information about the giveaway */
  giveaway?: Giveaway;
  /** A giveaway with public winners was completed */
  giveaway_winners?: GiveawayWinners;
  /** Message is an invoice for a payment, information about the invoice. More about payments » */
  invoice?: Invoice;
  /** Message is a shared location, information about the location */
  location?: Location;
  /** Message contains paid media; information about the paid media */
  paid_media?: PaidMediaInfo;
  /** Message is a native poll, information about the poll */
  poll?: Poll;
  /** Message is a checklist */
  checklist?: Checklist;
  /** Message is a venue, information about the venue */
  venue?: Venue;
}
/** This object describes the origin of a message. It can be one of

- MessageOriginUser
- MessageOriginHiddenUser
- MessageOriginChat
- MessageOriginChannel */
type MessageOrigin = MessageOriginUser | MessageOriginHiddenUser | MessageOriginChat | MessageOriginChannel;
/** The message was originally sent by a known user. */
interface MessageOriginUser {
  /** Type of the message origin, always “user” */
  type: "user";
  /** Date the message was sent originally in Unix time */
  date: number;
  /** User that sent the message originally */
  sender_user: User;
}
/** The message was originally sent by an unknown user. */
interface MessageOriginHiddenUser {
  /** Type of the message origin, always “hidden_user” */
  type: "hidden_user";
  /** Date the message was sent originally in Unix time */
  date: number;
  /** Name of the user that sent the message originally */
  sender_user_name: string;
}
/** The message was originally sent on behalf of a chat to a group chat. */
interface MessageOriginChat {
  /** Type of the message origin, always “chat” */
  type: "chat";
  /** Date the message was sent originally in Unix time */
  date: number;
  /** Chat that sent the message originally */
  sender_chat: Chat;
  /** For messages originally sent by an anonymous chat administrator, original message author signature */
  author_signature?: string;
}
/** The message was originally sent to a channel chat. */
interface MessageOriginChannel {
  /** Type of the message origin, always “channel” */
  type: "channel";
  /** Date the message was sent originally in Unix time */
  date: number;
  /** Channel chat to which the message was originally sent */
  chat: Chat.ChannelChat;
  /** Unique message identifier inside the chat */
  message_id: number;
  /** Signature of the original post author */
  author_signature?: string;
}
/** This object represents one size of a photo or a file / sticker thumbnail. */
interface PhotoSize {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Photo width */
  width: number;
  /** Photo height */
  height: number;
  /** File size in bytes */
  file_size?: number;
}
/** This object represents an animation file (GIF or H.264/MPEG-4 AVC video without sound). */
interface Animation {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Video width as defined by sender */
  width: number;
  /** Video height as defined by sender */
  height: number;
  /** Duration of the video in seconds as defined by sender */
  duration: number;
  /** Animation thumbnail as defined by sender */
  thumbnail?: PhotoSize;
  /** Original animation filename as defined by sender */
  file_name?: string;
  /** MIME type of the file as defined by sender */
  mime_type?: string;
  /** File size in bytes */
  file_size?: number;
}
/** This object represents an audio file to be treated as music by the Telegram clients. */
interface Audio {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Duration of the audio in seconds as defined by sender */
  duration: number;
  /** Performer of the audio as defined by sender or by audio tags */
  performer?: string;
  /** Title of the audio as defined by sender or by audio tags */
  title?: string;
  /** Original filename as defined by sender */
  file_name?: string;
  /** MIME type of the file as defined by sender */
  mime_type?: string;
  /** File size in bytes */
  file_size?: number;
  /** Thumbnail of the album cover to which the music file belongs */
  thumbnail?: PhotoSize;
}
/** This object represents a general file (as opposed to photos, voice messages and audio files). */
interface Document {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Document thumbnail as defined by sender */
  thumbnail?: PhotoSize;
  /** Original filename as defined by sender */
  file_name?: string;
  /** MIME type of the file as defined by sender */
  mime_type?: string;
  /** File size in bytes */
  file_size?: number;
}
/** This object represents a story. */
interface Story {
  /** Chat that posted the story */
  chat: Chat;
  /** Unique identifier for the story in the chat */
  id: number;
}
/** This object represents a video file. */
interface Video {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Video width as defined by sender */
  width: number;
  /** Video height as defined by sender */
  height: number;
  /** Duration of the video in seconds as defined by sender */
  duration: number;
  /** Video thumbnail */
  thumbnail?: PhotoSize;
  /** Available sizes of the cover of the video in the message */
  cover?: PhotoSize[];
  /** Timestamp in seconds from which the video will play in the message */
  start_timestamp?: number;
  /** Original filename as defined by sender */
  file_name?: string;
  /** MIME type of the file as defined by sender */
  mime_type?: string;
  /** File size in bytes */
  file_size?: number;
  /** List of available qualities of the video. */
  qualities?: VideoQuality[];
}
/** This object represents a video file of a specific quality. */
interface VideoQuality {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Video width */
  width: number;
  /** Video height */
  height: number;
  /** Codec that was used to encode the video, for example, “h264”, “h265”, or “av01” */
  codec: string;
  /** File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. */
  file_size?: number;
}
/** This object represents a video message (available in Telegram apps as of v.4.0). */
interface VideoNote {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Video width and height (diameter of the video message) as defined by sender */
  length: number;
  /** Duration of the video in seconds as defined by sender */
  duration: number;
  /** Video thumbnail */
  thumbnail?: PhotoSize;
  /** File size in bytes */
  file_size?: number;
}
/** This object represents a voice note. */
interface Voice {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Duration of the audio in seconds as defined by sender */
  duration: number;
  /** MIME type of the file as defined by sender */
  mime_type?: string;
  /** File size in bytes */
  file_size?: number;
}
/** This object represents a phone contact. */
interface Contact {
  /** Contact's phone number */
  phone_number: string;
  /** Contact's first name */
  first_name: string;
  /** Contact's last name */
  last_name?: string;
  /** Contact's user identifier in Telegram. */
  user_id?: number;
  /** Additional data about the contact in the form of a vCard */
  vcard?: string;
}
/** This object represents an animated emoji that displays a random value. */
interface Dice {
  /** Emoji on which the dice throw animation is based */
  emoji: string;
  /** Value of the dice, 1-6 for "🎲", "🎯" and "🎳" base emoji, 1-5 for "🏀" and "⚽" base emoji, 1-64 for "🎰" base emoji */
  value: number;
}
/** This object contains information about one answer option in a poll. */
interface PollOption {
  /** Unique identifier of the option, persistent on option addition and deletion */
  persistent_id: string;
  /** Option text, 1-100 characters */
  text: string;
  /** Special entities that appear in the option text. Currently, only custom emoji entities are allowed in poll option texts */
  text_entities?: MessageEntity[];
  /** Number of users who voted for this option; may be 0 if unknown */
  voter_count: number;
  /** User who added the option; omitted if the option wasn't added by a user after poll creation */
  added_by_user?: User;
  /** Chat that added the option; omitted if the option wasn't added by a chat after poll creation */
  added_by_chat?: Chat;
  /** Point in time (Unix timestamp) when the option was added; omitted if the option existed in the original poll */
  addition_date?: number;
}
/** Describes a service message about an option added to a poll. */
interface PollOptionAdded {
  /** Message containing the poll to which the option was added. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  poll_message?: MaybeInaccessibleMessage;
  /** Unique identifier of the added option */
  option_persistent_id: string;
  /** Option text */
  option_text: string;
  /** Special entities that appear in the option_text */
  option_text_entities?: MessageEntity[];
}
/** Describes a service message about an option deleted from a poll. */
interface PollOptionDeleted {
  /** Message containing the poll from which the option was deleted. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  poll_message?: MaybeInaccessibleMessage;
  /** Unique identifier of the deleted option */
  option_persistent_id: string;
  /** Option text */
  option_text: string;
  /** Special entities that appear in the option_text */
  option_text_entities?: MessageEntity[];
}
/** This object contains information about a poll. */
interface Poll {
  /** Unique poll identifier */
  id: string;
  /** Poll question, 1-300 characters */
  question: string;
  /** Special entities that appear in the question. Currently, only custom emoji entities are allowed in poll questions */
  question_entities?: MessageEntity[];
  /** List of poll options */
  options: PollOption[];
  /** Total number of users that voted in the poll */
  total_voter_count: number;
  /** True, if the poll is closed */
  is_closed: boolean;
  /** True, if the poll is anonymous */
  is_anonymous: boolean;
  /** Poll type, currently can be “regular” or “quiz” */
  type: "regular" | "quiz";
  /** True, if the poll allows multiple answers */
  allows_multiple_answers: boolean;
  /** Array of 0-based identifiers of the correct answer options. Available only for polls in quiz mode which are closed or were sent (not forwarded) by the bot or to the private chat with the bot. */
  correct_option_ids?: number[];
  /** True, if the poll allows to change the chosen answer options */
  allows_revoting: boolean;
  /** Description of the poll; for polls inside the Message object only */
  description?: string;
  /** Special entities like usernames, URLs, bot commands, etc. that appear in the description */
  description_entities?: MessageEntity[];
  /** Text that is shown when a user chooses an incorrect answer or taps on the lamp icon in a quiz-style poll, 0-200 characters */
  explanation?: string;
  /** Special entities like usernames, URLs, bot commands, etc. that appear in the explanation */
  explanation_entities?: MessageEntity[];
  /** Amount of time in seconds the poll will be active after creation */
  open_period?: number;
  /** Point in time (Unix timestamp) when the poll will be automatically closed */
  close_date?: number;
}
/** This object represents a point on the map. */
interface Location {
  /** Latitude as defined by sender */
  latitude: number;
  /** Longitude as defined by sender */
  longitude: number;
  /** The radius of uncertainty for the location, measured in meters; 0-1500 */
  horizontal_accuracy?: number;
  /** Time relative to the message sending date, during which the location can be updated; in seconds. For active live locations only. */
  live_period?: number;
  /** The direction in which user is moving, in degrees; 1-360. For active live locations only. */
  heading?: number;
  /** The maximum distance for proximity alerts about approaching another chat member, in meters. For sent live locations only. */
  proximity_alert_radius?: number;
}
/** Describes the paid media added to a message. */
interface PaidMediaInfo {
  /** The number of Telegram Stars that must be paid to buy access to the media */
  star_count: number;
  /** Information about the paid media */
  paid_media: PaidMedia[];
}
/** This object describes paid media. Currently, it can be one of

- PaidMediaPreview
- PaidMediaPhoto
- PaidMediaVideo */
type PaidMedia = PaidMediaPreview | PaidMediaPhoto | PaidMediaVideo;
/** The paid media isn't available before the payment. */
interface PaidMediaPreview {
  /** Type of the paid media, always “preview” */
  type: "preview";
  /** Media width as defined by the sender */
  width?: number;
  /** Media height as defined by the sender */
  height?: number;
  /** Duration of the media in seconds as defined by the sender */
  duration?: number;
}
/** The paid media is a photo. */
interface PaidMediaPhoto {
  /** Type of the paid media, always “photo” */
  type: "photo";
  /** The photo */
  photo: PhotoSize[];
}
/** The paid media is a video. */
interface PaidMediaVideo {
  /** Type of the paid media, always “video” */
  type: "video";
  /** The video */
  video: Video;
}
/** This object represents a venue. */
interface Venue {
  /** Venue location. Can't be a live location */
  location: Location;
  /** Name of the venue */
  title: string;
  /** Address of the venue */
  address: string;
  /** Foursquare identifier of the venue */
  foursquare_id?: string;
  /** Foursquare type of the venue. (For example, “arts_entertainment/default”, “arts_entertainment/aquarium” or “food/icecream”.) */
  foursquare_type?: string;
  /** Google Places identifier of the venue */
  google_place_id?: string;
  /** Google Places type of the venue. (See supported types.) */
  google_place_type?: string;
}
/** Describes data sent from a Web App to the bot. */
interface WebAppData {
  /** The data. Be aware that a bad client can send arbitrary data in this field. */
  data: string;
  /** Text of the web_app keyboard button from which the Web App was opened. Be aware that a bad client can send arbitrary data in this field. */
  button_text: string;
}
/** This object represents the content of a service message, sent whenever a user in the chat triggers a proximity alert set by another user. */
interface ProximityAlertTriggered {
  /** User that triggered the alert */
  traveler: User;
  /** User that set the alert */
  watcher: User;
  /** The distance between the users */
  distance: number;
}
/** This object represents a service message about a change in auto-delete timer settings. */
interface MessageAutoDeleteTimerChanged {
  /** New auto-delete time for messages in the chat; in seconds */
  message_auto_delete_time: number;
}
/** This object represents a service message about a user boosting a chat. */
interface ChatBoostAdded {
  /** Number of boosts added by the user */
  boost_count: number;
}
/** This object describes the way a background is filled based on the selected colors. Currently, it can be one of

- BackgroundFillSolid
- BackgroundFillGradient
- BackgroundFillFreeformGradient */
type BackgroundFill = BackgroundFillSolid | BackgroundFillGradient | BackgroundFillFreeformGradient;
/** The background is filled using the selected color. */
interface BackgroundFillSolid {
  /** Type of the background fill, always “solid” */
  type: "solid";
  /** The color of the background fill in the RGB24 format */
  color: number;
}
/** The background is a gradient fill. */
interface BackgroundFillGradient {
  /** Type of the background fill, always “gradient” */
  type: "gradient";
  /** Top color of the gradient in the RGB24 format */
  top_color: number;
  /** Bottom color of the gradient in the RGB24 format */
  bottom_color: number;
  /** Clockwise rotation angle of the background fill in degrees; 0-359 */
  rotation_angle: number;
}
/** The background is a freeform gradient that rotates  after every message in the chat. */
interface BackgroundFillFreeformGradient {
  /** Type of the background fill, always “freeform_gradient” */
  type: "freeform_gradient";
  /** A list of the 3 or 4 base colors that are used to generate the freeform gradient in the RGB24 format */
  colors: number[];
}
/** This object describes the type of a background. Currently, it can be one of

- BackgroundTypeFill
- BackgroundTypeWallpaper
- BackgroundTypePattern
- BackgroundTypeChatTheme
- BackgroundTypeFill */
type BackgroundType = BackgroundTypeFill | BackgroundTypeWallpaper | BackgroundTypePattern | BackgroundTypeChatTheme;
/** The background is automatically filled based on the selected colors. */
interface BackgroundTypeFill {
  /** Type of the background, always “fill” */
  type: "fill";
  /** The background fill */
  fill: BackgroundFill;
  /** Dimming of the background in dark themes, as a percentage; 0-100 */
  dark_theme_dimming: number;
}
/** The background is a wallpaper in the JPEG format. */
interface BackgroundTypeWallpaper {
  /** Type of the background, always “wallpaper” */
  type: "wallpaper";
  /** Document with the wallpaper */
  document: Document;
  /** Dimming of the background in dark themes, as a percentage; 0-100 */
  dark_theme_dimming: number;
  /** True, if the wallpaper is downscaled to fit in a 450x450 square and then box-blurred with radius 12 */
  is_blurred?: true;
  /** True, if the background moves slightly when the device is tilted */
  is_moving?: true;
}
/** The background is a .PNG or .TGV (gzipped subset of SVG with MIME type “application/x-tgwallpattern”) pattern to be combined with the background fill chosen by the user. */
interface BackgroundTypePattern {
  /** Type of the background, always “pattern” */
  type: "pattern";
  /** Document with the pattern */
  document: Document;
  /** The background fill that is combined with the pattern */
  fill: BackgroundFill;
  /** Intensity of the pattern when it is shown above the filled background; 0-100 */
  intensity: number;
  /** True, if the background fill must be applied only to the pattern itself. All other pixels are black in this case. For dark themes only */
  is_inverted?: true;
  /** True, if the background moves slightly when the device is tilted */
  is_moving?: true;
}
/** The background is taken directly from a built-in chat  theme. */
interface BackgroundTypeChatTheme {
  /** Type of the background, always “chat_theme” */
  type: "chat_theme";
  /** Name of the chat theme, which is usually an emoji */
  theme_name: string;
}
/** This object represents a chat background. */
interface ChatBackground {
  /** Type of the background*/
  type: BackgroundType;
}
/** This object represents a service message about a new forum topic created in the chat. */
interface ForumTopicCreated {
  /** Name of the topic */
  name: string;
  /** True, if the name of the topic wasn't specified explicitly by its creator and likely needs to be changed by the bot */
  is_name_implicit?: true;
  /** Color of the topic icon in RGB format */
  icon_color: number;
  /** Unique identifier of the custom emoji shown as the topic icon */
  icon_custom_emoji_id?: string;
}
/** This object represents a service message about an edited forum topic. */
interface ForumTopicEdited {
  /** New name of the topic, if it was edited */
  name?: string;
  /** New identifier of the custom emoji shown as the topic icon, if it was edited; an empty string if the icon was removed */
  icon_custom_emoji_id?: string;
}
/** This object represents a service message about a forum topic closed in the chat. Currently holds no information. */
interface ForumTopicClosed {}
/** This object represents a service message about a forum topic reopened in the chat. Currently holds no information. */
interface ForumTopicReopened {}
/** This object represents a service message about General forum topic hidden in the chat. Currently holds no information. */
interface GeneralForumTopicHidden {}
/** This object represents a service message about General forum topic unhidden in the chat. Currently holds no information. */
interface GeneralForumTopicUnhidden {}
/** This object contains information about a user that was shared with the bot using a KeyboardButtonRequestUsers button. */
interface SharedUser {
  /** Identifier of the shared user. The bot may not have access to the user and could be unable to use this identifier, unless the user is already known to the bot by some other means. */
  user_id: number;
  /** First name of the user, if the name was requested by the bot */
  first_name?: string;
  /** Last name of the user, if the name was requested by the bot */
  last_name?: string;
  /** Username of the user, if the username was requested by the bot */
  username?: string;
  /** Available sizes of the chat photo, if the photo was requested by the bot */
  photo?: PhotoSize[];
}
/** This object contains information about the user whose identifier was shared with the bot using a KeyboardButtonRequestUsers button. */
interface UsersShared {
  /** Identifier of the request */
  request_id: number;
  /** Information about users shared with the bot. */
  users: SharedUser[];
}
/** This object contains information about a chat that was shared with the bot using a KeyboardButtonRequestChat button. */
interface ChatShared {
  /** Identifier of the request */
  request_id: number;
  /** Identifier of the shared chat. The bot may not have access to the chat and could be unable to use this identifier, unless the chat is already known to the bot by some other means. */
  chat_id: number;
  /** Title of the chat, if the title was requested by the bot. */
  title?: string;
  /** Username of the chat, if the username was requested by the bot and available. */
  username?: string;
  /** Available sizes of the chat photo, if the photo was requested by the bot */
  photo?: PhotoSize[];
}
/** This object represents a service message about a user allowing a bot to write messages after adding it to the attachment menu, launching a Web App from a link, or accepting an explicit request from a Web App sent by the method requestWriteAccess. */
interface WriteAccessAllowed {
  /** True, if the access was granted after the user accepted an explicit request from a Web App sent by the method requestWriteAccess */
  from_request?: boolean;
  /** Name of the Web App, if the access was granted when the Web App was launched from a link */
  web_app_name?: string;
  /** True, if the access was granted when the bot was added to the attachment or side menu */
  from_attachment_menu?: boolean;
}
/** Describes a service message about a change in the price of direct messages sent to a channel chat. */
interface DirectMessagePriceChanged {
  /** True, if direct messages are enabled for the channel chat; false otherwise */
  are_direct_messages_enabled: boolean;
  /** The new number of Telegram Stars that must be paid by users for each direct message sent to the channel. Defaults to 0. */
  direct_message_star_count?: number;
}
/** This object represents a service message about a video chat scheduled in the chat. */
interface VideoChatScheduled {
  /** Point in time (Unix timestamp) when the video chat is supposed to be started by a chat administrator */
  start_date: number;
}
/** This object represents a service message about a video chat started in the chat. Currently holds no information. */
interface VideoChatStarted {}
/** This object represents a service message about a video chat ended in the chat. */
interface VideoChatEnded {
  /** Video chat duration in seconds */
  duration: number;
}
/** This object represents a service message about new members invited to a video chat. */
interface VideoChatParticipantsInvited {
  /** New members that were invited to the video chat */
  users: User[];
}
/** This object represents a service message about the creation of a scheduled giveaway. */
interface GiveawayCreated {
  /** The number of Telegram Stars to be split between giveaway winners; for Telegram Star giveaways only */
  prize_star_count?: number;
}
/** This object represents a message about a scheduled giveaway. */
interface Giveaway {
  /** The list of chats which the user must join to participate in the giveaway */
  chats: Chat[];
  /** Point in time (Unix timestamp) when winners of the giveaway will be selected */
  winners_selection_date: number;
  /** The number of users which are supposed to be selected as winners of the giveaway */
  winner_count: number;
  /** True, if only users who join the chats after the giveaway started should be eligible to win */
  only_new_members?: true;
  /** True, if the list of giveaway winners will be visible to everyone */
  has_public_winners?: true;
  /** Description of additional giveaway prize */
  prize_description?: string;
  /** A list of two-letter ISO 3166-1 alpha-2 country codes indicating the countries from which eligible users for the giveaway must come. If empty, then all users can participate in the giveaway. Users with a phone number that was bought on Fragment can always participate in giveaways. */
  country_codes?: string[];
  /** The number of Telegram Stars to be split between giveaway winners; for Telegram Star giveaways only */
  prize_star_count?: number;
  /** The number of months the Telegram Premium subscription won from the giveaway will be active for; for Telegram Premium giveaways only */
  premium_subscription_month_count?: number;
}
/** This object represents a message about the completion of a giveaway with public winners. */
interface GiveawayWinners {
  /** The chat that created the giveaway */
  chat: Chat;
  /** Identifier of the message with the giveaway in the chat */
  giveaway_message_id: number;
  /** Point in time (Unix timestamp) when winners of the giveaway were selected */
  winners_selection_date: number;
  /** Total number of winners in the giveaway */
  winner_count: number;
  /** List of up to 100 winners of the giveaway */
  winners: User[];
  /** The number of other chats the user had to join in order to be eligible for the giveaway */
  additional_chat_count?: number;
  /** The number of Telegram Stars that were split between giveaway winners; for Telegram Star giveaways only */
  prize_star_count?: number;
  /** The number of months the Telegram Premium subscription won from the giveaway will be active for; for Telegram Premium giveaways only */
  premium_subscription_month_count?: number;
  /** Number of undistributed prizes */
  unclaimed_prize_count?: number;
  /** True, if only users who had joined the chats after the giveaway started were eligible to win */
  only_new_members?: true;
  /** True, if the giveaway was canceled because the payment for it was refunded */
  was_refunded?: true;
  /** Description of additional giveaway prize */
  prize_description?: string;
}
/** This object represents a service message about the completion of a giveaway without public winners. */
interface GiveawayCompleted {
  /** Number of winners in the giveaway */
  winner_count: number;
  /** Number of undistributed prizes */
  unclaimed_prize_count?: number;
  /** Message with the giveaway that was completed, if it wasn't deleted */
  giveaway_message?: Message;
  /** True, if the giveaway is a Telegram Star giveaway. Otherwise, currently, the giveaway is a Telegram Premium giveaway. */
  is_star_giveaway?: true;
}
/** Describes the options used for link preview generation. */
interface LinkPreviewOptions {
  /** True, if the link preview is disabled */
  is_disabled?: boolean;
  /** URL to use for the link preview. If empty, then the first URL found in the message text will be used */
  url?: string;
  /** True, if the media in the link preview is supposed to be shrunk; ignored if the URL isn't explicitly specified or media size change isn't supported for the preview */
  prefer_small_media?: boolean;
  /** True, if the media in the link preview is supposed to be enlarged; ignored if the URL isn't explicitly specified or media size change isn't supported for the preview */
  prefer_large_media?: boolean;
  /** True, if the link preview must be shown above the message text; otherwise, the link preview will be shown below the message text */
  show_above_text?: boolean;
}
/** This object represents a sticker. */
interface Sticker {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** Type of the sticker, currently one of “regular”, “mask”, “custom_emoji”. The type of the sticker is independent from its format, which is determined by the fields is_animated and is_video. */
  type: "regular" | "mask" | "custom_emoji";
  /** Sticker width */
  width: number;
  /** Sticker height */
  height: number;
  /** True, if the sticker is animated */
  is_animated: boolean;
  /** True, if the sticker is a video sticker */
  is_video: boolean;
  /** Sticker thumbnail in the .WEBP or .JPG format */
  thumbnail?: PhotoSize;
  /** Emoji associated with the sticker */
  emoji?: string;
  /** Name of the sticker set to which the sticker belongs */
  set_name?: string;
  /** For premium regular stickers, premium animation for the sticker */
  premium_animation?: File;
  /** For mask stickers, the position where the mask should be placed */
  mask_position?: MaskPosition;
  /** For custom emoji stickers, unique identifier of the custom emoji */
  custom_emoji_id?: string;
  /** File size in bytes */
  file_size?: number;
}
/** This object describes the position on faces where a mask should be placed by default. */
interface MaskPosition {
  /** The part of the face relative to which the mask should be placed. One of “forehead”, “eyes”, “mouth”, or “chin”. */
  point: "forehead" | "eyes" | "mouth" | "chin";
  /** Shift by X-axis measured in widths of the mask scaled to the face size, from left to right. For example, choosing -1.0 will place mask just to the left of the default mask position. */
  x_shift: number;
  /** Shift by Y-axis measured in heights of the mask scaled to the face size, from top to bottom. For example, 1.0 will place the mask just below the default mask position. */
  y_shift: number;
  /** Mask scaling coefficient. For example, 2.0 means double size. */
  scale: number;
}
/** This object represents a game. Use BotFather to create and edit games, their short names will act as unique identifiers. */
interface Game {
  /** Title of the game */
  title: string;
  /** Description of the game */
  description: string;
  /** Photo that will be displayed in the game message in chats. */
  photo: PhotoSize[];
  /** Brief description of the game or high scores included in the game message. Can be automatically edited to include current high scores for the game when the bot calls setGameScore, or manually edited using editMessageText. 0-4096 characters. */
  text: string;
  /** Special entities that appear in text, such as usernames, URLs, bot commands, etc. */
  text_entities: MessageEntity[];
  /** Animation that will be displayed in the game message in chats. Upload via BotFather */
  animation: Animation;
}
/** This object represents a file ready to be downloaded. The file can be downloaded via the link https://api.telegram.org/file/bot<token>/<file_path>. It is guaranteed that the link will be valid for at least 1 hour. When the link expires, a new one can be requested by calling getFile. */
interface File {
  /** Identifier for this file, which can be used to download or reuse the file */
  file_id: string;
  /** Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  file_unique_id: string;
  /** File size in bytes */
  file_size?: number;
  /** File path. Use https://api.telegram.org/file/bot<token>/<file_path> to get the file. */
  file_path?: string;
}
/** This object describes the type of a reaction. Currently, it can be one of

- ReactionTypeEmoji
- ReactionTypeCustomEmoji
- ReactionTypePaid */
type ReactionType = ReactionTypeEmoji | ReactionTypeCustomEmoji | ReactionTypePaid;
/** The reaction is based on an emoji. */
interface ReactionTypeEmoji {
  /** Type of the reaction, always “emoji” */
  type: "emoji";
  /** Reaction emoji. Currently, it can be one of "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡" */
  emoji: "👍" | "👎" | "❤" | "🔥" | "🥰" | "👏" | "😁" | "🤔" | "🤯" | "😱" | "🤬" | "😢" | "🎉" | "🤩" | "🤮" | "💩" | "🙏" | "👌" | "🕊" | "🤡" | "🥱" | "🥴" | "😍" | "🐳" | "❤‍🔥" | "🌚" | "🌭" | "💯" | "🤣" | "⚡" | "🍌" | "🏆" | "💔" | "🤨" | "😐" | "🍓" | "🍾" | "💋" | "🖕" | "😈" | "😴" | "😭" | "🤓" | "👻" | "👨‍💻" | "👀" | "🎃" | "🙈" | "😇" | "😨" | "🤝" | "✍" | "🤗" | "🫡" | "🎅" | "🎄" | "☃" | "💅" | "🤪" | "🗿" | "🆒" | "💘" | "🙉" | "🦄" | "😘" | "💊" | "🙊" | "😎" | "👾" | "🤷‍♂" | "🤷" | "🤷‍♀" | "😡";
}
/** The reaction is based on a custom emoji. */
interface ReactionTypeCustomEmoji {
  /** Type of the reaction, always “custom_emoji” */
  type: "custom_emoji";
  /** Custom emoji identifier */
  custom_emoji_id: string;
}
/** The reaction is paid. */
interface ReactionTypePaid {
  /** Type of the reaction, always “paid” */
  type: "paid";
}
/** Describes a topic of a direct messages chat. */
interface DirectMessagesTopic {
  /** Unique identifier of the topic */
  topic_id: number;
  /** Information about the user that created the topic. Currently, it is always present */
  user: User;
}
//#endregion
//#region node_modules/@grammyjs/types/manage.d.ts
/** This object describes the types of gifts that can be gifted to a user or a chat. */
interface AcceptedGiftTypes {
  /** True, if unlimited regular gifts are accepted */
  unlimited_gifts: boolean;
  /** True, if limited regular gifts are accepted */
  limited_gifts: boolean;
  /** True, if unique gifts or gifts that can be upgraded to unique for free are accepted */
  unique_gifts: boolean;
  /** True, if a Telegram Premium subscription is accepted */
  premium_subscription: boolean;
  /** True, if transfers of unique gifts from channels are accepted */
  gifts_from_channels: boolean;
}
/** This object represents a Telegram user or bot. */
interface User {
  /** Unique identifier for this user or bot. */
  id: number;
  /** True, if this user is a bot */
  is_bot: boolean;
  /** User's or bot's first name */
  first_name: string;
  /** User's or bot's last name */
  last_name?: string;
  /** User's or bot's username */
  username?: string;
  /** IETF language tag of the user's language */
  language_code?: string;
  /** True, if this user is a Telegram Premium user */
  is_premium?: true;
  /** True, if this user added the bot to the attachment menu */
  added_to_attachment_menu?: true;
}
/** This object contains information about the bot that was created to be managed by the current bot. */
interface ManagedBotCreated {
  /** Information about the bot. The bot's token can be fetched using the method getManagedBotToken. */
  bot: User;
}
/** Describes a service message about the chat owner leaving the chat. */
interface ChatOwnerLeft {
  /** The user which will be the new owner of the chat if the previous owner does not return to the chat */
  new_owner?: User;
}
/** Describes a service message about an ownership change in the chat. */
interface ChatOwnerChanged {
  /** The new owner of the chat */
  new_owner: User;
}
/** This object describes the rating of a user based on their Telegram Star spendings. */
interface UserRating {
  /** Current level of the user, indicating their reliability when purchasing digital goods and services. A higher level suggests a more trustworthy customer; a negative level is likely reason for concern. */
  level: number;
  /** Numerical value of the user's rating; the higher the rating, the better */
  rating: number;
  /** The rating value required to get the current level */
  current_level_rating: number;
  /** The rating value required to get to the next level; omitted if the maximum level was reached */
  next_level_rating?: number;
}
declare namespace Chat {
  /** Internal type for private chats */
  interface PrivateChat {
    /** Unique identifier for this chat. */
    id: number;
    /** Type of the chat, can be either “private”, “group”, “supergroup” or “channel” */
    type: "private";
    /** Title, for supergroups, channels and group chats */
    title?: undefined;
    /** Username, for private chats, supergroups and channels if available */
    username?: string;
    /** First name of the other party in a private chat */
    first_name: string;
    /** Last name of the other party in a private chat */
    last_name?: string;
    /** True, if the supergroup chat is a forum (has topics enabled) */
    is_forum?: undefined;
    /** True, if the chat is the direct messages chat of a channel */
    is_direct_messages?: undefined;
  }
  /** Internal type for group chats */
  interface GroupChat {
    /** Unique identifier for this chat. */
    id: number;
    /** Type of the chat, can be either “private”, “group”, “supergroup” or “channel” */
    type: "group";
    /** Title, for supergroups, channels and group chats */
    title: string;
    /** Username, for private chats, supergroups and channels if available */
    username?: undefined;
    /** First name of the other party in a private chat */
    first_name?: undefined;
    /** Last name of the other party in a private chat */
    last_name?: undefined;
    /** True, if the supergroup chat is a forum (has topics enabled) */
    is_forum?: undefined;
    /** True, if the chat is the direct messages chat of a channel */
    is_direct_messages?: undefined;
  }
  /** Internal type for supergroup chats */
  interface SupergroupChat {
    /** Unique identifier for this chat. */
    id: number;
    /** Type of the chat, can be either “private”, “group”, “supergroup” or “channel” */
    type: "supergroup";
    /** Title, for supergroups, channels and group chats */
    title: string;
    /** Username, for private chats, supergroups and channels if available */
    username?: string;
    /** First name of the other party in a private chat */
    first_name?: undefined;
    /** Last name of the other party in a private chat */
    last_name?: undefined;
    /** True, if the supergroup chat is a forum (has topics enabled) */
    is_forum?: true;
    /** True, if the chat is the direct messages chat of a channel */
    is_direct_messages?: true;
  }
  /** Internal type for channel chats */
  interface ChannelChat {
    /** Unique identifier for this chat. */
    id: number;
    /** Type of the chat, can be either “private”, “group”, “supergroup” or “channel” */
    type: "channel";
    /** Title, for supergroups, channels and group chats */
    title: string;
    /** Username, for private chats, supergroups and channels if available */
    username?: string;
    /** First name of the other party in a private chat */
    first_name?: undefined;
    /** Last name of the other party in a private chat */
    last_name?: undefined;
    /** True, if the supergroup chat is a forum (has topics enabled) */
    is_forum?: undefined;
    /** True, if the chat is the direct messages chat of a channel */
    is_direct_messages?: undefined;
  }
}
/** This object represents a chat. */
type Chat = Chat.PrivateChat | Chat.GroupChat | Chat.SupergroupChat | Chat.ChannelChat;
declare namespace ChatFullInfo {
  /** Internal type for private chats */
  interface PrivateChat {
    /** Unique identifier for this chat. */
    id: number;
    /** Type of the chat, can be either “private”, “group”, “supergroup” or “channel” */
    type: "private";
    /** Title, for supergroups, channels and group chats */
    title?: undefined;
    /** Username, for private chats, supergroups and channels if available */
    username?: string;
    /** First name of the other party in a private chat */
    first_name: string;
    /** Last name of the other party in a private chat */
    last_name?: string;
    /** True, if the supergroup chat is a forum (has topics enabled) */
    is_forum?: undefined;
    /** True, if the chat is the direct messages chat of a channel */
    is_direct_messages?: undefined;
    /** Identifier of the accent color for the chat name and backgrounds of the chat photo, reply header, and link preview. See accent colors for more details. */
    accent_color_id: number;
    /** The maximum number of reactions that can be set on a message in the chat */
    max_reaction_count: number;
    /** Chat photo */
    photo?: ChatPhoto;
    /** For private chats, the first audio added to the profile of the user */
    first_profile_audio?: Audio;
    /** If non-empty, the list of all active chat usernames; for private chats, supergroups and channels */
    active_usernames?: string[];
    /** For private chats, the date of birth of the user */
    birthdate?: Birthdate;
    /** For private chats with business accounts, the intro of the business */
    business_intro?: BusinessIntro;
    /** For private chats with business accounts, the location of the business */
    business_location?: BusinessLocation;
    /** For private chats with business accounts, the opening hours of the business */
    business_opening_hours?: BusinessOpeningHours;
    /** For private chats, the rating of the user if any */
    rating?: UserRating;
    /** The color scheme based on a unique gift that must be used for the chat's name, message replies and link previews */
    unique_gift_colors?: UniqueGiftColors;
    /** For private chats, the personal channel of the user */
    personal_chat?: Chat;
    /** Information about the corresponding channel chat; for direct messages chats only */
    parent_chat?: undefined;
    /** List of available reactions allowed in the chat. If omitted, then all emoji reactions are allowed. */
    available_reactions?: ReactionType[];
    /** Custom emoji identifier of the emoji chosen by the chat for the reply header and link preview background */
    background_custom_emoji_id?: string;
    /** Identifier of the accent color for the chat's profile background. See profile accent colors for more details. */
    profile_accent_color_id?: number;
    /** Custom emoji identifier of the emoji chosen by the chat for its profile background */
    profile_background_custom_emoji_id?: string;
    /** Custom emoji identifier of the emoji status of the chat or the other party in a private chat */
    emoji_status_custom_emoji_id?: string;
    /** Expiration date of the emoji status of the chat or the other party in a private chat, in Unix time, if any */
    emoji_status_expiration_date?: number;
    /** Bio of the other party in a private chat */
    bio?: string;
    /** True, if privacy settings of the other party in the private chat allows to use tg://user?id=<user_id> links only in chats with the user */
    has_private_forwards?: true;
    /** True, if the privacy settings of the other party restrict sending voice and video note messages in the private chat */
    has_restricted_voice_and_video_messages?: true;
    /** True, if users need to join the supergroup before they can send messages */
    join_to_send_messages?: undefined;
    /** True, if all users directly joining the supergroup without using an invite link need to be approved by supergroup administrators */
    join_by_request?: undefined;
    /** Description, for groups, supergroups and channel chats */
    description?: undefined;
    /** Primary invite link, for groups, supergroups and channel chats */
    invite_link?: undefined;
    /** The most recent pinned message (by sending date) */
    pinned_message?: Message;
    /** Default chat member permissions, for groups and supergroups */
    permissions?: undefined;
    /** Information about types of gifts that are accepted by the chat or by the corresponding user for private chats */
    accepted_gift_types: AcceptedGiftTypes;
    /** True, if paid media messages can be sent or forwarded to the channel chat. The field is available only for channel chats. */
    can_send_paid_media?: undefined;
    /** For supergroups, the minimum allowed delay between consecutive messages sent by each unprivileged user; in seconds */
    slow_mode_delay?: undefined;
    /** For supergroups, the minimum number of boosts that a non-administrator user needs to add in order to ignore slow mode and chat permissions */
    unrestrict_boost_count?: undefined;
    /** The time after which all messages sent to the chat will be automatically deleted; in seconds */
    message_auto_delete_time?: number;
    /** True, if aggressive anti-spam checks are enabled in the supergroup. The field is only available to chat administrators. */
    has_aggressive_anti_spam_enabled?: undefined;
    /** True, if non-administrators can only get the list of bots and administrators in the chat */
    has_hidden_members?: undefined;
    /** True, if messages from the chat can't be forwarded to other chats */
    has_protected_content?: true;
    /** True, if new chat members will have access to old messages; available only to chat administrators */
    has_visible_history?: undefined;
    /** For supergroups, name of the group sticker set */
    sticker_set_name?: undefined;
    /** True, if the bot can change the group sticker set */
    can_set_sticker_set?: undefined;
    /** For supergroups, the name of the group's custom emoji sticker set. Custom emoji from this set can be used by all users and bots in the group. */
    custom_emoji_sticker_set_name?: undefined;
    /** Unique identifier for the linked chat, i.e. the discussion group identifier for a channel and vice versa; for supergroups and channel chats. */
    linked_chat_id?: undefined;
    /** For supergroups, the location to which the supergroup is connected */
    location?: undefined;
  }
  /** Internal type for group chats */
  interface GroupChat {
    /** Unique identifier for this chat. */
    id: number;
    /** Type of the chat, can be either “private”, “group”, “supergroup” or “channel” */
    type: "group";
    /** Title, for supergroups, channels and group chats */
    title: string;
    /** Username, for private chats, supergroups and channels if available */
    username?: undefined;
    /** First name of the other party in a private chat */
    first_name?: undefined;
    /** Last name of the other party in a private chat */
    last_name?: undefined;
    /** True, if the supergroup chat is a forum (has topics enabled) */
    is_forum?: undefined;
    /** True, if the chat is the direct messages chat of a channel */
    is_direct_messages?: undefined;
    /** Identifier of the accent color for the chat name and backgrounds of the chat photo, reply header, and link preview. See accent colors for more details. */
    accent_color_id: number;
    /** The maximum number of reactions that can be set on a message in the chat */
    max_reaction_count: number;
    /** Chat photo */
    photo?: ChatPhoto;
    /** For private chats, the first audio added to the profile of the user */
    first_profile_audio?: undefined;
    /** If non-empty, the list of all active chat usernames; for private chats, supergroups and channels */
    active_usernames?: undefined;
    /** For private chats, the date of birth of the user */
    birthdate?: undefined;
    /** For private chats with business accounts, the intro of the business */
    business_intro?: undefined;
    /** For private chats with business accounts, the location of the business */
    business_location?: undefined;
    /** For private chats with business accounts, the opening hours of the business */
    business_opening_hours?: undefined;
    /** For private chats, the rating of the user if any */
    rating?: undefined;
    /** The color scheme based on a unique gift that must be used for the chat's name, message replies and link previews */
    unique_gift_colors?: UniqueGiftColors;
    /** For private chats, the personal channel of the user */
    personal_chat?: undefined;
    /** Information about the corresponding channel chat; for direct messages chats only */
    parent_chat?: undefined;
    /** List of available reactions allowed in the chat. If omitted, then all emoji reactions are allowed. */
    available_reactions?: ReactionType[];
    /** Custom emoji identifier of the emoji chosen by the chat for the reply header and link preview background */
    background_custom_emoji_id?: string;
    /** Identifier of the accent color for the chat's profile background. See profile accent colors for more details. */
    profile_accent_color_id?: number;
    /** Custom emoji identifier of the emoji chosen by the chat for its profile background */
    profile_background_custom_emoji_id?: string;
    /** Custom emoji identifier of the emoji status of the chat or the other party in a private chat */
    emoji_status_custom_emoji_id?: string;
    /** Expiration date of the emoji status of the chat or the other party in a private chat, in Unix time, if any */
    emoji_status_expiration_date?: number;
    /** Bio of the other party in a private chat */
    bio?: undefined;
    /** True, if privacy settings of the other party in the private chat allows to use tg://user?id=<user_id> links only in chats with the user */
    has_private_forwards?: undefined;
    /** True, if the privacy settings of the other party restrict sending voice and video note messages in the private chat */
    has_restricted_voice_and_video_messages?: undefined;
    /** True, if users need to join the supergroup before they can send messages */
    join_to_send_messages?: undefined;
    /** True, if all users directly joining the supergroup without using an invite link need to be approved by supergroup administrators */
    join_by_request?: undefined;
    /** Description, for groups, supergroups and channel chats */
    description?: string;
    /** Primary invite link, for groups, supergroups and channel chats */
    invite_link?: string;
    /** The most recent pinned message (by sending date) */
    pinned_message?: Message;
    /** Default chat member permissions, for groups and supergroups */
    permissions?: ChatPermissions;
    /** Information about types of gifts that are accepted by the chat or by the corresponding user for private chats */
    accepted_gift_types: AcceptedGiftTypes;
    /** True, if paid media messages can be sent or forwarded to the channel chat. The field is available only for channel chats. */
    can_send_paid_media?: undefined;
    /** For supergroups, the minimum allowed delay between consecutive messages sent by each unprivileged user; in seconds */
    slow_mode_delay?: undefined;
    /** For supergroups, the minimum number of boosts that a non-administrator user needs to add in order to ignore slow mode and chat permissions */
    unrestrict_boost_count?: undefined;
    /** The time after which all messages sent to the chat will be automatically deleted; in seconds */
    message_auto_delete_time?: number;
    /** True, if aggressive anti-spam checks are enabled in the supergroup. The field is only available to chat administrators. */
    has_aggressive_anti_spam_enabled?: undefined;
    /** True, if non-administrators can only get the list of bots and administrators in the chat */
    has_hidden_members?: true;
    /** True, if messages from the chat can't be forwarded to other chats */
    has_protected_content?: true;
    /** True, if new chat members will have access to old messages; available only to chat administrators */
    has_visible_history?: true;
    /** For supergroups, name of the group sticker set */
    sticker_set_name?: undefined;
    /** True, if the bot can change the group sticker set */
    can_set_sticker_set?: true;
    /** For supergroups, the name of the group's custom emoji sticker set. Custom emoji from this set can be used by all users and bots in the group. */
    custom_emoji_sticker_set_name?: undefined;
    /** Unique identifier for the linked chat, i.e. the discussion group identifier for a channel and vice versa; for supergroups and channel chats. */
    linked_chat_id?: undefined;
    /** For supergroups, the location to which the supergroup is connected */
    location?: undefined;
  }
  /** Internal type for supergroup chats */
  interface SupergroupChat {
    /** Unique identifier for this chat. */
    id: number;
    /** Type of the chat, can be either “private”, “group”, “supergroup” or “channel” */
    type: "supergroup";
    /** Title, for supergroups, channels and group chats */
    title: string;
    /** Username, for private chats, supergroups and channels if available */
    username?: string;
    /** First name of the other party in a private chat */
    first_name?: undefined;
    /** Last name of the other party in a private chat */
    last_name?: undefined;
    /** True, if the supergroup chat is a forum (has topics enabled) */
    is_forum?: true;
    /** True, if the chat is the direct messages chat of a channel */
    is_direct_messages?: true;
    /** Identifier of the accent color for the chat name and backgrounds of the chat photo, reply header, and link preview. See accent colors for more details. */
    accent_color_id: number;
    /** The maximum number of reactions that can be set on a message in the chat */
    max_reaction_count: number;
    /** Chat photo */
    photo?: ChatPhoto;
    /** For private chats, the first audio added to the profile of the user */
    first_profile_audio?: undefined;
    /** If non-empty, the list of all active chat usernames; for private chats, supergroups and channels */
    active_usernames?: string[];
    /** For private chats, the date of birth of the user */
    birthdate?: undefined;
    /** For private chats with business accounts, the intro of the business */
    business_intro?: undefined;
    /** For private chats with business accounts, the location of the business */
    business_location?: undefined;
    /** For private chats with business accounts, the opening hours of the business */
    business_opening_hours?: undefined;
    /** For private chats, the rating of the user if any */
    rating?: undefined;
    /** The color scheme based on a unique gift that must be used for the chat's name, message replies and link previews */
    unique_gift_colors?: UniqueGiftColors;
    /** For private chats, the personal channel of the user */
    personal_chat?: undefined;
    /** Information about the corresponding channel chat; for direct messages chats only */
    parent_chat?: Chat.ChannelChat;
    /** List of available reactions allowed in the chat. If omitted, then all emoji reactions are allowed. */
    available_reactions?: ReactionType[];
    /** Custom emoji identifier of the emoji chosen by the chat for the reply header and link preview background */
    background_custom_emoji_id?: string;
    /** Identifier of the accent color for the chat's profile background. See profile accent colors for more details. */
    profile_accent_color_id?: number;
    /** Custom emoji identifier of the emoji chosen by the chat for its profile background */
    profile_background_custom_emoji_id?: string;
    /** Custom emoji identifier of the emoji status of the chat or the other party in a private chat */
    emoji_status_custom_emoji_id?: string;
    /** Expiration date of the emoji status of the chat or the other party in a private chat, in Unix time, if any */
    emoji_status_expiration_date?: number;
    /** Bio of the other party in a private chat */
    bio?: string;
    /** True, if privacy settings of the other party in the private chat allows to use tg://user?id=<user_id> links only in chats with the user */
    has_private_forwards?: undefined;
    /** True, if the privacy settings of the other party restrict sending voice and video note messages in the private chat */
    has_restricted_voice_and_video_messages?: undefined;
    /** True, if users need to join the supergroup before they can send messages */
    join_to_send_messages?: true;
    /** True, if all users directly joining the supergroup without using an invite link need to be approved by supergroup administrators */
    join_by_request?: true;
    /** Description, for groups, supergroups and channel chats */
    description?: string;
    /** Primary invite link, for groups, supergroups and channel chats */
    invite_link?: string;
    /** The most recent pinned message (by sending date) */
    pinned_message?: Message;
    /** Default chat member permissions, for groups and supergroups */
    permissions?: ChatPermissions;
    /** Information about types of gifts that are accepted by the chat or by the corresponding user for private chats */
    accepted_gift_types: AcceptedGiftTypes;
    /** True, if paid media messages can be sent or forwarded to the channel chat. The field is available only for channel chats. */
    can_send_paid_media?: undefined;
    /** For supergroups, the minimum allowed delay between consecutive messages sent by each unprivileged user; in seconds */
    slow_mode_delay?: number;
    /** For supergroups, the minimum number of boosts that a non-administrator user needs to add in order to ignore slow mode and chat permissions */
    unrestrict_boost_count?: number;
    /** The time after which all messages sent to the chat will be automatically deleted; in seconds */
    message_auto_delete_time?: number;
    /** True, if aggressive anti-spam checks are enabled in the supergroup. The field is only available to chat administrators. */
    has_aggressive_anti_spam_enabled?: true;
    /** True, if non-administrators can only get the list of bots and administrators in the chat */
    has_hidden_members?: true;
    /** True, if messages from the chat can't be forwarded to other chats */
    has_protected_content?: true;
    /** True, if new chat members will have access to old messages; available only to chat administrators */
    has_visible_history?: true;
    /** For supergroups, name of the group sticker set */
    sticker_set_name?: string;
    /** True, if the bot can change the group sticker set */
    can_set_sticker_set?: true;
    /** For supergroups, the name of the group's custom emoji sticker set. Custom emoji from this set can be used by all users and bots in the group. */
    custom_emoji_sticker_set_name?: string;
    /** Unique identifier for the linked chat, i.e. the discussion group identifier for a channel and vice versa; for supergroups and channel chats. */
    linked_chat_id?: number;
    /** For supergroups, the location to which the supergroup is connected */
    location?: ChatLocation;
  }
  /** Internal type for channel chats */
  interface ChannelChat {
    /** Unique identifier for this chat. */
    id: number;
    /** Type of the chat, can be either “private”, “group”, “supergroup” or “channel” */
    type: "channel";
    /** Title, for supergroups, channels and group chats */
    title: string;
    /** Username, for private chats, supergroups and channels if available */
    username?: string;
    /** First name of the other party in a private chat */
    first_name?: undefined;
    /** Last name of the other party in a private chat */
    last_name?: undefined;
    /** True, if the supergroup chat is a forum (has topics enabled) */
    is_forum?: undefined;
    /** True, if the chat is the direct messages chat of a channel */
    is_direct_messages?: undefined;
    /** Identifier of the accent color for the chat name and backgrounds of the chat photo, reply header, and link preview. See accent colors for more details. */
    accent_color_id: number;
    /** The maximum number of reactions that can be set on a message in the chat */
    max_reaction_count: number;
    /** Chat photo */
    photo?: ChatPhoto;
    /** For private chats, the first audio added to the profile of the user */
    first_profile_audio?: undefined;
    /** If non-empty, the list of all active chat usernames; for private chats, supergroups and channels */
    active_usernames?: string[];
    /** For private chats, the date of birth of the user */
    birthdate?: undefined;
    /** For private chats with business accounts, the intro of the business */
    business_intro?: undefined;
    /** For private chats with business accounts, the location of the business */
    business_location?: undefined;
    /** For private chats with business accounts, the opening hours of the business */
    business_opening_hours?: undefined;
    /** For private chats, the rating of the user if any */
    rating?: undefined;
    /** The color scheme based on a unique gift that must be used for the chat's name, message replies and link previews */
    unique_gift_colors?: UniqueGiftColors;
    /** For private chats, the personal channel of the user */
    personal_chat?: undefined;
    /** Information about the corresponding channel chat; for direct messages chats only */
    parent_chat?: undefined;
    /** List of available reactions allowed in the chat. If omitted, then all emoji reactions are allowed. */
    available_reactions?: ReactionType[];
    /** Custom emoji identifier of the emoji chosen by the chat for the reply header and link preview background */
    background_custom_emoji_id?: string;
    /** Identifier of the accent color for the chat's profile background. See profile accent colors for more details. */
    profile_accent_color_id?: number;
    /** Custom emoji identifier of the emoji chosen by the chat for its profile background */
    profile_background_custom_emoji_id?: string;
    /** Custom emoji identifier of the emoji status of the chat or the other party in a private chat */
    emoji_status_custom_emoji_id?: string;
    /** Expiration date of the emoji status of the chat or the other party in a private chat, in Unix time, if any */
    emoji_status_expiration_date?: number;
    /** Bio of the other party in a private chat */
    bio?: undefined;
    /** True, if privacy settings of the other party in the private chat allows to use tg://user?id=<user_id> links only in chats with the user */
    has_private_forwards?: undefined;
    /** True, if the privacy settings of the other party restrict sending voice and video note messages in the private chat */
    has_restricted_voice_and_video_messages?: undefined;
    /** True, if users need to join the supergroup before they can send messages */
    join_to_send_messages?: true;
    /** True, if all users directly joining the supergroup without using an invite link need to be approved by supergroup administrators */
    join_by_request?: undefined;
    /** Description, for groups, supergroups and channel chats */
    description?: string;
    /** Primary invite link, for groups, supergroups and channel chats */
    invite_link?: string;
    /** The most recent pinned message (by sending date) */
    pinned_message?: Message;
    /** Default chat member permissions, for groups and supergroups */
    permissions?: undefined;
    /** Information about types of gifts that are accepted by the chat or by the corresponding user for private chats */
    accepted_gift_types: AcceptedGiftTypes;
    /** True, if paid media messages can be sent or forwarded to the channel chat. The field is available only for channel chats. */
    can_send_paid_media?: true;
    /** For supergroups, the minimum allowed delay between consecutive messages sent by each unprivileged user; in seconds */
    slow_mode_delay?: undefined;
    /** For supergroups, the minimum number of boosts that a non-administrator user needs to add in order to ignore slow mode and chat permissions */
    unrestrict_boost_count?: undefined;
    /** The time after which all messages sent to the chat will be automatically deleted; in seconds */
    message_auto_delete_time?: number;
    /** True, if aggressive anti-spam checks are enabled in the supergroup. The field is only available to chat administrators. */
    has_aggressive_anti_spam_enabled?: undefined;
    /** True, if non-administrators can only get the list of bots and administrators in the chat */
    has_hidden_members?: undefined;
    /** True, if messages from the chat can't be forwarded to other chats */
    has_protected_content?: true;
    /** True, if new chat members will have access to old messages; available only to chat administrators */
    has_visible_history?: undefined;
    /** For supergroups, name of the group sticker set */
    sticker_set_name?: undefined;
    /** True, if the bot can change the group sticker set */
    can_set_sticker_set?: undefined;
    /** For supergroups, the name of the group's custom emoji sticker set. Custom emoji from this set can be used by all users and bots in the group. */
    custom_emoji_sticker_set_name?: undefined;
    /** Unique identifier for the linked chat, i.e. the discussion group identifier for a channel and vice versa; for supergroups and channel chats. */
    linked_chat_id?: number;
    /** For supergroups, the location to which the supergroup is connected */
    location?: undefined;
  }
}
/** This object contains full information about a chat. */
type ChatFullInfo = ChatFullInfo.PrivateChat | ChatFullInfo.GroupChat | ChatFullInfo.SupergroupChat | ChatFullInfo.ChannelChat;
/** This object represents a chat photo. */
interface ChatPhoto {
  /** File identifier of small (160x160) chat photo. This file_id can be used only for photo download and only for as long as the photo is not changed. */
  small_file_id: string;
  /** Unique file identifier of small (160x160) chat photo, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  small_file_unique_id: string;
  /** File identifier of big (640x640) chat photo. This file_id can be used only for photo download and only for as long as the photo is not changed. */
  big_file_id: string;
  /** Unique file identifier of big (640x640) chat photo, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. */
  big_file_unique_id: string;
}
/** Describes actions that a non-administrator user is allowed to take in a chat. */
interface ChatPermissions {
  /** True, if the user is allowed to send text messages, contacts, giveaways, giveaway winners, invoices, locations and venues */
  can_send_messages?: boolean;
  /** True, if the user is allowed to send audios */
  can_send_audios?: boolean;
  /** True, if the user is allowed to send documents */
  can_send_documents?: boolean;
  /** True, if the user is allowed to send photos */
  can_send_photos?: boolean;
  /** True, if the user is allowed to send videos */
  can_send_videos?: boolean;
  /** True, if the user is allowed to send video notes */
  can_send_video_notes?: boolean;
  /** True, if the user is allowed to send voice notes */
  can_send_voice_notes?: boolean;
  /** True, if the user is allowed to send polls and checklists */
  can_send_polls?: boolean;
  /** True, if the user is allowed to send animations, games, stickers and use inline bots */
  can_send_other_messages?: boolean;
  /** True, if the user is allowed to add web page previews to their messages */
  can_add_web_page_previews?: boolean;
  /** True, if the user is allowed to change the chat title, photo and other settings. Ignored in public supergroups */
  can_change_info?: boolean;
  /** True, if the user is allowed to invite new users to the chat */
  can_invite_users?: boolean;
  /** True, if the user is allowed to edit their own tag */
  can_edit_tag?: boolean;
  /** True, if the user is allowed to pin messages. Ignored in public supergroups */
  can_pin_messages?: boolean;
  /** True, if the user is allowed to create forum topics. If omitted defaults to the value of can_pin_messages */
  can_manage_topics?: boolean;
}
/** Describes the birthdate of a user. */
interface Birthdate {
  /** Day of the user's birth; 1-31 */
  day: number;
  /** Month of the user's birth; 1-12 */
  month: number;
  /** Year of the user's birth */
  year?: number;
}
/** Contains information about the start page settings of a Telegram Business account. */
interface BusinessIntro {
  /** Title text of the business intro */
  title?: string;
  /** Message text of the business intro */
  message?: string;
  /** Sticker of the business intro */
  sticker?: Sticker;
}
/** Contains information about the location of a Telegram Business account. */
interface BusinessLocation {
  /** Address of the business */
  address: string;
  /** Location of the business */
  location?: Location;
}
/** Describes an interval of time during which a business is open. */
interface BusinessOpeningHoursInterval {
  /** The minute's sequence number in a week, starting on Monday, marking the start of the time interval during which the business is open; 0 - 7 * 24 * 60 */
  opening_minute: number;
  /** The minute's sequence number in a week, starting on Monday, marking the end of the time interval during which the business is open; 0 - 8 * 24 * 60 */
  closing_minute: number;
}
/** Describes the opening hours of a business. */
interface BusinessOpeningHours {
  /** Unique name of the time zone for which the opening hours are defined */
  time_zone_name: string;
  /** List of time intervals describing business opening hours */
  opening_hours: BusinessOpeningHoursInterval[];
}
/** Represents a location to which a chat is connected. */
interface ChatLocation {
  /** The location to which the supergroup is connected. Can't be a live location. */
  location: Location;
  /** Location address; 1-64 characters, as defined by the chat owner */
  address: string;
}
//#endregion
//#region node_modules/@grammyjs/types/checklist.d.ts
/** Describes a task in a checklist. */
interface ChecklistTask {
  /** Unique identifier of the task */
  id: number;
  /** Text of the task */
  text: string;
  /** Special entities that appear in the task text */
  text_entities?: MessageEntity[];
  /** User that completed the task; omitted if the task wasn't completed by a user */
  completed_by_user?: User;
  /** Chat that completed the task; omitted if the task wasn't completed by a chat */
  completed_by_chat?: Chat;
  /** Point in time (Unix timestamp) when the task was completed; 0 if the task wasn't completed */
  completion_date?: number;
}
/** Describes a checklist. */
interface Checklist {
  /** Title of the checklist */
  title: string;
  /** Special entities that appear in the checklist title */
  title_entities?: MessageEntity[];
  /** List of tasks in the checklist */
  tasks: ChecklistTask[];
  /** True, if users other than the creator of the list can add tasks to the list */
  others_can_add_tasks?: true;
  /** True, if users other than the creator of the list can mark tasks as done or not done */
  others_can_mark_tasks_as_done?: true;
}
/** Describes a service message about checklist tasks marked as done or not done. */
interface ChecklistTasksDone {
  /** Message containing the checklist whose tasks were marked as done or not done. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  checklist_message?: Message;
  /** Identifiers of the tasks that were marked as done */
  marked_as_done_task_ids?: number[];
  /** Identifiers of the tasks that were marked as not done */
  marked_as_not_done_task_ids?: number[];
}
/** Describes a service message about tasks added to a checklist. */
interface ChecklistTasksAdded {
  /** Message containing the checklist to which the tasks were added. Note that the Message object in this field will not contain the reply_to_message field even if it itself is a reply. */
  checklist_message?: Message;
  /** List of tasks added to the checklist */
  tasks: ChecklistTask[];
}
//#endregion
//#region extensions/telegram/src/action-threading.d.ts
declare function resolveTelegramAutoThreadId(params: {
  to: string;
  toolContext?: {
    currentThreadTs?: string;
    currentChannelId?: string;
  };
}): string | undefined;
//#endregion
//#region extensions/telegram/src/api-fetch.d.ts
declare function resolveTelegramChatLookupFetch(params?: {
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
}): typeof fetch;
declare function lookupTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
  apiRoot?: string;
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
}): Promise<string | null>;
declare function fetchTelegramChatId(params: {
  token: string;
  chatId: string;
  signal?: AbortSignal;
  apiRoot?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null>;
//#endregion
//#region extensions/telegram/src/bot/body-helpers.d.ts
type TelegramMediaMessage = Pick<Message, "photo" | "video" | "video_note" | "audio" | "voice" | "document" | "sticker">;
declare function buildSenderName(msg: Message): string | undefined;
declare function resolveTelegramMediaPlaceholder(msg: TelegramMediaMessage | undefined | null): string | undefined;
declare function buildSenderLabel(msg: Message, senderId?: number | string): string;
type TelegramTextEntity = NonNullable<Message["entities"]>[number];
declare function isBinaryContent(text: string): boolean;
declare function getTelegramTextParts(msg: Pick<Message, "text" | "caption" | "entities" | "caption_entities">): {
  text: string;
  entities: TelegramTextEntity[];
};
declare function hasBotMention(msg: Message, botUsername: string): boolean;
type TelegramTextLinkEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};
declare function expandTextLinks(text: string, entities?: TelegramTextLinkEntity[] | null): string;
type TelegramForwardedContext = {
  from: string;
  date?: number;
  fromType: string;
  fromId?: string;
  fromUsername?: string;
  fromTitle?: string;
  fromSignature?: string;
  fromChatType?: Chat["type"];
  fromMessageId?: number;
};
declare function normalizeForwardedContext(msg: Message): TelegramForwardedContext | null;
declare function extractTelegramLocation(msg: Message): NormalizedLocation | null;
//#endregion
//#region extensions/telegram/src/bot/types.d.ts
/** App-specific stream mode for Telegram stream previews. */
type TelegramStreamMode = "off" | "partial" | "block" | "progress";
type TelegramChatDetails = {
  id?: number | string;
  available_reactions?: ChatFullInfo["available_reactions"] | null;
  is_forum?: boolean;
};
type TelegramGetChat = (chatId: number | string) => Promise<TelegramChatDetails>;
/** Telegram sticker metadata for context enrichment and caching. */
interface StickerMetadata {
  /** Emoji associated with the sticker. */
  emoji?: string;
  /** Name of the sticker set the sticker belongs to. */
  setName?: string;
  /** Telegram file_id for sending the sticker back. */
  fileId?: string;
  /** Stable file_unique_id for cache deduplication. */
  fileUniqueId?: string;
  /** Cached description from previous vision processing (skip re-processing if present). */
  cachedDescription?: string;
}
//#endregion
//#region extensions/telegram/src/bot/helpers.d.ts
declare function resetTelegramForumFlagCacheForTest(): void;
type TelegramThreadSpec = {
  id?: number;
  scope: "dm" | "forum" | "none";
};
declare function extractTelegramForumFlag(value: unknown): boolean | undefined;
declare function resolveTelegramForumFlag(params: {
  chatId: string | number;
  chatType?: Chat["type"];
  isGroup: boolean;
  isForum?: boolean;
  getChat?: TelegramGetChat;
}): Promise<boolean>;
declare function withResolvedTelegramForumFlag<T extends {
  chat: object;
}>(message: T, isForum: boolean): T;
declare function resolveTelegramGroupAllowFromContext(params: {
  cfg?: OpenClawConfig;
  chatId: string | number;
  accountId?: string;
  senderId?: string;
  isGroup?: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
  groupAllowFrom?: Array<string | number>;
  readChannelAllowFromStore?: typeof readChannelAllowFromStore;
  resolveTelegramGroupConfig: (chatId: string | number, messageThreadId?: number) => {
    groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
    topicConfig?: TelegramTopicConfig;
  };
}): Promise<{
  resolvedThreadId?: number;
  dmThreadId?: number;
  storeAllowFrom: string[];
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  groupAllowOverride?: Array<string | number>;
  effectiveGroupAllow: NormalizedAllowFrom;
  hasGroupAllowOverride: boolean;
}>;
/**
 * Resolve the thread ID for Telegram forum topics.
 * For non-forum groups, returns undefined even if messageThreadId is present
 * (reply threads in regular groups should not create separate sessions).
 * For forum groups, returns the topic ID (or General topic ID=1 if unspecified).
 */
declare function resolveTelegramForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}): number | undefined;
declare function resolveTelegramThreadSpec(params: {
  isGroup: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
}): TelegramThreadSpec;
/**
 * Build thread params for Telegram API calls (messages, media).
 *
 * IMPORTANT: Thread IDs behave differently based on chat type:
 * - DMs (private chats): Include message_thread_id when present (DM topics)
 * - Forum topics: Skip thread_id=1 (General topic), include others
 * - Regular groups: Thread IDs are ignored by Telegram
 *
 * General forum topic (id=1) must be treated like a regular supergroup send:
 * Telegram rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
 *
 * @param thread - Thread specification with ID and scope
 * @returns API params object or undefined if thread_id should be omitted
 */
declare function buildTelegramThreadParams(thread?: TelegramThreadSpec | null): {
  message_thread_id: number;
} | undefined;
/**
 * Build a Telegram routing target that keeps real topic/thread ids in-band.
 *
 * This is used by generic reply plumbing that may not always carry a separate
 * `threadId` field through every hop. General forum topic stays chat-scoped
 * because Telegram rejects `message_thread_id=1` for message sends.
 */
declare function buildTelegramRoutingTarget(chatId: number | string, thread?: TelegramThreadSpec | null): string;
/**
 * Build thread params for typing indicators (sendChatAction).
 * Empirically, General topic (id=1) needs message_thread_id for typing to appear.
 */
declare function buildTypingThreadParams(messageThreadId?: number): {
  message_thread_id: number;
} | undefined;
declare function resolveTelegramStreamMode(telegramCfg?: {
  streaming?: unknown;
  streamMode?: unknown;
}): TelegramStreamMode;
declare function buildTelegramGroupPeerId(chatId: number | string, messageThreadId?: number): string;
/**
 * Resolve the direct-message peer identifier for Telegram routing/session keys.
 *
 * In some Telegram DM deliveries (for example certain business/chat bridge flows),
 * `chat.id` can differ from the actual sender user id. Prefer sender id when present
 * so per-peer DM scopes isolate users correctly.
 */
declare function resolveTelegramDirectPeerId(params: {
  chatId: number | string;
  senderId?: number | string | null;
}): string;
declare function buildTelegramGroupFrom(chatId: number | string, messageThreadId?: number): string;
/**
 * Build parentPeer for forum topic binding inheritance.
 * When a message comes from a forum topic, the peer ID includes the topic suffix
 * (e.g., `-1001234567890:topic:99`). To allow bindings configured for the base
 * group ID to match, we provide the parent group as `parentPeer` so the routing
 * layer can fall back to it when the exact peer doesn't match.
 */
declare function buildTelegramParentPeer(params: {
  isGroup: boolean;
  resolvedThreadId?: number;
  chatId: number | string;
}): {
  kind: "group";
  id: string;
} | undefined;
declare function buildGroupLabel(msg: Message, chatId: number | string, messageThreadId?: number): string;
declare function resolveTelegramReplyId(raw?: string): number | undefined;
type TelegramReplyTarget = {
  id?: string;
  sender: string;
  senderId?: string;
  senderUsername?: string;
  body?: string;
  kind: "reply" | "quote";
  source: "reply_to_message" | "external_reply";
  quoteText?: string;
  quotePosition?: number;
  quoteEntities?: TelegramTextEntity[]; /** Forward context if the reply target was itself a forwarded message (issue #9619). */
  forwardedFrom?: TelegramForwardedContext;
  quoteSourceText?: string;
  quoteSourceEntities?: TelegramTextEntity[];
};
declare function describeReplyTarget(msg: Message): TelegramReplyTarget | null;
//#endregion
//#region extensions/telegram/src/exec-approvals.d.ts
declare function resolveTelegramExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramExecApprovalConfig | undefined;
declare function getTelegramExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[];
declare function isTelegramExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean;
declare const isTelegramExecApprovalClientEnabled: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => boolean;
declare const isTelegramExecApprovalApprover: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
} & {
  senderId?: string | null;
}) => boolean;
declare const isTelegramExecApprovalAuthorizedSender: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
} & {
  senderId?: string | null;
}) => boolean;
declare const resolveTelegramExecApprovalTarget: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => "channel" | "dm" | "both";
declare const shouldHandleTelegramExecApprovalRequest: (input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
} & {
  request: ExecApprovalRequest | PluginApprovalRequest;
}) => boolean;
declare function shouldInjectTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean;
declare function shouldEnableTelegramExecApprovalButtons(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): boolean;
declare function shouldSuppressLocalTelegramExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean;
declare function isTelegramExecApprovalHandlerConfigured(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean;
//#endregion
//#region extensions/telegram/src/group-policy.d.ts
declare function resolveTelegramGroupRequireMention(params: ChannelGroupContext): boolean | undefined;
declare function resolveTelegramGroupToolPolicy(params: ChannelGroupContext): GroupToolPolicyConfig | undefined;
//#endregion
//#region extensions/telegram/src/targets.d.ts
type TelegramTarget = {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
};
declare function stripTelegramInternalPrefixes(to: string): string;
declare function normalizeTelegramChatId(raw: string): string | undefined;
declare function isNumericTelegramChatId(raw: string): boolean;
declare function normalizeTelegramLookupTarget(raw: string): string | undefined;
declare function parseTelegramTarget(to: string): TelegramTarget;
declare function resolveTelegramTargetChatType(target: string): "direct" | "group" | "unknown";
//#endregion
//#region extensions/telegram/src/inline-buttons.d.ts
declare function resolveTelegramInlineButtonsConfigScope(capabilities: unknown): TelegramInlineButtonsScope | undefined;
declare function resolveTelegramInlineButtonsScopeFromCapabilities(capabilities: unknown): TelegramInlineButtonsScope;
declare function resolveTelegramInlineButtonsScope(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramInlineButtonsScope;
declare function isTelegramInlineButtonsEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean;
//#endregion
//#region extensions/telegram/src/normalize.d.ts
declare function normalizeTelegramMessagingTarget(raw: string): string | undefined;
declare function looksLikeTelegramTargetId(raw: string): boolean;
//#endregion
//#region extensions/telegram/src/outbound-adapter.d.ts
declare const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;
type TelegramSendFn = typeof sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];
declare function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>>;
declare const telegramOutbound: ChannelOutboundAdapter;
//#endregion
//#region extensions/telegram/src/outbound-params.d.ts
declare function normalizeTelegramReplyToMessageId(value: unknown): number | undefined;
declare function parseTelegramReplyToMessageId(replyToId?: string | null): number | undefined;
declare function parseTelegramThreadId(threadId?: string | number | null): number | undefined;
//#endregion
//#region extensions/telegram/src/reaction-level.d.ts
type TelegramReactionLevel = ReactionLevel;
type ResolvedReactionLevel = ResolvedReactionLevel$1;
/**
 * Resolve the effective reaction level and its implications.
 */
declare function resolveTelegramReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedReactionLevel;
//#endregion
//#region extensions/telegram/src/status-issues.d.ts
declare function collectTelegramStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[];
//#endregion
//#region extensions/telegram/src/format.d.ts
type TelegramFormattedChunk = {
  html: string;
  text: string;
};
declare function escapeTelegramHtml(text: string): string;
declare function markdownToTelegramHtml(markdown: string, options?: {
  tableMode?: MarkdownTableMode;
  wrapFileRefs?: boolean;
}): string;
declare function splitTelegramHtmlChunks(html: string, limit: number): string[];
declare function markdownToTelegramChunks(markdown: string, limit: number, options?: {
  tableMode?: MarkdownTableMode;
}): TelegramFormattedChunk[];
declare function markdownToTelegramHtmlChunks(markdown: string, limit: number): string[];
//#endregion
export { type ButtonRow, type CachedSticker, type DescribeStickerParams, type InspectedTelegramAccount, type ModelsKeyboardParams, type ParsedModelCallback, type ParsedTelegramTopicConversation, type ProviderInfo, type ResolveModelSelectionResult, type ResolvedReactionLevel, type ResolvedTelegramAccount, type StickerMetadata, TELEGRAM_COMMAND_NAME_PATTERN, TELEGRAM_TEXT_CHUNK_LIMIT, type TelegramButtonStyle, type TelegramCredentialStatus, type TelegramCustomCommandInput, type TelegramCustomCommandIssue, type TelegramFormattedChunk, type TelegramForwardedContext, type TelegramInlineButtons, type TelegramInteractiveHandlerContext, type TelegramInteractiveHandlerRegistration, type TelegramMediaRuntimeOptions, type TelegramPollActionGateState, type TelegramProbe, type TelegramProbeOptions, type TelegramReactionLevel, type TelegramReplyTarget, type TelegramTarget, type TelegramTextEntity, type TelegramThreadSpec, type TelegramTokenResolution, buildBrowseProvidersButton, buildCommandsPaginationKeyboard, buildGroupLabel, buildModelSelectionCallbackData, buildModelsKeyboard, buildProviderKeyboard, buildSenderLabel, buildSenderName, buildTelegramExecApprovalPendingPayload, buildTelegramGroupFrom, buildTelegramGroupPeerId, buildTelegramModelsProviderChannelData, buildTelegramParentPeer, buildTelegramRoutingTarget, buildTelegramThreadParams, buildTypingThreadParams, cacheSticker, calculateTotalPages, collectTelegramSecurityAuditFindings, collectTelegramStatusIssues, createTelegramActionGate, deleteTelegramUpdateOffset, describeReplyTarget, describeStickerImage, escapeTelegramHtml, expandTextLinks, extractTelegramForumFlag, extractTelegramLocation, fetchTelegramChatId, getAllCachedStickers, getCacheStats, getCachedSticker, getModelsPageSize, getTelegramExecApprovalApprovers, getTelegramTextParts, hasBotMention, inspectTelegramAccount, isBinaryContent, isNumericTelegramChatId, isNumericTelegramSenderUserId, isNumericTelegramUserId, isTelegramExecApprovalApprover, isTelegramExecApprovalAuthorizedSender, isTelegramExecApprovalClientEnabled, isTelegramExecApprovalHandlerConfigured, isTelegramExecApprovalTargetRecipient, isTelegramInlineButtonsEnabled, listEnabledTelegramAccounts, listTelegramAccountIds, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, looksLikeTelegramTargetId, lookupTelegramChatId, markdownToTelegramChunks, markdownToTelegramHtml, markdownToTelegramHtmlChunks, mergeTelegramAccountConfig, normalizeForwardedContext, normalizeTelegramAllowFromEntry, normalizeTelegramChatId, normalizeTelegramCommandDescription, normalizeTelegramCommandName, normalizeTelegramLookupTarget, normalizeTelegramMessagingTarget, normalizeTelegramReplyToMessageId, parseModelCallbackData, parseTelegramReplyToMessageId, parseTelegramTarget, parseTelegramThreadId, parseTelegramTopicConversation, probeTelegram, readTelegramUpdateOffset, resetMissingDefaultWarnFlag, resetTelegramForumFlagCacheForTest, resetTelegramProbeFetcherCacheForTests, resolveDefaultTelegramAccountId, resolveModelSelection, resolveTelegramAccount, resolveTelegramAccountConfig, resolveTelegramAutoThreadId, resolveTelegramChatLookupFetch, resolveTelegramCustomCommands, resolveTelegramDirectPeerId, resolveTelegramExecApprovalConfig, resolveTelegramExecApprovalTarget, resolveTelegramForumFlag, resolveTelegramForumThreadId, resolveTelegramGroupAllowFromContext, resolveTelegramGroupRequireMention, resolveTelegramGroupToolPolicy, resolveTelegramInlineButtonsConfigScope, resolveTelegramInlineButtonsScope, resolveTelegramInlineButtonsScopeFromCapabilities, resolveTelegramMediaPlaceholder, resolveTelegramMediaRuntimeOptions, resolveTelegramPollActionGateState, resolveTelegramReactionLevel, resolveTelegramReplyId, resolveTelegramStreamMode, resolveTelegramTargetChatType, resolveTelegramThreadSpec, searchStickers, sendTelegramPayloadMessages, shouldEnableTelegramExecApprovalButtons, shouldHandleTelegramExecApprovalRequest, shouldInjectTelegramExecApprovalButtons, shouldSuppressLocalTelegramExecApprovalPrompt, shouldSuppressTelegramExecApprovalForwardingFallback, splitTelegramHtmlChunks, stripTelegramInternalPrefixes, telegramOutbound, telegramPlugin, telegramSetupPlugin, withResolvedTelegramForumFlag, writeTelegramUpdateOffset };