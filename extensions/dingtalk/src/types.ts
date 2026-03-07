// DingTalk type definitions

import type { DingtalkConfig } from "./config.js";

export type { DingtalkConfig };

/**
 * Account-specific config (extends base config with account metadata)
 */
export interface DingtalkAccountConfig extends DingtalkConfig {
  /** Account display name */
  name?: string;
}

/**
 * Rich text message element
 * Used for various element types in richText messages
 */
export interface RichTextElement {
  /** Element type: text = text, picture = image, at = @mention */
  type: "text" | "picture" | "at";
  /** Text content (when type = "text") */
  text?: string;
  /** Download code (when type = "picture") */
  downloadCode?: string;
  /** Alternative picture download code field (when type = "picture") */
  pictureDownloadCode?: string;
  /** Mentioned user ID (when type = "at") */
  userId?: string;
}

/**
 * Media message content structure
 * Used for picture, video, audio, file, richText, unknownMsgType message types
 *
 * Content field descriptions for each message type:
 * - picture: downloadCode, pictureDownloadCode
 * - video: downloadCode, duration, videoType
 * - audio: downloadCode, recognition
 * - file: downloadCode, fileName, fileId, spaceId
 * - richText: richText[]
 * - unknownMsgType: unknownMsgType (hint text)
 *
 * @see https://open.dingtalk.com/document/development/receive-message
 */
export interface DingtalkMediaContent {
  /** Download code */
  downloadCode?: string;
  /** Picture download code (alternative field for picture messages) */
  pictureDownloadCode?: string;
  /** Video download code (alternative field for video messages) */
  videoDownloadCode?: string;
  /** Video format (video messages, e.g. "mp4") */
  videoType?: string;
  /** Audio/video duration (seconds) */
  duration?: number | string;
  /** Speech recognition text (audio messages) */
  recognition?: string;
  /** File name (file messages) */
  fileName?: string;
  /** File size (file messages, bytes) */
  fileSize?: number;
  /** File ID (file messages) */
  fileId?: string;
  /** Space ID (file messages) */
  spaceId?: string;
  /** Rich text content (richText messages) */
  richText?: RichTextElement[] | string;
  /** Unsupported message type hint (unknownMsgType messages) */
  unknownMsgType?: string;
}

/**
 * DingTalk raw message structure
 * Original message format received from Stream SDK callbacks
 */
export interface DingtalkRawMessage {
  /** Sender ID */
  senderId: string;
  /** Stream message ID (passed through from headers.messageId) */
  streamMessageId?: string;
  /** Sender staffId (provided by some events) */
  senderStaffId?: string;
  /** Sender userId (provided by some events) */
  senderUserId?: string;
  /** Sender userid (provided by some events) */
  senderUserid?: string;
  /** Sender nickname */
  senderNick: string;
  /** Conversation type: "1" = direct, "2" = group */
  conversationType: "1" | "2";
  /** Conversation ID */
  conversationId: string;
  /** Message type: text, picture, video, audio, file, richText, unknownMsgType */
  msgtype: string;
  /** Text message content */
  text?: { content: string };
  /**
   * Media message content
   * NOTE: This field may be an object or JSON string, needs parsing
   */
  content?: string | DingtalkMediaContent;
  /** @mentioned users list */
  atUsers?: Array<{ dingtalkId: string }>;
  /** Bot Code (clientId) */
  robotCode?: string;
}

/**
 * Parsed message context
 * Standardized message format for internal processing
 */
export interface DingtalkMessageContext {
  /** Conversation ID */
  conversationId: string;
  /** Message ID */
  messageId: string;
  /** Sender ID */
  senderId: string;
  /** Sender nickname */
  senderNick?: string;
  /** Chat type: direct = direct, group = group */
  chatType: "direct" | "group";
  /** Message content */
  content: string;
  /** Content type */
  contentType: string;
  /** Whether bot was @mentioned */
  mentionedBot: boolean;
  /** Bot Code */
  robotCode?: string;
}

/**
 * Send message result
 */
export interface DingtalkSendResult {
  /** Message ID */
  messageId: string;
  /** Conversation ID */
  conversationId: string;
}

/**
 * Resolved DingTalk account configuration
 * Used for ChannelPlugin config adapter
 */
export interface ResolvedDingtalkAccount {
  /** Account ID */
  accountId: string;
  /** Account display name */
  name?: string;
  /** Whether enabled */
  enabled: boolean;
  /** Whether configured (has credentials) */
  configured: boolean;
  /** Client ID */
  clientId?: string;
  /** Client Secret */
  clientSecret?: string;
  /** Merged config */
  config?: DingtalkConfig;
}

