// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as ChatKitAPI from './chatkit';
import { APIPromise } from '../../../core/api-promise';
import {
  ConversationCursorPage,
  type ConversationCursorPageParams,
  PagePromise,
} from '../../../core/pagination';
import { buildHeaders } from '../../../internal/headers';
import { RequestOptions } from '../../../internal/request-options';
import { path } from '../../../internal/utils/path';

export class Threads extends APIResource {
  /**
   * Retrieve a ChatKit thread by its identifier.
   *
   * @example
   * ```ts
   * const chatkitThread =
   *   await client.beta.chatkit.threads.retrieve('cthr_123');
   * ```
   */
  retrieve(threadID: string, options?: RequestOptions): APIPromise<ChatKitThread> {
    return this._client.get(path`/chatkit/threads/${threadID}`, {
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
    });
  }

  /**
   * List ChatKit threads with optional pagination and user filters.
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const chatkitThread of client.beta.chatkit.threads.list()) {
   *   // ...
   * }
   * ```
   */
  list(
    query: ThreadListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<ChatKitThreadsPage, ChatKitThread> {
    return this._client.getAPIList('/chatkit/threads', ConversationCursorPage<ChatKitThread>, {
      query,
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
    });
  }

  /**
   * Delete a ChatKit thread along with its items and stored attachments.
   *
   * @example
   * ```ts
   * const thread = await client.beta.chatkit.threads.delete(
   *   'cthr_123',
   * );
   * ```
   */
  delete(threadID: string, options?: RequestOptions): APIPromise<ThreadDeleteResponse> {
    return this._client.delete(path`/chatkit/threads/${threadID}`, {
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
    });
  }

  /**
   * List items that belong to a ChatKit thread.
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const thread of client.beta.chatkit.threads.listItems(
   *   'cthr_123',
   * )) {
   *   // ...
   * }
   * ```
   */
  listItems(
    threadID: string,
    query: ThreadListItemsParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<
    ChatKitThreadItemListDataPage,
    | ChatKitThreadUserMessageItem
    | ChatKitThreadAssistantMessageItem
    | ChatKitWidgetItem
    | ChatKitThreadItemList.ChatKitClientToolCall
    | ChatKitThreadItemList.ChatKitTask
    | ChatKitThreadItemList.ChatKitTaskGroup
  > {
    return this._client.getAPIList(
      path`/chatkit/threads/${threadID}/items`,
      ConversationCursorPage<
        | ChatKitThreadUserMessageItem
        | ChatKitThreadAssistantMessageItem
        | ChatKitWidgetItem
        | ChatKitThreadItemList.ChatKitClientToolCall
        | ChatKitThreadItemList.ChatKitTask
        | ChatKitThreadItemList.ChatKitTaskGroup
      >,
      { query, ...options, headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]) },
    );
  }
}

export type ChatKitThreadsPage = ConversationCursorPage<ChatKitThread>;

export type ChatKitThreadItemListDataPage = ConversationCursorPage<
  | ChatKitThreadUserMessageItem
  | ChatKitThreadAssistantMessageItem
  | ChatKitWidgetItem
  | ChatKitThreadItemList.ChatKitClientToolCall
  | ChatKitThreadItemList.ChatKitTask
  | ChatKitThreadItemList.ChatKitTaskGroup
>;

/**
 * Represents a ChatKit session and its resolved configuration.
 */
export interface ChatSession {
  /**
   * Identifier for the ChatKit session.
   */
  id: string;

  /**
   * Resolved ChatKit feature configuration for the session.
   */
  chatkit_configuration: ChatSessionChatKitConfiguration;

  /**
   * Ephemeral client secret that authenticates session requests.
   */
  client_secret: string;

  /**
   * Unix timestamp (in seconds) for when the session expires.
   */
  expires_at: number;

  /**
   * Convenience copy of the per-minute request limit.
   */
  max_requests_per_1_minute: number;

