// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as SessionsAPI from './sessions';
import { SessionCreateParams, Sessions } from './sessions';
import * as ThreadsAPI from './threads';
import {
  ChatKitAttachment,
  ChatKitResponseOutputText,
  ChatKitThread,
  ChatKitThreadAssistantMessageItem,
  ChatKitThreadItemList,
  ChatKitThreadItemListDataPage,
  ChatKitThreadUserMessageItem,
  ChatKitThreadsPage,
  ChatKitWidgetItem,
  ChatSession,
  ChatSessionAutomaticThreadTitling,
  ChatSessionChatKitConfiguration,
  ChatSessionChatKitConfigurationParam,
  ChatSessionExpiresAfterParam,
  ChatSessionFileUpload,
  ChatSessionHistory,
  ChatSessionRateLimits,
  ChatSessionRateLimitsParam,
  ChatSessionStatus,
  ChatSessionWorkflowParam,
  ThreadDeleteResponse,
  ThreadListItemsParams,
  ThreadListParams,
  Threads,
} from './threads';

export class ChatKit extends APIResource {
  sessions: SessionsAPI.Sessions = new SessionsAPI.Sessions(this._client);
  threads: ThreadsAPI.Threads = new ThreadsAPI.Threads(this._client);
}

/**
 * Workflow metadata and state returned for the session.
 */
export interface ChatKitWorkflow {
  /**
   * Identifier of the workflow backing the session.
   */
  id: string;

  /**
   * State variable key-value pairs applied when invoking the workflow. Defaults to
   * null when no overrides were provided.
   */
  state_variables: { [key: string]: string | boolean | number } | null;

  /**
   * Tracing settings applied to the workflow.
   */
  tracing: ChatKitWorkflow.Tracing;

  /**
   * Specific workflow version used for the session. Defaults to null when using the
   * latest deployment.
   */
  version: string | null;
}

export namespace ChatKitWorkflow {
  /**
   * Tracing settings applied to the workflow.
   */
  export interface Tracing {
    /**
     * Indicates whether tracing is enabled.
     */
    enabled: boolean;
  }
}

ChatKit.Sessions = Sessions;
ChatKit.Threads = Threads;

export declare namespace ChatKit {
  export { type ChatKitWorkflow as ChatKitWorkflow };

  export { Sessions as Sessions, type SessionCreateParams as SessionCreateParams };

  export {
    Threads as Threads,
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