// ============================================================================
// Group Management Type Definitions
// ============================================================================

/**
 * Create scene group request parameters
 *
 * API: POST /v1.0/im/sceneGroups
 * Docs: https://open.dingtalk.com/document/orgapp/create-scene-group-session
 */
export interface CreateGroupParams {
  /** Group template ID (obtained from DingTalk Open Platform) */
  templateId: string;
  /** Group owner userId */
  ownerUserId: string;
  /** Group name */
  title: string;
  /** Group member userId list (excluding owner) */
  userIds?: string[];
  /** Group avatar mediaId */
  icon?: string;
  /** Sub-admin userId list */
  subAdminIds?: string[];
  /** Unique identifier for idempotent creation */
  uuid?: string;
  /** @all when creating group */
  mentionAllAuthority?: boolean;
  /** Group management type: 0=everyone can manage, 1=only owner can manage */
  managementType?: 0 | 1;
  /** Whether group is searchable: 0=not searchable, 1=searchable */
  searchable?: 0 | 1;
  /** Join verification: 0=no verification, 1=verification required */
  validationType?: 0 | 1;
  /** @all permission: 0=everyone, 1=only owner */
  atAllPermission?: 0 | 1;
  /** Can new members view history: 0=cannot view, 1=can view */
  showHistoryType?: 0 | 1;
}

/**
 * Create group response
 */
export interface CreateGroupResult {
  /** Group conversation openConversationId */
  openConversationId: string;
  /** Group chatId */
  chatId: string;
}

/**
 * Update group request parameters
 *
 * API: PUT /v1.0/im/sceneGroups
 * Docs: https://open.dingtalk.com/document/orgapp/modify-a-group-session
 */
export interface UpdateGroupParams {
  /** Group conversation openConversationId */
  openConversationId: string;
  /** Group name */
  title?: string;
  /** Group owner userId (transfer ownership) */
  ownerUserId?: string;
  /** Group avatar mediaId */
  icon?: string;
  /** @all permission: 0=everyone, 1=only owner */
  mentionAllAuthority?: 0 | 1;
  /** Group management type: 0=everyone can manage, 1=only owner can manage */
  managementType?: 0 | 1;
  /** Whether group is searchable: 0=not searchable, 1=searchable */
  searchable?: 0 | 1;
  /** Join verification: 0=no verification, 1=verification required */
  validationType?: 0 | 1;
  /** @all permission: 0=everyone, 1=only owner */
  atAllPermission?: 0 | 1;
  /** Can new members view history: 0=cannot view, 1=can view */
  showHistoryType?: 0 | 1;
}

/**
 * Add group members request parameters
 *
 * API: POST /v1.0/im/sceneGroups/members
 */
export interface AddGroupMembersParams {
  /** Group conversation openConversationId */
  openConversationId: string;
  /** UserId list of members to add */
  userIds: string[];
}

/**
 * Remove group members request parameters
 *
 * API: DELETE /v1.0/im/sceneGroups/members
 */
export interface RemoveGroupMembersParams {
  /** Group conversation openConversationId */
  openConversationId: string;
  /** UserId list of members to remove */
  userIds: string[];
}

// ============================================================================
// Async Task Queue Type Definitions
// ============================================================================

/**
 * Async task mode configuration
 */
export interface AsyncTaskModeConfig {
  /** Whether to enable smart async mode */
  enabled: boolean;
  /** Slow task threshold (ms), tasks exceeding this time will be considered slow tasks */
  slowTaskThresholdMs: number;
  /** Maximum concurrency */
  maxConcurrency: number;
  /** Auto async execution keyword list */
  autoAsyncKeywords: string[];
  /** Status query keyword list */
  statusQueryKeywords: string[];
  /** Cancel task keyword list */
  cancelTaskKeywords: string[];
}

/**
 * Task classification result (three-level classification + control commands)
 *
 * - instant: Simple Q&A/chat, direct sync reply
 * - normal: Normal tasks, use AI Card streaming reply
 * - heavy: Complex tasks, create JarvisCard async execution
 * - status_query: Query task status
 * - cancel_task: Cancel/terminate task
 */
export type TaskClassification = "instant" | "normal" | "heavy" | "status_query" | "cancel_task";

/**
 * Task queue configuration
 */
export interface TaskQueueConfig {
  /** Maximum concurrency */
  maxConcurrency: number;
  /** Task timeout (milliseconds) */
  taskTimeoutMs: number;
}

/**
 * Task status
 */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Async task definition
 */