  /**
   * Type discriminator that is always `chatkit.session`.
   */
  object: 'chatkit.session';

  /**
   * Resolved rate limit values.
   */
  rate_limits: ChatSessionRateLimits;

  /**
   * Current lifecycle state of the session.
   */
  status: ChatSessionStatus;

  /**
   * User identifier associated with the session.
   */
  user: string;

  /**
   * Workflow metadata for the session.
   */
  workflow: ChatKitAPI.ChatKitWorkflow;
}

/**
 * Automatic thread title preferences for the session.
 */
export interface ChatSessionAutomaticThreadTitling {
  /**
   * Whether automatic thread titling is enabled.
   */
  enabled: boolean;
}

/**
 * ChatKit configuration for the session.
 */
export interface ChatSessionChatKitConfiguration {
  /**
   * Automatic thread titling preferences.
   */
  automatic_thread_titling: ChatSessionAutomaticThreadTitling;

  /**
   * Upload settings for the session.
   */
  file_upload: ChatSessionFileUpload;

  /**
   * History retention configuration.
   */
  history: ChatSessionHistory;
}

/**
 * Optional per-session configuration settings for ChatKit behavior.
 */
export interface ChatSessionChatKitConfigurationParam {
  /**
   * Configuration for automatic thread titling. When omitted, automatic thread
   * titling is enabled by default.
   */
  automatic_thread_titling?: ChatSessionChatKitConfigurationParam.AutomaticThreadTitling;

  /**
   * Configuration for upload enablement and limits. When omitted, uploads are
   * disabled by default (max_files 10, max_file_size 512 MB).
   */
  file_upload?: ChatSessionChatKitConfigurationParam.FileUpload;

  /**
   * Configuration for chat history retention. When omitted, history is enabled by
   * default with no limit on recent_threads (null).
   */
  history?: ChatSessionChatKitConfigurationParam.History;
}

export namespace ChatSessionChatKitConfigurationParam {
  /**
   * Configuration for automatic thread titling. When omitted, automatic thread
   * titling is enabled by default.
   */
  export interface AutomaticThreadTitling {
    /**
     * Enable automatic thread title generation. Defaults to true.
     */
    enabled?: boolean;
  }

  /**
   * Configuration for upload enablement and limits. When omitted, uploads are
   * disabled by default (max_files 10, max_file_size 512 MB).
   */
  export interface FileUpload {
    /**
     * Enable uploads for this session. Defaults to false.
     */
    enabled?: boolean;

    /**
     * Maximum size in megabytes for each uploaded file. Defaults to 512 MB, which is
     * the maximum allowable size.
     */
    max_file_size?: number;

    /**
     * Maximum number of files that can be uploaded to the session. Defaults to 10.
     */
    max_files?: number;
  }

  /**
   * Configuration for chat history retention. When omitted, history is enabled by
   * default with no limit on recent_threads (null).
   */
  export interface History {
    /**
     * Enables chat users to access previous ChatKit threads. Defaults to true.
     */
    enabled?: boolean;

    /**
     * Number of recent ChatKit threads users have access to. Defaults to unlimited
     * when unset.
     */
    recent_threads?: number;
  }
}

/**
 * Controls when the session expires relative to an anchor timestamp.
 */
export interface ChatSessionExpiresAfterParam {
  /**
   * Base timestamp used to calculate expiration. Currently fixed to `created_at`.
   */
  anchor: 'created_at';

  /**
   * Number of seconds after the anchor when the session expires.
   */
  seconds: number;
}

/**
 * Upload permissions and limits applied to the session.
 */
export interface ChatSessionFileUpload {
  /**
   * Indicates if uploads are enabled for the session.
   */
  enabled: boolean;

  /**
   * Maximum upload size in megabytes.
   */
  max_file_size: number | null;

  /**
   * Maximum number of uploads allowed during the session.
   */
  max_files: number | null;
}

/**
 * History retention preferences returned for the session.
 */
