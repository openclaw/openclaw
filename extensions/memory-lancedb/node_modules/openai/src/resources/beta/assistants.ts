// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as Shared from '../shared';
import * as MessagesAPI from './threads/messages';
import * as ThreadsAPI from './threads/threads';
import * as RunsAPI from './threads/runs/runs';
import * as StepsAPI from './threads/runs/steps';
import { APIPromise } from '../../core/api-promise';
import { CursorPage, type CursorPageParams, PagePromise } from '../../core/pagination';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';
import { AssistantStream } from '../../lib/AssistantStream';

/**
 * Build Assistants that can call models and use tools.
 */
export class Assistants extends APIResource {
  /**
   * Create an assistant with a model and instructions.
   *
   * @deprecated
   */
  create(body: AssistantCreateParams, options?: RequestOptions): APIPromise<Assistant> {
    return this._client.post('/assistants', {
      body,
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }

  /**
   * Retrieves an assistant.
   *
   * @deprecated
   */
  retrieve(assistantID: string, options?: RequestOptions): APIPromise<Assistant> {
    return this._client.get(path`/assistants/${assistantID}`, {
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }

  /**
   * Modifies an assistant.
   *
   * @deprecated
   */
  update(assistantID: string, body: AssistantUpdateParams, options?: RequestOptions): APIPromise<Assistant> {
    return this._client.post(path`/assistants/${assistantID}`, {
      body,
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }

  /**
   * Returns a list of assistants.
   *
   * @deprecated
   */
  list(
    query: AssistantListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<AssistantsPage, Assistant> {
    return this._client.getAPIList('/assistants', CursorPage<Assistant>, {
      query,
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }

  /**
   * Delete an assistant.
   *
   * @deprecated
   */
  delete(assistantID: string, options?: RequestOptions): APIPromise<AssistantDeleted> {
    return this._client.delete(path`/assistants/${assistantID}`, {
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }
}

export type AssistantsPage = CursorPage<Assistant>;

/**
 * @deprecated Represents an `assistant` that can call the model and use tools.
 */
export interface Assistant {
  /**
   * The identifier, which can be referenced in API endpoints.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the assistant was created.
   */
  created_at: number;

  /**
   * The description of the assistant. The maximum length is 512 characters.
   */
  description: string | null;

  /**
   * The system instructions that the assistant uses. The maximum length is 256,000
   * characters.
   */
  instructions: string | null;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata: Shared.Metadata | null;

  /**
   * ID of the model to use. You can use the
   * [List models](https://platform.openai.com/docs/api-reference/models/list) API to
   * see all of your available models, or see our
   * [Model overview](https://platform.openai.com/docs/models) for descriptions of
   * them.
   */
  model: string;

  /**
   * The name of the assistant. The maximum length is 256 characters.
   */
  name: string | null;

  /**
   * The object type, which is always `assistant`.
   */
  object: 'assistant';

  /**
   * A list of tool enabled on the assistant. There can be a maximum of 128 tools per
   * assistant. Tools can be of types `code_interpreter`, `file_search`, or
   * `function`.
   */
  tools: Array<AssistantTool>;

  /**
   * Specifies the format that the model must output. Compatible with
   * [GPT-4o](https://platform.openai.com/docs/models#gpt-4o),
   * [GPT-4 Turbo](https://platform.openai.com/docs/models#gpt-4-turbo-and-gpt-4),
   * and all GPT-3.5 Turbo models since `gpt-3.5-turbo-1106`.
   *
   * Setting to `{ "type": "json_schema", "json_schema": {...} }` enables Structured
   * Outputs which ensures the model will match your supplied JSON schema. Learn more
   * in the
   * [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs).
   *
   * Setting to `{ "type": "json_object" }` enables JSON mode, which ensures the
   * message the model generates is valid JSON.
   *
   * **Important:** when using JSON mode, you **must** also instruct the model to
   * produce JSON yourself via a system or user message. Without this, the model may
   * generate an unending stream of whitespace until the generation reaches the token
   * limit, resulting in a long-running and seemingly "stuck" request. Also note that
   * the message content may be partially cut off if `finish_reason="length"`, which
   * indicates the generation exceeded `max_tokens` or the conversation exceeded the
   * max context length.
   */
  response_format?: ThreadsAPI.AssistantResponseFormatOption | null;

  /**
   * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will
   * make the output more random, while lower values like 0.2 will make it more
   * focused and deterministic.
   */
  temperature?: number | null;

  /**
   * A set of resources that are used by the assistant's tools. The resources are
   * specific to the type of tool. For example, the `code_interpreter` tool requires
   * a list of file IDs, while the `file_search` tool requires a list of vector store
   * IDs.
   */
  tool_resources?: Assistant.ToolResources | null;

  /**
   * An alternative to sampling with temperature, called nucleus sampling, where the
   * model considers the results of the tokens with top_p probability mass. So 0.1
   * means only the tokens comprising the top 10% probability mass are considered.
   *
   * We generally recommend altering this or temperature but not both.
   */
  top_p?: number | null;
}

export namespace Assistant {
  /**
   * A set of resources that are used by the assistant's tools. The resources are
   * specific to the type of tool. For example, the `code_interpreter` tool requires
   * a list of file IDs, while the `file_search` tool requires a list of vector store
   * IDs.
   */
  export interface ToolResources {
    code_interpreter?: ToolResources.CodeInterpreter;

    file_search?: ToolResources.FileSearch;
  }

  export namespace ToolResources {
    export interface CodeInterpreter {
      /**
       * A list of [file](https://platform.openai.com/docs/api-reference/files) IDs made
       * available to the `code_interpreter`` tool. There can be a maximum of 20 files
       * associated with the tool.
       */
      file_ids?: Array<string>;
    }

    export interface FileSearch {
      /**
       * The ID of the
       * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object)
       * attached to this assistant. There can be a maximum of 1 vector store attached to
       * the assistant.
       */
      vector_store_ids?: Array<string>;
    }
  }
}

export interface AssistantDeleted {
  id: string;

  deleted: boolean;

  object: 'assistant.deleted';
}

/**
 * Represents an event emitted when streaming a Run.
 *
 * Each event in a server-sent events stream has an `event` and `data` property:
 *
 * ```
 * event: thread.created
 * data: {"id": "thread_123", "object": "thread", ...}
 * ```
 *
 * We emit events whenever a new object is created, transitions to a new state, or
 * is being streamed in parts (deltas). For example, we emit `thread.run.created`
 * when a new run is created, `thread.run.completed` when a run completes, and so
 * on. When an Assistant chooses to create a message during a run, we emit a
 * `thread.message.created event`, a `thread.message.in_progress` event, many
 * `thread.message.delta` events, and finally a `thread.message.completed` event.
 *
 * We may add additional events over time, so we recommend handling unknown events
 * gracefully in your code. See the
 * [Assistants API quickstart](https://platform.openai.com/docs/assistants/overview)
 * to learn how to integrate the Assistants API with streaming.
 */
export type AssistantStreamEvent =
  | AssistantStreamEvent.ThreadCreated
  | AssistantStreamEvent.ThreadRunCreated
  | AssistantStreamEvent.ThreadRunQueued
  | AssistantStreamEvent.ThreadRunInProgress
  | AssistantStreamEvent.ThreadRunRequiresAction
  | AssistantStreamEvent.ThreadRunCompleted
  | AssistantStreamEvent.ThreadRunIncomplete
  | AssistantStreamEvent.ThreadRunFailed
  | AssistantStreamEvent.ThreadRunCancelling
  | AssistantStreamEvent.ThreadRunCancelled
  | AssistantStreamEvent.ThreadRunExpired
  | AssistantStreamEvent.ThreadRunStepCreated
  | AssistantStreamEvent.ThreadRunStepInProgress
  | AssistantStreamEvent.ThreadRunStepDelta
  | AssistantStreamEvent.ThreadRunStepCompleted
  | AssistantStreamEvent.ThreadRunStepFailed
  | AssistantStreamEvent.ThreadRunStepCancelled
  | AssistantStreamEvent.ThreadRunStepExpired
  | AssistantStreamEvent.ThreadMessageCreated
  | AssistantStreamEvent.ThreadMessageInProgress
  | AssistantStreamEvent.ThreadMessageDelta
  | AssistantStreamEvent.ThreadMessageCompleted
  | AssistantStreamEvent.ThreadMessageIncomplete
  | AssistantStreamEvent.ErrorEvent;

export namespace AssistantStreamEvent {
  /**
   * Occurs when a new
   * [thread](https://platform.openai.com/docs/api-reference/threads/object) is
   * created.
   */
  export interface ThreadCreated {
    /**
     * Represents a thread that contains
     * [messages](https://platform.openai.com/docs/api-reference/messages).
     */
    data: ThreadsAPI.Thread;

    event: 'thread.created';

    /**
     * Whether to enable input audio transcription.
     */
    enabled?: boolean;
  }

  /**
   * Occurs when a new
   * [run](https://platform.openai.com/docs/api-reference/runs/object) is created.
   */
  export interface ThreadRunCreated {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.created';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * moves to a `queued` status.
   */
  export interface ThreadRunQueued {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.queued';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * moves to an `in_progress` status.
   */
  export interface ThreadRunInProgress {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.in_progress';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * moves to a `requires_action` status.
   */
  export interface ThreadRunRequiresAction {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.requires_action';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * is completed.
   */
  export interface ThreadRunCompleted {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.completed';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * ends with status `incomplete`.
   */
  export interface ThreadRunIncomplete {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.incomplete';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * fails.
   */
  export interface ThreadRunFailed {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.failed';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * moves to a `cancelling` status.
   */
  export interface ThreadRunCancelling {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.cancelling';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * is cancelled.
   */
  export interface ThreadRunCancelled {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.cancelled';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * expires.
   */
  export interface ThreadRunExpired {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.expired';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * is created.
   */
  export interface ThreadRunStepCreated {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.created';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * moves to an `in_progress` state.
   */
  export interface ThreadRunStepInProgress {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.in_progress';
  }

  /**
   * Occurs when parts of a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * are being streamed.
   */
  export interface ThreadRunStepDelta {
    /**
     * Represents a run step delta i.e. any changed fields on a run step during
     * streaming.
     */
    data: StepsAPI.RunStepDeltaEvent;

    event: 'thread.run.step.delta';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * is completed.
   */
  export interface ThreadRunStepCompleted {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.completed';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * fails.
   */
  export interface ThreadRunStepFailed {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.failed';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * is cancelled.
   */
  export interface ThreadRunStepCancelled {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.cancelled';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * expires.
   */
  export interface ThreadRunStepExpired {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.expired';
  }

  /**
   * Occurs when a
   * [message](https://platform.openai.com/docs/api-reference/messages/object) is
   * created.
   */
  export interface ThreadMessageCreated {
    /**
     * Represents a message within a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: MessagesAPI.Message;

    event: 'thread.message.created';
  }

  /**
   * Occurs when a
   * [message](https://platform.openai.com/docs/api-reference/messages/object) moves
   * to an `in_progress` state.
   */
  export interface ThreadMessageInProgress {
    /**
     * Represents a message within a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: MessagesAPI.Message;

    event: 'thread.message.in_progress';
  }

  /**
   * Occurs when parts of a
   * [Message](https://platform.openai.com/docs/api-reference/messages/object) are
   * being streamed.
   */
  export interface ThreadMessageDelta {
    /**
     * Represents a message delta i.e. any changed fields on a message during
     * streaming.
     */
    data: MessagesAPI.MessageDeltaEvent;

    event: 'thread.message.delta';
  }

  /**
   * Occurs when a
   * [message](https://platform.openai.com/docs/api-reference/messages/object) is
   * completed.
   */
  export interface ThreadMessageCompleted {
    /**
     * Represents a message within a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: MessagesAPI.Message;

    event: 'thread.message.completed';
  }

  /**
   * Occurs when a
   * [message](https://platform.openai.com/docs/api-reference/messages/object) ends
   * before it is completed.
   */
  export interface ThreadMessageIncomplete {
    /**
     * Represents a message within a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: MessagesAPI.Message;

    event: 'thread.message.incomplete';
  }

  /**
   * Occurs when an
   * [error](https://platform.openai.com/docs/guides/error-codes#api-errors) occurs.
   * This can happen due to an internal server error or a timeout.
   */
  export interface ErrorEvent {
    data: Shared.ErrorObject;

    event: 'error';
  }
}

export type AssistantTool = CodeInterpreterTool | FileSearchTool | FunctionTool;

export interface CodeInterpreterTool {
  /**
   * The type of tool being defined: `code_interpreter`
   */
  type: 'code_interpreter';
}

export interface FileSearchTool {
  /**
   * The type of tool being defined: `file_search`
   */
  type: 'file_search';

  /**
   * Overrides for the file search tool.
   */
  file_search?: FileSearchTool.FileSearch;
}

export namespace FileSearchTool {
  /**
   * Overrides for the file search tool.
   */
  export interface FileSearch {
    /**
     * The maximum number of results the file search tool should output. The default is
     * 20 for `gpt-4*` models and 5 for `gpt-3.5-turbo`. This number should be between
     * 1 and 50 inclusive.
     *
     * Note that the file search tool may output fewer than `max_num_results` results.
     * See the
     * [file search tool documentation](https://platform.openai.com/docs/assistants/tools/file-search#customizing-file-search-settings)
     * for more information.
     */
    max_num_results?: number;

    /**
     * The ranking options for the file search. If not specified, the file search tool
     * will use the `auto` ranker and a score_threshold of 0.
     *
     * See the
     * [file search tool documentation](https://platform.openai.com/docs/assistants/tools/file-search#customizing-file-search-settings)
     * for more information.
     */
    ranking_options?: FileSearch.RankingOptions;
  }

  export namespace FileSearch {
    /**
     * The ranking options for the file search. If not specified, the file search tool
     * will use the `auto` ranker and a score_threshold of 0.
     *
     * See the
     * [file search tool documentation](https://platform.openai.com/docs/assistants/tools/file-search#customizing-file-search-settings)
     * for more information.
     */
    export interface RankingOptions {
      /**
       * The score threshold for the file search. All values must be a floating point
       * number between 0 and 1.
       */
      score_threshold: number;

      /**
       * The ranker to use for the file search. If not specified will use the `auto`
       * ranker.
       */
      ranker?: 'auto' | 'default_2024_08_21';
    }
  }
}

export interface FunctionTool {
  function: Shared.FunctionDefinition;

  /**
   * The type of tool being defined: `function`
   */
  type: 'function';
}

/**
 * Occurs when a
 * [message](https://platform.openai.com/docs/api-reference/messages/object) is
 * created.
 */
export type MessageStreamEvent =
  | MessageStreamEvent.ThreadMessageCreated
  | MessageStreamEvent.ThreadMessageInProgress
  | MessageStreamEvent.ThreadMessageDelta
  | MessageStreamEvent.ThreadMessageCompleted
  | MessageStreamEvent.ThreadMessageIncomplete;

export namespace MessageStreamEvent {
  /**
   * Occurs when a
   * [message](https://platform.openai.com/docs/api-reference/messages/object) is
   * created.
   */
  export interface ThreadMessageCreated {
    /**
     * Represents a message within a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: MessagesAPI.Message;

    event: 'thread.message.created';
  }

  /**
   * Occurs when a
   * [message](https://platform.openai.com/docs/api-reference/messages/object) moves
   * to an `in_progress` state.
   */
  export interface ThreadMessageInProgress {
    /**
     * Represents a message within a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: MessagesAPI.Message;

    event: 'thread.message.in_progress';
  }

  /**
   * Occurs when parts of a
   * [Message](https://platform.openai.com/docs/api-reference/messages/object) are
   * being streamed.
   */
  export interface ThreadMessageDelta {
    /**
     * Represents a message delta i.e. any changed fields on a message during
     * streaming.
     */
    data: MessagesAPI.MessageDeltaEvent;

    event: 'thread.message.delta';
  }

  /**
   * Occurs when a
   * [message](https://platform.openai.com/docs/api-reference/messages/object) is
   * completed.
   */
  export interface ThreadMessageCompleted {
    /**
     * Represents a message within a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: MessagesAPI.Message;

    event: 'thread.message.completed';
  }

  /**
   * Occurs when a
   * [message](https://platform.openai.com/docs/api-reference/messages/object) ends
   * before it is completed.
   */
  export interface ThreadMessageIncomplete {
    /**
     * Represents a message within a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: MessagesAPI.Message;

    event: 'thread.message.incomplete';
  }
}

/**
 * Occurs when a
 * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
 * is created.
 */
export type RunStepStreamEvent =
  | RunStepStreamEvent.ThreadRunStepCreated
  | RunStepStreamEvent.ThreadRunStepInProgress
  | RunStepStreamEvent.ThreadRunStepDelta
  | RunStepStreamEvent.ThreadRunStepCompleted
  | RunStepStreamEvent.ThreadRunStepFailed
  | RunStepStreamEvent.ThreadRunStepCancelled
  | RunStepStreamEvent.ThreadRunStepExpired;

export namespace RunStepStreamEvent {
  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * is created.
   */
  export interface ThreadRunStepCreated {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.created';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * moves to an `in_progress` state.
   */
  export interface ThreadRunStepInProgress {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.in_progress';
  }

  /**
   * Occurs when parts of a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * are being streamed.
   */
  export interface ThreadRunStepDelta {
    /**
     * Represents a run step delta i.e. any changed fields on a run step during
     * streaming.
     */
    data: StepsAPI.RunStepDeltaEvent;

    event: 'thread.run.step.delta';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * is completed.
   */
  export interface ThreadRunStepCompleted {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.completed';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * fails.
   */
  export interface ThreadRunStepFailed {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.failed';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * is cancelled.
   */
  export interface ThreadRunStepCancelled {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.cancelled';
  }

  /**
   * Occurs when a
   * [run step](https://platform.openai.com/docs/api-reference/run-steps/step-object)
   * expires.
   */
  export interface ThreadRunStepExpired {
    /**
     * Represents a step in execution of a run.
     */
    data: StepsAPI.RunStep;

    event: 'thread.run.step.expired';
  }
}

/**
 * Occurs when a new
 * [run](https://platform.openai.com/docs/api-reference/runs/object) is created.
 */
export type RunStreamEvent =
  | RunStreamEvent.ThreadRunCreated
  | RunStreamEvent.ThreadRunQueued
  | RunStreamEvent.ThreadRunInProgress
  | RunStreamEvent.ThreadRunRequiresAction
  | RunStreamEvent.ThreadRunCompleted
  | RunStreamEvent.ThreadRunIncomplete
  | RunStreamEvent.ThreadRunFailed
  | RunStreamEvent.ThreadRunCancelling
  | RunStreamEvent.ThreadRunCancelled
  | RunStreamEvent.ThreadRunExpired;

export namespace RunStreamEvent {
  /**
   * Occurs when a new
   * [run](https://platform.openai.com/docs/api-reference/runs/object) is created.
   */
  export interface ThreadRunCreated {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.created';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * moves to a `queued` status.
   */
  export interface ThreadRunQueued {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.queued';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * moves to an `in_progress` status.
   */
  export interface ThreadRunInProgress {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.in_progress';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * moves to a `requires_action` status.
   */
  export interface ThreadRunRequiresAction {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.requires_action';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * is completed.
   */
  export interface ThreadRunCompleted {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.completed';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * ends with status `incomplete`.
   */
  export interface ThreadRunIncomplete {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.incomplete';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * fails.
   */
  export interface ThreadRunFailed {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.failed';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * moves to a `cancelling` status.
   */
  export interface ThreadRunCancelling {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.cancelling';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * is cancelled.
   */
  export interface ThreadRunCancelled {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.cancelled';
  }

  /**
   * Occurs when a [run](https://platform.openai.com/docs/api-reference/runs/object)
   * expires.
   */
  export interface ThreadRunExpired {
    /**
     * Represents an execution run on a
     * [thread](https://platform.openai.com/docs/api-reference/threads).
     */
    data: RunsAPI.Run;

    event: 'thread.run.expired';
  }
}

/**
 * Occurs when a new
 * [thread](https://platform.openai.com/docs/api-reference/threads/object) is
 * created.
 */
export interface ThreadStreamEvent {
  /**
   * Represents a thread that contains
   * [messages](https://platform.openai.com/docs/api-reference/messages).
   */
  data: ThreadsAPI.Thread;

  event: 'thread.created';

  /**
   * Whether to enable input audio transcription.
   */
  enabled?: boolean;
}

export interface AssistantCreateParams {
  /**
   * ID of the model to use. You can use the
   * [List models](https://platform.openai.com/docs/api-reference/models/list) API to
   * see all of your available models, or see our
   * [Model overview](https://platform.openai.com/docs/models) for descriptions of
   * them.
   */
  model: (string & {}) | Shared.ChatModel;

  /**
   * The description of the assistant. The maximum length is 512 characters.
   */
  description?: string | null;

  /**
   * The system instructions that the assistant uses. The maximum length is 256,000
   * characters.
   */
  instructions?: string | null;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata?: Shared.Metadata | null;

  /**
   * The name of the assistant. The maximum length is 256 characters.
   */
  name?: string | null;

  /**
   * Constrains effort on reasoning for
   * [reasoning models](https://platform.openai.com/docs/guides/reasoning). Currently
   * supported values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
   * Reducing reasoning effort can result in faster responses and fewer tokens used
   * on reasoning in a response.
   *
   * - `gpt-5.1` defaults to `none`, which does not perform reasoning. The supported
   *   reasoning values for `gpt-5.1` are `none`, `low`, `medium`, and `high`. Tool
   *   calls are supported for all reasoning values in gpt-5.1.
   * - All models before `gpt-5.1` default to `medium` reasoning effort, and do not
   *   support `none`.
   * - The `gpt-5-pro` model defaults to (and only supports) `high` reasoning effort.
   * - `xhigh` is supported for all models after `gpt-5.1-codex-max`.
   */
  reasoning_effort?: Shared.ReasoningEffort | null;

  /**
   * Specifies the format that the model must output. Compatible with
   * [GPT-4o](https://platform.openai.com/docs/models#gpt-4o),
   * [GPT-4 Turbo](https://platform.openai.com/docs/models#gpt-4-turbo-and-gpt-4),
   * and all GPT-3.5 Turbo models since `gpt-3.5-turbo-1106`.
   *
   * Setting to `{ "type": "json_schema", "json_schema": {...} }` enables Structured
   * Outputs which ensures the model will match your supplied JSON schema. Learn more
   * in the
   * [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs).
   *
   * Setting to `{ "type": "json_object" }` enables JSON mode, which ensures the
   * message the model generates is valid JSON.
   *
   * **Important:** when using JSON mode, you **must** also instruct the model to
   * produce JSON yourself via a system or user message. Without this, the model may
   * generate an unending stream of whitespace until the generation reaches the token
   * limit, resulting in a long-running and seemingly "stuck" request. Also note that
   * the message content may be partially cut off if `finish_reason="length"`, which
   * indicates the generation exceeded `max_tokens` or the conversation exceeded the
   * max context length.
   */
  response_format?: ThreadsAPI.AssistantResponseFormatOption | null;

  /**
   * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will
   * make the output more random, while lower values like 0.2 will make it more
   * focused and deterministic.
   */
  temperature?: number | null;

  /**
   * A set of resources that are used by the assistant's tools. The resources are
   * specific to the type of tool. For example, the `code_interpreter` tool requires
   * a list of file IDs, while the `file_search` tool requires a list of vector store
   * IDs.
   */
  tool_resources?: AssistantCreateParams.ToolResources | null;

  /**
   * A list of tool enabled on the assistant. There can be a maximum of 128 tools per
   * assistant. Tools can be of types `code_interpreter`, `file_search`, or
   * `function`.
   */
  tools?: Array<AssistantTool>;

  /**
   * An alternative to sampling with temperature, called nucleus sampling, where the
   * model considers the results of the tokens with top_p probability mass. So 0.1
   * means only the tokens comprising the top 10% probability mass are considered.
   *
   * We generally recommend altering this or temperature but not both.
   */
  top_p?: number | null;
}

export namespace AssistantCreateParams {
  /**
   * A set of resources that are used by the assistant's tools. The resources are
   * specific to the type of tool. For example, the `code_interpreter` tool requires
   * a list of file IDs, while the `file_search` tool requires a list of vector store
   * IDs.
   */
  export interface ToolResources {
    code_interpreter?: ToolResources.CodeInterpreter;

    file_search?: ToolResources.FileSearch;
  }

  export namespace ToolResources {
    export interface CodeInterpreter {
      /**
       * A list of [file](https://platform.openai.com/docs/api-reference/files) IDs made
       * available to the `code_interpreter` tool. There can be a maximum of 20 files
       * associated with the tool.
       */
      file_ids?: Array<string>;
    }

    export interface FileSearch {
      /**
       * The
       * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object)
       * attached to this assistant. There can be a maximum of 1 vector store attached to
       * the assistant.
       */
      vector_store_ids?: Array<string>;

      /**
       * A helper to create a
       * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object)
       * with file_ids and attach it to this assistant. There can be a maximum of 1
       * vector store attached to the assistant.
       */
      vector_stores?: Array<FileSearch.VectorStore>;
    }

    export namespace FileSearch {
      export interface VectorStore {
        /**
         * The chunking strategy used to chunk the file(s). If not set, will use the `auto`
         * strategy.
         */
        chunking_strategy?: VectorStore.Auto | VectorStore.Static;

        /**
         * A list of [file](https://platform.openai.com/docs/api-reference/files) IDs to
         * add to the vector store. For vector stores created before Nov 2025, there can be
         * a maximum of 10,000 files in a vector store. For vector stores created starting
         * in Nov 2025, the limit is 100,000,000 files.
         */
        file_ids?: Array<string>;

        /**
         * Set of 16 key-value pairs that can be attached to an object. This can be useful
         * for storing additional information about the object in a structured format, and
         * querying for objects via API or the dashboard.
         *
         * Keys are strings with a maximum length of 64 characters. Values are strings with
         * a maximum length of 512 characters.
         */
        metadata?: Shared.Metadata | null;
      }

      export namespace VectorStore {
        /**
         * The default strategy. This strategy currently uses a `max_chunk_size_tokens` of
         * `800` and `chunk_overlap_tokens` of `400`.
         */
        export interface Auto {
          /**
           * Always `auto`.
           */
          type: 'auto';
        }

        export interface Static {
          static: Static.Static;

          /**
           * Always `static`.
           */
          type: 'static';
        }

        export namespace Static {
          export interface Static {
            /**
             * The number of tokens that overlap between chunks. The default value is `400`.
             *
             * Note that the overlap must not exceed half of `max_chunk_size_tokens`.
             */
            chunk_overlap_tokens: number;

            /**
             * The maximum number of tokens in each chunk. The default value is `800`. The
             * minimum value is `100` and the maximum value is `4096`.
             */
            max_chunk_size_tokens: number;
          }
        }
      }
    }
  }
}

export interface AssistantUpdateParams {
  /**
   * The description of the assistant. The maximum length is 512 characters.
   */
  description?: string | null;

  /**
   * The system instructions that the assistant uses. The maximum length is 256,000
   * characters.
   */
  instructions?: string | null;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata?: Shared.Metadata | null;

  /**
   * ID of the model to use. You can use the
   * [List models](https://platform.openai.com/docs/api-reference/models/list) API to
   * see all of your available models, or see our
   * [Model overview](https://platform.openai.com/docs/models) for descriptions of
   * them.
   */
  model?:
    | (string & {})
    | 'gpt-5'
    | 'gpt-5-mini'
    | 'gpt-5-nano'
    | 'gpt-5-2025-08-07'
    | 'gpt-5-mini-2025-08-07'
    | 'gpt-5-nano-2025-08-07'
    | 'gpt-4.1'
    | 'gpt-4.1-mini'
    | 'gpt-4.1-nano'
    | 'gpt-4.1-2025-04-14'
    | 'gpt-4.1-mini-2025-04-14'
    | 'gpt-4.1-nano-2025-04-14'
    | 'o3-mini'
    | 'o3-mini-2025-01-31'
    | 'o1'
    | 'o1-2024-12-17'
    | 'gpt-4o'
    | 'gpt-4o-2024-11-20'
    | 'gpt-4o-2024-08-06'
    | 'gpt-4o-2024-05-13'
    | 'gpt-4o-mini'
    | 'gpt-4o-mini-2024-07-18'
    | 'gpt-4.5-preview'
    | 'gpt-4.5-preview-2025-02-27'
    | 'gpt-4-turbo'
    | 'gpt-4-turbo-2024-04-09'
    | 'gpt-4-0125-preview'
    | 'gpt-4-turbo-preview'
    | 'gpt-4-1106-preview'
    | 'gpt-4-vision-preview'
    | 'gpt-4'
    | 'gpt-4-0314'
    | 'gpt-4-0613'
    | 'gpt-4-32k'
    | 'gpt-4-32k-0314'
    | 'gpt-4-32k-0613'
    | 'gpt-3.5-turbo'
    | 'gpt-3.5-turbo-16k'
    | 'gpt-3.5-turbo-0613'
    | 'gpt-3.5-turbo-1106'
    | 'gpt-3.5-turbo-0125'
    | 'gpt-3.5-turbo-16k-0613';

  /**
   * The name of the assistant. The maximum length is 256 characters.
   */
  name?: string | null;

  /**
   * Constrains effort on reasoning for
   * [reasoning models](https://platform.openai.com/docs/guides/reasoning). Currently
   * supported values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
   * Reducing reasoning effort can result in faster responses and fewer tokens used
   * on reasoning in a response.
   *
   * - `gpt-5.1` defaults to `none`, which does not perform reasoning. The supported
   *   reasoning values for `gpt-5.1` are `none`, `low`, `medium`, and `high`. Tool
   *   calls are supported for all reasoning values in gpt-5.1.
   * - All models before `gpt-5.1` default to `medium` reasoning effort, and do not
   *   support `none`.
   * - The `gpt-5-pro` model defaults to (and only supports) `high` reasoning effort.
   * - `xhigh` is supported for all models after `gpt-5.1-codex-max`.
   */
  reasoning_effort?: Shared.ReasoningEffort | null;

  /**
   * Specifies the format that the model must output. Compatible with
   * [GPT-4o](https://platform.openai.com/docs/models#gpt-4o),
   * [GPT-4 Turbo](https://platform.openai.com/docs/models#gpt-4-turbo-and-gpt-4),
   * and all GPT-3.5 Turbo models since `gpt-3.5-turbo-1106`.
   *
   * Setting to `{ "type": "json_schema", "json_schema": {...} }` enables Structured
   * Outputs which ensures the model will match your supplied JSON schema. Learn more
   * in the
   * [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs).
   *
   * Setting to `{ "type": "json_object" }` enables JSON mode, which ensures the
   * message the model generates is valid JSON.
   *
   * **Important:** when using JSON mode, you **must** also instruct the model to
   * produce JSON yourself via a system or user message. Without this, the model may
   * generate an unending stream of whitespace until the generation reaches the token
   * limit, resulting in a long-running and seemingly "stuck" request. Also note that
   * the message content may be partially cut off if `finish_reason="length"`, which
   * indicates the generation exceeded `max_tokens` or the conversation exceeded the
   * max context length.
   */
  response_format?: ThreadsAPI.AssistantResponseFormatOption | null;

  /**
   * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will
   * make the output more random, while lower values like 0.2 will make it more
   * focused and deterministic.
   */
  temperature?: number | null;

  /**
   * A set of resources that are used by the assistant's tools. The resources are
   * specific to the type of tool. For example, the `code_interpreter` tool requires
   * a list of file IDs, while the `file_search` tool requires a list of vector store
   * IDs.
   */
  tool_resources?: AssistantUpdateParams.ToolResources | null;

  /**
   * A list of tool enabled on the assistant. There can be a maximum of 128 tools per
   * assistant. Tools can be of types `code_interpreter`, `file_search`, or
   * `function`.
   */
  tools?: Array<AssistantTool>;

  /**
   * An alternative to sampling with temperature, called nucleus sampling, where the
   * model considers the results of the tokens with top_p probability mass. So 0.1
   * means only the tokens comprising the top 10% probability mass are considered.
   *
   * We generally recommend altering this or temperature but not both.
   */
  top_p?: number | null;
}

export namespace AssistantUpdateParams {
  /**
   * A set of resources that are used by the assistant's tools. The resources are
   * specific to the type of tool. For example, the `code_interpreter` tool requires
   * a list of file IDs, while the `file_search` tool requires a list of vector store
   * IDs.
   */
  export interface ToolResources {
    code_interpreter?: ToolResources.CodeInterpreter;

    file_search?: ToolResources.FileSearch;
  }

  export namespace ToolResources {
    export interface CodeInterpreter {
      /**
       * Overrides the list of
       * [file](https://platform.openai.com/docs/api-reference/files) IDs made available
       * to the `code_interpreter` tool. There can be a maximum of 20 files associated
       * with the tool.
       */
      file_ids?: Array<string>;
    }

    export interface FileSearch {
      /**
       * Overrides the
       * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object)
       * attached to this assistant. There can be a maximum of 1 vector store attached to
       * the assistant.
       */
      vector_store_ids?: Array<string>;
    }
  }
}

export interface AssistantListParams extends CursorPageParams {
  /**
   * A cursor for use in pagination. `before` is an object ID that defines your place
   * in the list. For instance, if you make a list request and receive 100 objects,
   * starting with obj_foo, your subsequent call can include before=obj_foo in order
   * to fetch the previous page of the list.
   */
  before?: string;

  /**
   * Sort order by the `created_at` timestamp of the objects. `asc` for ascending
   * order and `desc` for descending order.
   */
  order?: 'asc' | 'desc';
}

export declare namespace Assistants {
  export {
    type Assistant as Assistant,
    type AssistantDeleted as AssistantDeleted,
    type AssistantStreamEvent as AssistantStreamEvent,
    type AssistantTool as AssistantTool,
    type CodeInterpreterTool as CodeInterpreterTool,
    type FileSearchTool as FileSearchTool,
    type FunctionTool as FunctionTool,
    type MessageStreamEvent as MessageStreamEvent,
    type RunStepStreamEvent as RunStepStreamEvent,
    type RunStreamEvent as RunStreamEvent,
    type ThreadStreamEvent as ThreadStreamEvent,
    type AssistantsPage as AssistantsPage,
    type AssistantCreateParams as AssistantCreateParams,
    type AssistantUpdateParams as AssistantUpdateParams,
    type AssistantListParams as AssistantListParams,
  };

  export { AssistantStream };
}