export interface AsyncTask {
  /** Task unique ID */
  id: string;
  /** Task type */
  type: string;
  /** Task description */
  description: string;
  /** User ID */
  userId: string;
  /** Conversation ID */
  conversationId: string;
  /** Task creation time */
  createdAt: Date;
  /** Task start time */
  startedAt?: Date;
  /** Task completion time */
  completedAt?: Date;
  /** Task status */
  status: TaskStatus;
  /** Execute function */
  execute: () => Promise<void>;
  /** Abort controller */
  abortController: AbortController;
  /** Error message */
  error?: string;
  /** Result data */
  result?: unknown;
}

/**
 * Task statistics
 */
export interface TaskStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

/**
 * Task notifier configuration
 */
export interface TaskNotifierConfig {
  /** Whether to enable notifications */
  enabled: boolean;
  /** Whether to @ user on task completion */
  mentionOnComplete: boolean;
  /** Whether to @ user on task failure */
  mentionOnError: boolean;
}

/**
 * Query group members request parameters
 *
 * API: GET /v1.0/im/sceneGroups/members
 */
export interface ListGroupMembersParams {
  /** Group conversation openConversationId */
  openConversationId: string;
  /** Pagination cursor, empty string for first request */
  cursor?: string;
  /** Page size, max 1000 */
  size?: number;
}

/**
 * Group member info
 */
export interface GroupMember {
  /** Member userId */
  userId: string;
  /** Member role: 1=owner, 2=admin, 3=normal member */
  role?: number;
}

/**
 * Query group members response
 */
export interface ListGroupMembersResult {
  /** Member list */
  memberUserIds: string[];
  /** Whether there is more data */
  hasMore: boolean;
  /** Next page cursor */
  nextCursor?: string;
}

/**
 * Query group info request parameters
 *
 * API: GET /v1.0/im/sceneGroups
 */
export interface GetGroupInfoParams {
  /** Group conversation openConversationId */
  openConversationId: string;
}

/**
 * Group info response
 */
export interface GroupInfo {
  /** Group conversation openConversationId */
  openConversationId: string;
  /** Group name */
  title: string;
  /** Group owner userId */
  ownerUserId: string;
  /** Group avatar URL */
  icon?: string;
  /** Group template ID */
  templateId?: string;
  /** Group member count */
  memberCount?: number;
  /** Group status: 0=normal, 1=dissolved */
  status?: number;
}

// ============================================================================
// Cool App Type Definitions
// ============================================================================

/**
 * Create and open top box card request parameters
 *
 * API: POST /v2.0/im/topBoxes
 * Docs: https://open.dingtalk.com/document/orgapp/create-and-open-card-top
 */
export interface CreateTopBoxParams {
  /** Interactive card template ID */
  cardTemplateId: string;
  /** User-defined card identifier ID (unique) */
  outTrackId: string;
  /** Cool app code, e.g. COOLAPP-1-xxxx */
  coolAppCode: string;
  /** Group conversation openConversationId */
  openConversationId: string;
  /** Conversation type: 1=direct/group chat */
  conversationType?: number;
  /** Card public data */
  cardData?: {
    cardParamMap: Record<string, string>;
  };
  /** Set private data by unionId */
  unionIdPrivateDataMap?: Record<string, { cardParamMap: Record<string, string> }>;
  /** Set private data by userId */
  userIdPrivateDataMap?: Record<string, { cardParamMap: Record<string, string> }>;
  /** Card settings */
  cardSettings?: {
    pullStrategy?: boolean;
  };
  /** Callback route key */
  callbackRouteKey?: string;
  /** Display platforms, e.g. "ios|mac|android|win" */
  platforms?: string;
}

/**
 * Close top box card request parameters
 *
 * API: DELETE /v2.0/im/topBoxes
 */
export interface CloseTopBoxParams {
  /** Group conversation openConversationId */
  openConversationId: string;
  /** Cool app code */
  coolAppCode: string;
  /** User-defined card identifier ID */
  outTrackId: string;
  /** Conversation type: 1=direct/group chat */
  conversationType?: number;
}

/**
 * Cool app install event data
 *
 * Event name: im_cool_app_install
 */
export interface CoolAppInstallEvent {
  /** Event type */
  EventType: "im_cool_app_install";
  /** Event timestamp */
  EventTime: number;
  /** Enterprise corpId */
  CorpId: string;
  /** Cool app code */
  coolAppCode: string;
  /** Group conversation enterprise corpId */
  openConversationCorpId: string;
  /** Bot code */
  robotCode: string;
  /** Group encrypted conversation ID */
  openConversationId: string;
  /** Operator userId */
  operator: string;
  /** Operation time */
  operateTime: string;
}

// ============================================================================
// Todo Task Type Definitions
// ============================================================================