export interface ChatSessionHistory {
  /**
   * Indicates if chat history is persisted for the session.
   */
  enabled: boolean;

  /**
   * Number of prior threads surfaced in history views. Defaults to null when all
   * history is retained.
   */
  recent_threads: number | null;
}

/**
 * Active per-minute request limit for the session.
 */
export interface ChatSessionRateLimits {
  /**
   * Maximum allowed requests per one-minute window.
   */
  max_requests_per_1_minute: number;
}

/**
 * Controls request rate limits for the session.
 */
export interface ChatSessionRateLimitsParam {
  /**
   * Maximum number of requests allowed per minute for the session. Defaults to 10.
   */
  max_requests_per_1_minute?: number;
}

export type ChatSessionStatus = 'active' | 'expired' | 'cancelled';

/**
 * Workflow reference and overrides applied to the chat session.
 */
export interface ChatSessionWorkflowParam {
  /**
   * Identifier for the workflow invoked by the session.
   */
  id: string;

  /**
   * State variables forwarded to the workflow. Keys may be up to 64 characters,
   * values must be primitive types, and the map defaults to an empty object.
   */
  state_variables?: { [key: string]: string | boolean | number };

  /**
   * Optional tracing overrides for the workflow invocation. When omitted, tracing is
   * enabled by default.
   */
  tracing?: ChatSessionWorkflowParam.Tracing;

  /**
   * Specific workflow version to run. Defaults to the latest deployed version.
   */
  version?: string;
}

export namespace ChatSessionWorkflowParam {
  /**
   * Optional tracing overrides for the workflow invocation. When omitted, tracing is
   * enabled by default.
   */
  export interface Tracing {
    /**
     * Whether tracing is enabled during the session. Defaults to true.
     */
    enabled?: boolean;
  }
}

/**
 * Attachment metadata included on thread items.
 */
export interface ChatKitAttachment {
  /**
   * Identifier for the attachment.
   */
  id: string;

  /**
   * MIME type of the attachment.
   */
  mime_type: string;

  /**
   * Original display name for the attachment.
   */
  name: string;

  /**
   * Preview URL for rendering the attachment inline.
   */
  preview_url: string | null;

  /**
   * Attachment discriminator.
   */
  type: 'image' | 'file';
}

/**
 * Assistant response text accompanied by optional annotations.
 */
export interface ChatKitResponseOutputText {
  /**
   * Ordered list of annotations attached to the response text.
   */
  annotations: Array<ChatKitResponseOutputText.File | ChatKitResponseOutputText.URL>;

  /**
   * Assistant generated text.
   */
  text: string;

  /**
   * Type discriminator that is always `output_text`.
   */
  type: 'output_text';
}

export namespace ChatKitResponseOutputText {
  /**
   * Annotation that references an uploaded file.
   */
  export interface File {
    /**
     * File attachment referenced by the annotation.
     */
    source: File.Source;

    /**
     * Type discriminator that is always `file` for this annotation.
     */
    type: 'file';
  }

  export namespace File {
    /**
     * File attachment referenced by the annotation.
     */
    export interface Source {
      /**
       * Filename referenced by the annotation.
       */
      filename: string;

      /**
       * Type discriminator that is always `file`.
       */
      type: 'file';
    }
  }

  /**
   * Annotation that references a URL.
   */
  export interface URL {
    /**
     * URL referenced by the annotation.
     */
    source: URL.Source;

    /**
     * Type discriminator that is always `url` for this annotation.
     */
    type: 'url';
  }

  export namespace URL {
    /**
     * URL referenced by the annotation.
     */
    export interface Source {
      /**
       * Type discriminator that is always `url`.
       */
      type: 'url';

      /**
       * URL referenced by the annotation.
       */
      url: string;
    }
  }
}

/**
 * Represents a ChatKit thread and its current status.
 */
export interface ChatKitThread {
  /**
   * Identifier of the thread.
   */
  id: string;

