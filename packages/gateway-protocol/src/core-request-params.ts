import type { Static } from "typebox";
import type * as AgentSchema from "./schema/agent.js";
import type * as BoardSchema from "./schema/board.js";
import type { CanvasDocumentPreviewParams, CanvasDocumentViewParams } from "./schema/canvas.js";
import type { CommandsListParams } from "./schema/commands.js";
import type { CronHistoryParams } from "./schema/cron.js";
import type {
  EnvironmentsSessionCreateParams,
  EnvironmentsSessionStatusParams,
  EnvironmentsSessionDestroyParams,
  EnvironmentsSessionExecParams,
} from "./schema/environments.js";
import type * as HumanMentionsSchema from "./schema/human-mentions.js";
import type { LogsTailParams } from "./schema/logs-chat.js";
import type * as PortalSchema from "./schema/portals.js";
import type * as GitHubSchema from "./schema/session-github-publication.js";
import type {
  ThemesListParams,
  ThemesGetParams,
  ThemesSetParams,
  ThemesImportParams,
} from "./schema/themes.js";
import type { UiCommandParams } from "./schema/ui-command.js";
import type { UpdateRunsGetParams, UpdateRunsListParams } from "./schema/update-runs.js";
import type * as UsersSchema from "./schema/users.js";

/** Schema-derived payload ownership for statically validated core Gateway methods. */
export type GatewayCoreRequestParams = {
  "cron.history": CronHistoryParams;
  "users.personalFile.get": UsersSchema.UsersPersonalFileGetParams;
  "users.personalFile.set": UsersSchema.UsersPersonalFileSetParams;
  "canvas.document.preview": CanvasDocumentPreviewParams;
  "canvas.document.view": CanvasDocumentViewParams;
  "board.action": BoardSchema.BoardActionParams;
  "board.data.read": BoardSchema.BoardDataReadParams;
  "board.event": BoardSchema.BoardEventParams;
  "board.get": BoardSchema.BoardGetParams;
  "board.prompt.authorize": BoardSchema.BoardPromptAuthorizeParams;
  "board.update": BoardSchema.BoardUpdateParams;
  "board.widget.appView": BoardSchema.BoardWidgetAppViewParams;
  "board.widget.grant": BoardSchema.BoardWidgetGrantParams;
  "board.widget.put": BoardSchema.BoardWidgetPutParams;
  "commands.list": CommandsListParams;
  "environments.session.create": EnvironmentsSessionCreateParams;
  "environments.session.status": EnvironmentsSessionStatusParams;
  "environments.session.destroy": EnvironmentsSessionDestroyParams;
  "environments.session.exec": EnvironmentsSessionExecParams;
  "conversations.list": AgentSchema.ConversationListParams;
  "conversations.send": AgentSchema.ConversationSendParams;
  "conversations.turn": AgentSchema.ConversationTurnParams;
  "conversations.turn.cancel": AgentSchema.ConversationTurnCancelParams;
  "logs.tail": LogsTailParams;
  "mentions.list": HumanMentionsSchema.MentionsListParams;
  "mentions.dismiss": HumanMentionsSchema.MentionsDismissParams;
  "portal.close": PortalSchema.PortalCloseParams;
  "portal.list": PortalSchema.PortalListParams;
  "portal.open": PortalSchema.PortalOpenParams;
  "portal.session.close": Static<typeof PortalSchema.SessionPortalCloseParamsSchema>;
  "portal.session.list": Static<typeof PortalSchema.SessionPortalListParamsSchema>;
  "portal.session.open": Static<typeof PortalSchema.SessionPortalOpenParamsSchema>;
  "sessions.github.publish": GitHubSchema.SessionGitHubPublishParams;
  "sessions.github.options": Static<typeof GitHubSchema.SessionGitHubOptionsParamsSchema>;
  "sessions.github.status": Static<typeof GitHubSchema.SessionGitHubStatusParamsSchema>;
  "sessions.github.confirm": GitHubSchema.SessionGitHubConfirmParams;
  "update.runs.get": UpdateRunsGetParams;
  "update.runs.list": UpdateRunsListParams;
  "users.authConnect.catalog": UsersSchema.UsersAuthConnectCatalogParams;
  "users.authConnect.start": UsersSchema.UsersAuthConnectStartParams;
  "users.authConnect.answer": UsersSchema.UsersAuthConnectAnswerParams;
  "users.authConnect.status": UsersSchema.UsersAuthConnectStatusParams;
  "users.authConnect.cancel": UsersSchema.UsersAuthConnectCancelParams;
  "users.listAuthLinks": UsersSchema.UsersListAuthLinksParams;
  "users.listModelAccounts": UsersSchema.UsersListModelAccountsParams;
  "users.selectModelAccount": UsersSchema.UsersSelectModelAccountParams;
  "users.linkAuthProfile": UsersSchema.UsersLinkAuthProfileParams;
  "users.linkChannelIdentity": UsersSchema.UsersLinkChannelIdentityParams;
  "users.unlinkChannelIdentity": UsersSchema.UsersUnlinkChannelIdentityParams;
  "users.listChannelIdentities": UsersSchema.UsersListChannelIdentitiesParams;
  "users.unlinkAuthProfile": UsersSchema.UsersUnlinkAuthProfileParams;
  "users.github.status": Static<typeof UsersSchema.UsersGitHubStatusParamsSchema>;
  "users.github.authorize.start": Static<typeof UsersSchema.UsersGitHubAuthorizeStartParamsSchema>;
  "users.github.authorize.poll": Static<typeof UsersSchema.UsersGitHubAuthorizePollParamsSchema>;
  "users.github.authorize.cancel": Static<
    typeof UsersSchema.UsersGitHubAuthorizeCancelParamsSchema
  >;
  "users.github.disconnect": Static<typeof UsersSchema.UsersGitHubDisconnectParamsSchema>;
  "users.mentionable": HumanMentionsSchema.UsersMentionableParams;
  "ui.command": UiCommandParams;
  "themes.list": ThemesListParams;
  "themes.get": ThemesGetParams;
  "themes.set": ThemesSetParams;
  "themes.import": ThemesImportParams;
};