/**
 * Create todo task request parameters
 *
 * API: POST /v1.0/todo/users/{unionId}/tasks
 * Docs: https://open.dingtalk.com/document/development/add-dingtalk-to-do-task
 */
export interface CreateTodoParams {
  /** Todo title */
  subject: string;
  /** Todo description */
  description?: string;
  /** Due time (Unix timestamp in milliseconds) */
  dueTime?: number;
  /** Executor unionId list */
  executorIds?: string[];
  /** Participant unionId list */
  participantIds?: string[];
  /** Priority: 10=urgent, 20=high, 30=medium, 40=low */
  priority?: 10 | 20 | 30 | 40;
  /** Whether to show only executor */
  isOnlyShowExecutor?: boolean;
  /** URL to jump to when clicking todo */
  detailUrl?: string;
  /** Notification config */
  notifyConfigs?: Record<string, unknown>;
}

/**
 * Todo task info
 */
export interface TodoTask {
  /** Todo task ID */
  id?: string;
  /** Todo title */
  subject?: string;
  /** Todo description */
  description?: string;
  /** Due time (Unix timestamp in milliseconds) */
  dueTime?: number;
  /** Whether completed */
  done?: boolean;
  /** Priority */
  priority?: number;
  /** Creator unionId */
  creatorId?: string;
  /** Creation time (Unix timestamp in milliseconds) */
  createdTime?: number;
  /** Modification time (Unix timestamp in milliseconds) */
  modifiedTime?: number;
  /** Executor unionId list */
  executorIds?: string[];
  /** Participant unionId list */
  participantIds?: string[];
  /** Source ID */
  sourceId?: string;
}

/**
 * Update todo task request parameters
 */
export interface UpdateTodoParams {
  /** Todo title */
  subject?: string;
  /** Todo description */
  description?: string;
  /** Due time (Unix timestamp in milliseconds) */
  dueTime?: number;
  /** Whether completed */
  done?: boolean;
  /** Executor unionId list */
  executorIds?: string[];
  /** Participant unionId list */
  participantIds?: string[];
  /** Priority */
  priority?: 10 | 20 | 30 | 40;
}

/**
 * Query todo task list request parameters
 */
export interface ListTodoParams {
  /** Pagination token */
  nextToken?: string;
  /** Whether completed */
  isDone?: boolean;
  /** Sort field */
  orderBy?: string;
  /** Sort direction: asc=ascending, desc=descending */
  orderDirection?: "asc" | "desc";
}

/**
 * Todo task list card (simplified format returned by list query)
 */
export interface TodoCard {
  /** Todo task ID */
  taskId?: string;
  /** Todo title */
  subject?: string;
  /** Due time */
  dueTime?: number;
  /** Whether completed */
  isDone?: boolean;
  /** Creation time */
  createdTime?: number;
  /** Priority */
  priority?: number;
}

/**
 * Query todo task list response
 */
export interface ListTodoResult {
  /** Todo task card list */
  todoCards?: TodoCard[];
  /** Next page token */
  nextToken?: string;
  /** Total count */
  totalCount?: number;
}

// ============================================================================
// Calendar Type Definitions
// ============================================================================

/**
 * Calendar datetime
 */
export interface CalendarDateTime {
  /** ISO 8601 formatted datetime, e.g. "2024-01-15T14:00:00+08:00" */
  dateTime?: string;
  /** All-day event date, e.g. "2024-01-15" */
  date?: string;
  /** Timezone, e.g. "Asia/Shanghai" */
  timeZone?: string;
}

/**
 * Calendar attendee
 */
export interface CalendarAttendee {
  /** User unionId */
  id?: string;
  /** Display name */
  displayName?: string;
  /** Whether attendance is optional */
  isOptional?: boolean;
  /** Response type: required=required, optional=optional */
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
}

/**
 * Calendar reminder
 */
export interface CalendarReminder {
  /** Reminder method: dingtalk, email */
  method?: string;
  /** Minutes in advance to remind */
  minutes: number;
}

/**
 * Calendar location
 */
export interface CalendarLocation {
  /** Location name */
  displayName?: string;
}

/**
 * Create calendar event request parameters
 *
 * API: POST /v1.0/calendar/users/{unionId}/events
 * Docs: https://open.dingtalk.com/document/orgapp/create-calendar-event
 */