  /**
   * Unix timestamp (in seconds) for when the thread was created.
   */
  created_at: number;

  /**
   * Type discriminator that is always `chatkit.thread`.
   */
  object: 'chatkit.thread';

  /**
   * Current status for the thread. Defaults to `active` for newly created threads.
   */
  status: ChatKitThread.Active | ChatKitThread.Locked | ChatKitThread.Closed;

  /**
   * Optional human-readable title for the thread. Defaults to null when no title has
   * been generated.
   */
  title: string | null;

  /**
   * Free-form string that identifies your end user who owns the thread.
   */
  user: string;
}

export namespace ChatKitThread {
  /**
   * Indicates that a thread is active.
   */
  export interface Active {
    /**
     * Status discriminator that is always `active`.
     */
    type: 'active';
  }

  /**
   * Indicates that a thread is locked and cannot accept new input.
   */
  export interface Locked {
    /**
     * Reason that the thread was locked. Defaults to null when no reason is recorded.
     */
    reason: string | null;

    /**
     * Status discriminator that is always `locked`.
     */
    type: 'locked';
  }

  /**
   * Indicates that a thread has been closed.
   */
  export interface Closed {
    /**
     * Reason that the thread was closed. Defaults to null when no reason is recorded.
     */
    reason: string | null;

    /**
     * Status discriminator that is always `closed`.
     */
    type: 'closed';
  }
}

/**
 * Assistant-authored message within a thread.
 */
export interface ChatKitThreadAssistantMessageItem {
  /**
   * Identifier of the thread item.
   */
  id: string;

  /**
   * Ordered assistant response segments.
   */
  content: Array<ChatKitResponseOutputText>;

  /**
   * Unix timestamp (in seconds) for when the item was created.
   */
  created_at: number;

  /**
   * Type discriminator that is always `chatkit.thread_item`.
   */
  object: 'chatkit.thread_item';

  /**
   * Identifier of the parent thread.
   */
  thread_id: string;

  /**
   * Type discriminator that is always `chatkit.assistant_message`.
   */
  type: 'chatkit.assistant_message';
}

/**
 * A paginated list of thread items rendered for the ChatKit API.
 */
export interface ChatKitThreadItemList {
  /**
   * A list of items
   */
  data: Array<
    | ChatKitThreadUserMessageItem
    | ChatKitThreadAssistantMessageItem
    | ChatKitWidgetItem
    | ChatKitThreadItemList.ChatKitClientToolCall
    | ChatKitThreadItemList.ChatKitTask
    | ChatKitThreadItemList.ChatKitTaskGroup
  >;

  /**
   * The ID of the first item in the list.
   */
  first_id: string | null;

  /**
   * Whether there are more items available.
   */
  has_more: boolean;

  /**
   * The ID of the last item in the list.
   */
  last_id: string | null;

  /**
   * The type of object returned, must be `list`.
   */
  object: 'list';
}

export namespace ChatKitThreadItemList {
  /**
   * Record of a client side tool invocation initiated by the assistant.
   */
  export interface ChatKitClientToolCall {
    /**
     * Identifier of the thread item.
     */
    id: string;

    /**
     * JSON-encoded arguments that were sent to the tool.
     */
    arguments: string;

    /**
     * Identifier for the client tool call.
     */
    call_id: string;

    /**
     * Unix timestamp (in seconds) for when the item was created.
     */
    created_at: number;

    /**
     * Tool name that was invoked.
     */
    name: string;

    /**
     * Type discriminator that is always `chatkit.thread_item`.
     */
    object: 'chatkit.thread_item';

    /**
     * JSON-encoded output captured from the tool. Defaults to null while execution is
     * in progress.
     */
    output: string | null;

    /**
     * Execution status for the tool call.
     */
    status: 'in_progress' | 'completed';

    /**
     * Identifier of the parent thread.
     */
    thread_id: string;