export interface CreateCalendarEventParams {
  /** Event summary */
  summary: string;
  /** Event description */
  description?: string;
  /** Start time */
  start: CalendarDateTime;
  /** End time */
  end: CalendarDateTime;
  /** Event location */
  location?: string;
  /** Attendee list */
  attendees?: CalendarAttendee[];
  /** Reminder settings */
  reminders?: CalendarReminder[];
  /** Whether all-day event */
  isAllDay?: boolean;
  /** Calendar ID (defaults to "primary") */
  calendarId?: string;
  /** Recurrence rule */
  recurrence?: Record<string, unknown>;
  /** Extra fields to pass through to the API */
  extra?: Record<string, unknown>;
}

/**
 * Calendar event info
 */
export interface CalendarEvent {
  /** Event ID */
  id?: string;
  /** Event summary */
  summary?: string;
  /** Event description */
  description?: string;
  /** Start time */
  start?: CalendarDateTime;
  /** End time */
  end?: CalendarDateTime;
  /** Whether all-day event */
  isAllDay?: boolean;
  /** Location */
  location?: CalendarLocation;
  /** Attendee list */
  attendees?: CalendarAttendee[];
  /** Organizer */
  organizer?: { id?: string; displayName?: string };
  /** Event status */
  status?: string;
  /** Creation time */
  createTime?: string;
  /** Update time */
  updateTime?: string;
}

/**
 * Update calendar event request parameters
 */
export interface UpdateCalendarEventParams {
  /** Event summary */
  summary?: string;
  /** Event description */
  description?: string;
  /** Start time */
  start?: CalendarDateTime;
  /** End time */
  end?: CalendarDateTime;
  /** Event location */
  location?: string;
  /** Attendee list */
  attendees?: CalendarAttendee[];
  /** Whether all-day event */
  isAllDay?: boolean;
  /** Reminder settings */
  reminders?: CalendarReminder[];
}

/**
 * Query calendar events list request parameters
 */
export interface ListCalendarEventsParams {
  /** Start time (Unix timestamp in milliseconds) */
  startTime?: number;
  /** End time (Unix timestamp in milliseconds) */
  endTime?: number;
  /** Pagination cursor */
  nextToken?: string;
  /** Page size */
  maxResults?: number;
  /** Calendar ID (defaults to "primary") */
  calendarId?: string;
  /** Minimum time filter (ISO 8601 string) */
  timeMin?: string;
  /** Maximum time filter (ISO 8601 string) */
  timeMax?: string;
  /** Whether to include deleted events */
  showDeleted?: boolean;
}

/**
 * Query calendar events list response
 */
export interface ListCalendarEventsResult {
  /** Event list */
  events?: CalendarEvent[];
  /** Next page token */
  nextToken?: string;
}

// ============================================================================
// Document/Knowledge Base Type Definitions
// ============================================================================

/**
 * Knowledge base info
 */
export interface DocSpace {
  /** Knowledge base ID */
  id?: string;
  /** Knowledge base name */
  name?: string;
  /** Knowledge base description */
  description?: string;
  /** Knowledge base type */
  type?: string;
  /** Creator unionId */
  creatorId?: string;
  /** Creation time */
  createdTime?: number;
  /** Update time */
  updatedTime?: number;
}

/**
 * Query knowledge base list response
 */
export interface ListDocSpacesResult {
  /** Knowledge base list */
  items?: DocSpace[];
  /** Next page token */
  nextToken?: string;
}

/**
 * Create document request parameters
 *
 * API: POST /v1.0/doc/teams/{spaceId}/nodes
 * Docs: https://open.dingtalk.com/document/development/create-team-space-document
 */
export interface CreateDocumentParams {
  /** Document name */
  name: string;
  /** Document type: alidoc=document, sheet=spreadsheet, folder=folder, mindmap=mindmap */
  docType?: "alidoc" | "sheet" | "folder" | "mindmap";
  /** Parent node ID (create in specified directory) */
  parentNodeId?: string;
}

/**
 * Document node info
 */
export interface DocNode {
  /** Node ID */
  nodeId?: string;
  /** Node name */
  name?: string;
  /** Document type */
  docType?: string;
  /** Document URL */
  url?: string;
  /** Creator unionId */
  creatorId?: string;
  /** Creation time (Unix timestamp in milliseconds) */
  createdTime?: number;
  /** Update time (Unix timestamp in milliseconds) */
  updatedTime?: number;
  /** Whether has children */
  hasChildren?: boolean;
}

/**
 * Query knowledge base node list request parameters
 */
export interface ListDocNodesParams {
  /** Parent node ID */
  parentNodeId?: string;
  /** Pagination token */
  nextToken?: string;
  /** Page size */
  maxResults?: number;
}

/**
 * Query knowledge base node list response
 */
export interface ListDocNodesResult {
  /** Node list */
  items?: DocNode[];
  /** Next page token */
  nextToken?: string;
}