    /**
     * Type discriminator that is always `chatkit.client_tool_call`.
     */
    type: 'chatkit.client_tool_call';
  }

  /**
   * Task emitted by the workflow to show progress and status updates.
   */
  export interface ChatKitTask {
    /**
     * Identifier of the thread item.
     */
    id: string;

    /**
     * Unix timestamp (in seconds) for when the item was created.
     */
    created_at: number;

    /**
     * Optional heading for the task. Defaults to null when not provided.
     */
    heading: string | null;

    /**
     * Type discriminator that is always `chatkit.thread_item`.
     */
    object: 'chatkit.thread_item';

    /**
     * Optional summary that describes the task. Defaults to null when omitted.
     */
    summary: string | null;

    /**
     * Subtype for the task.
     */
    task_type: 'custom' | 'thought';

    /**
     * Identifier of the parent thread.
     */
    thread_id: string;

    /**
     * Type discriminator that is always `chatkit.task`.
     */
    type: 'chatkit.task';
  }

  /**
   * Collection of workflow tasks grouped together in the thread.
   */
  export interface ChatKitTaskGroup {
    /**
     * Identifier of the thread item.
     */
    id: string;

    /**
     * Unix timestamp (in seconds) for when the item was created.
     */
    created_at: number;

    /**
     * Type discriminator that is always `chatkit.thread_item`.
     */
    object: 'chatkit.thread_item';

    /**
     * Tasks included in the group.
     */
    tasks: Array<ChatKitTaskGroup.Task>;

    /**
     * Identifier of the parent thread.
     */
    thread_id: string;

    /**
     * Type discriminator that is always `chatkit.task_group`.
     */
    type: 'chatkit.task_group';
  }

  export namespace ChatKitTaskGroup {
    /**
     * Task entry that appears within a TaskGroup.
     */
    export interface Task {
      /**
       * Optional heading for the grouped task. Defaults to null when not provided.
       */
      heading: string | null;

      /**
       * Optional summary that describes the grouped task. Defaults to null when omitted.
       */
      summary: string | null;

      /**
       * Subtype for the grouped task.
       */
      type: 'custom' | 'thought';
    }
  }
}

/**
 * User-authored messages within a thread.
 */
export interface ChatKitThreadUserMessageItem {
  /**
   * Identifier of the thread item.
   */
  id: string;

  /**
   * Attachments associated with the user message. Defaults to an empty list.
   */
  attachments: Array<ChatKitAttachment>;

  /**
   * Ordered content elements supplied by the user.
   */
  content: Array<ChatKitThreadUserMessageItem.InputText | ChatKitThreadUserMessageItem.QuotedText>;

  /**
   * Unix timestamp (in seconds) for when the item was created.
   */
  created_at: number;

  /**
   * Inference overrides applied to the message. Defaults to null when unset.
   */
  inference_options: ChatKitThreadUserMessageItem.InferenceOptions | null;

  /**
   * Type discriminator that is always `chatkit.thread_item`.
   */
  object: 'chatkit.thread_item';

  /**
   * Identifier of the parent thread.
   */
  thread_id: string;

  type: 'chatkit.user_message';
}

export namespace ChatKitThreadUserMessageItem {
  /**
   * Text block that a user contributed to the thread.
   */
  export interface InputText {
    /**
     * Plain-text content supplied by the user.
     */
    text: string;

    /**
     * Type discriminator that is always `input_text`.
     */
    type: 'input_text';
  }

  /**
   * Quoted snippet that the user referenced in their message.
   */
  export interface QuotedText {
    /**
     * Quoted text content.
     */
    text: string;

    /**
     * Type discriminator that is always `quoted_text`.
     */
    type: 'quoted_text';
  }

  /**
   * Inference overrides applied to the message. Defaults to null when unset.
   */
  export interface InferenceOptions {
    /**
     * Model name that generated the response. Defaults to null when using the session
     * default.
     */
    model: string | null;

    /**
     * Preferred tool to invoke. Defaults to null when ChatKit should auto-select.
     */
    tool_choice: InferenceOptions.ToolChoice | null;
  }

  export namespace InferenceOptions {
    /**
     * Preferred tool to invoke. Defaults to null when ChatKit should auto-select.
     */
    export interface ToolChoice {
      /**
       * Identifier of the requested tool.
       */
      id: string;
    }
  }
}

/**
 * Thread item that renders a widget payload.
 */
export interface ChatKitWidgetItem {
  /**
   * Identifier of the thread item.
   */
  id: string;

  /**
   * Unix timestamp (in seconds) for when the item was created.
   */
  created_at: number;

  /**
   * Type discriminator that is always `chatkit.thread_item`.
   */
  object: 'chatkit.thread_item';

  /**
   * Identifier of the parent thread.
   */
  thread_id: string;

  /**
   * Type discriminator that is always `chatkit.widget`.
   */
  type: 'chatkit.widget';

  /**
   * Serialized widget payload rendered in the UI.
   */
  widget: string;
}

/**
 * Confirmation payload returned after deleting a thread.
 */
export interface ThreadDeleteResponse {
  /**
   * Identifier of the deleted thread.
   */
  id: string;

  /**
   * Indicates that the thread has been deleted.
   */
  deleted: boolean;

  /**
   * Type discriminator that is always `chatkit.thread.deleted`.
   */
  object: 'chatkit.thread.deleted';
}

export interface ThreadListParams extends ConversationCursorPageParams {
  /**
   * List items created before this thread item ID. Defaults to null for the newest
   * results.
   */
  before?: string;

  /**
   * Sort order for results by creation time. Defaults to `desc`.
   */
  order?: 'asc' | 'desc';

  /**
   * Filter threads that belong to this user identifier. Defaults to null to return
   * all users.
   */
  user?: string;
}

export interface ThreadListItemsParams extends ConversationCursorPageParams {
  /**
   * List items created before this thread item ID. Defaults to null for the newest
   * results.
   */
  before?: string;

  /**
   * Sort order for results by creation time. Defaults to `desc`.
   */
  order?: 'asc' | 'desc';
}

export declare namespace Threads {
  export {
    type ChatSession as ChatSession,
    type ChatSessionAutomaticThreadTitling as ChatSessionAutomaticThreadTitling,
    type ChatSessionChatKitConfiguration as ChatSessionChatKitConfiguration,
    type ChatSessionChatKitConfigurationParam as ChatSessionChatKitConfigurationParam,
    type ChatSessionExpiresAfterParam as ChatSessionExpiresAfterParam,
    type ChatSessionFileUpload as ChatSessionFileUpload,
    type ChatSessionHistory as ChatSessionHistory,
    type ChatSessionRateLimits as ChatSessionRateLimits,
    type ChatSessionRateLimitsParam as ChatSessionRateLimitsParam,
    type ChatSessionStatus as ChatSessionStatus,
    type ChatSessionWorkflowParam as ChatSessionWorkflowParam,
    type ChatKitAttachment as ChatKitAttachment,
    type ChatKitResponseOutputText as ChatKitResponseOutputText,
    type ChatKitThread as ChatKitThread,
    type ChatKitThreadAssistantMessageItem as ChatKitThreadAssistantMessageItem,
    type ChatKitThreadItemList as ChatKitThreadItemList,
    type ChatKitThreadUserMessageItem as ChatKitThreadUserMessageItem,
    type ChatKitWidgetItem as ChatKitWidgetItem,
    type ThreadDeleteResponse as ThreadDeleteResponse,
    type ChatKitThreadsPage as ChatKitThreadsPage,
    type ChatKitThreadItemListDataPage as ChatKitThreadItemListDataPage,
    type ThreadListParams as ThreadListParams,
    type ThreadListItemsParams as ThreadListItemsParams,
  };
}
