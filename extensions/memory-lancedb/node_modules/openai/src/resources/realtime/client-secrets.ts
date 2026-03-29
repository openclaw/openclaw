// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as ClientSecretsAPI from './client-secrets';
import * as RealtimeAPI from './realtime';
import * as ResponsesAPI from '../responses/responses';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class ClientSecrets extends APIResource {
  /**
   * Create a Realtime client secret with an associated session configuration.
   *
   * Client secrets are short-lived tokens that can be passed to a client app, such
   * as a web frontend or mobile client, which grants access to the Realtime API
   * without leaking your main API key. You can configure a custom TTL for each
   * client secret.
   *
   * You can also attach session configuration options to the client secret, which
   * will be applied to any sessions created using that client secret, but these can
   * also be overridden by the client connection.
   *
   * [Learn more about authentication with client secrets over WebRTC](https://platform.openai.com/docs/guides/realtime-webrtc).
   *
   * Returns the created client secret and the effective session object. The client
   * secret is a string that looks like `ek_1234`.
   *
   * @example
   * ```ts
   * const clientSecret =
   *   await client.realtime.clientSecrets.create();
   * ```
   */
  create(body: ClientSecretCreateParams, options?: RequestOptions): APIPromise<ClientSecretCreateResponse> {
    return this._client.post('/realtime/client_secrets', { body, ...options });
  }
}

/**
 * Ephemeral key returned by the API.
 */
export interface RealtimeSessionClientSecret {
  /**
   * Timestamp for when the token expires. Currently, all tokens expire after one
   * minute.
   */
  expires_at: number;

  /**
   * Ephemeral key usable in client environments to authenticate connections to the
   * Realtime API. Use this in client-side environments rather than a standard API
   * token, which should only be used server-side.
   */
  value: string;
}

/**
 * A new Realtime session configuration, with an ephemeral key. Default TTL for
 * keys is one minute.
 */
export interface RealtimeSessionCreateResponse {
  /**
   * Ephemeral key returned by the API.
   */
  client_secret: RealtimeSessionClientSecret;

  /**
   * The type of session to create. Always `realtime` for the Realtime API.
   */
  type: 'realtime';

  /**
   * Configuration for input and output audio.
   */
  audio?: RealtimeSessionCreateResponse.Audio;

  /**
   * Additional fields to include in server outputs.
   *
   * `item.input_audio_transcription.logprobs`: Include logprobs for input audio
   * transcription.
   */
  include?: Array<'item.input_audio_transcription.logprobs'>;

  /**
   * The default system instructions (i.e. system message) prepended to model calls.
   * This field allows the client to guide the model on desired responses. The model
   * can be instructed on response content and format, (e.g. "be extremely succinct",
   * "act friendly", "here are examples of good responses") and on audio behavior
   * (e.g. "talk quickly", "inject emotion into your voice", "laugh frequently"). The
   * instructions are not guaranteed to be followed by the model, but they provide
   * guidance to the model on the desired behavior.
   *
   * Note that the server sets default instructions which will be used if this field
   * is not set and are visible in the `session.created` event at the start of the
   * session.
   */
  instructions?: string;

  /**
   * Maximum number of output tokens for a single assistant response, inclusive of
   * tool calls. Provide an integer between 1 and 4096 to limit output tokens, or
   * `inf` for the maximum available tokens for a given model. Defaults to `inf`.
   */
  max_output_tokens?: number | 'inf';

  /**
   * The Realtime model used for this session.
   */
  model?:
    | (string & {})
    | 'gpt-realtime'
    | 'gpt-realtime-1.5'
    | 'gpt-realtime-2025-08-28'
    | 'gpt-4o-realtime-preview'
    | 'gpt-4o-realtime-preview-2024-10-01'
    | 'gpt-4o-realtime-preview-2024-12-17'
    | 'gpt-4o-realtime-preview-2025-06-03'
    | 'gpt-4o-mini-realtime-preview'
    | 'gpt-4o-mini-realtime-preview-2024-12-17'
    | 'gpt-realtime-mini'
    | 'gpt-realtime-mini-2025-10-06'
    | 'gpt-realtime-mini-2025-12-15'
    | 'gpt-audio-1.5'
    | 'gpt-audio-mini'
    | 'gpt-audio-mini-2025-10-06'
    | 'gpt-audio-mini-2025-12-15';

  /**
   * The set of modalities the model can respond with. It defaults to `["audio"]`,
   * indicating that the model will respond with audio plus a transcript. `["text"]`
   * can be used to make the model respond with text only. It is not possible to
   * request both `text` and `audio` at the same time.
   */
  output_modalities?: Array<'text' | 'audio'>;

  /**
   * Reference to a prompt template and its variables.
   * [Learn more](https://platform.openai.com/docs/guides/text?api-mode=responses#reusable-prompts).
   */
  prompt?: ResponsesAPI.ResponsePrompt | null;

  /**
   * How the model chooses tools. Provide one of the string modes or force a specific
   * function/MCP tool.
   */
  tool_choice?: ResponsesAPI.ToolChoiceOptions | ResponsesAPI.ToolChoiceFunction | ResponsesAPI.ToolChoiceMcp;

  /**
   * Tools available to the model.
   */
  tools?: Array<RealtimeAPI.RealtimeFunctionTool | RealtimeSessionCreateResponse.McpTool>;

  /**
   * Realtime API can write session traces to the
   * [Traces Dashboard](/logs?api=traces). Set to null to disable tracing. Once
   * tracing is enabled for a session, the configuration cannot be modified.
   *
   * `auto` will create a trace for the session with default values for the workflow
   * name, group id, and metadata.
   */
  tracing?: 'auto' | RealtimeSessionCreateResponse.TracingConfiguration | null;

  /**
   * When the number of tokens in a conversation exceeds the model's input token
   * limit, the conversation be truncated, meaning messages (starting from the
   * oldest) will not be included in the model's context. A 32k context model with
   * 4,096 max output tokens can only include 28,224 tokens in the context before
   * truncation occurs.
   *
   * Clients can configure truncation behavior to truncate with a lower max token
   * limit, which is an effective way to control token usage and cost.
   *
   * Truncation will reduce the number of cached tokens on the next turn (busting the
   * cache), since messages are dropped from the beginning of the context. However,
   * clients can also configure truncation to retain messages up to a fraction of the
   * maximum context size, which will reduce the need for future truncations and thus
   * improve the cache rate.
   *
   * Truncation can be disabled entirely, which means the server will never truncate
   * but would instead return an error if the conversation exceeds the model's input
   * token limit.
   */
  truncation?: RealtimeAPI.RealtimeTruncation;
}

export namespace RealtimeSessionCreateResponse {
  /**
   * Configuration for input and output audio.
   */
  export interface Audio {
    input?: Audio.Input;

    output?: Audio.Output;
  }

  export namespace Audio {
    export interface Input {
      /**
       * The format of the input audio.
       */
      format?: RealtimeAPI.RealtimeAudioFormats;

      /**
       * Configuration for input audio noise reduction. This can be set to `null` to turn
       * off. Noise reduction filters audio added to the input audio buffer before it is
       * sent to VAD and the model. Filtering the audio can improve VAD and turn
       * detection accuracy (reducing false positives) and model performance by improving
       * perception of the input audio.
       */
      noise_reduction?: Input.NoiseReduction;

      /**
       * Configuration for input audio transcription, defaults to off and can be set to
       * `null` to turn off once on. Input audio transcription is not native to the
       * model, since the model consumes audio directly. Transcription runs
       * asynchronously through
       * [the /audio/transcriptions endpoint](https://platform.openai.com/docs/api-reference/audio/createTranscription)
       * and should be treated as guidance of input audio content rather than precisely
       * what the model heard. The client can optionally set the language and prompt for
       * transcription, these offer additional guidance to the transcription service.
       */
      transcription?: RealtimeAPI.AudioTranscription;

      /**
       * Configuration for turn detection, ether Server VAD or Semantic VAD. This can be
       * set to `null` to turn off, in which case the client must manually trigger model
       * response.
       *
       * Server VAD means that the model will detect the start and end of speech based on
       * audio volume and respond at the end of user speech.
       *
       * Semantic VAD is more advanced and uses a turn detection model (in conjunction
       * with VAD) to semantically estimate whether the user has finished speaking, then
       * dynamically sets a timeout based on this probability. For example, if user audio
       * trails off with "uhhm", the model will score a low probability of turn end and
       * wait longer for the user to continue speaking. This can be useful for more
       * natural conversations, but may have a higher latency.
       */
      turn_detection?: Input.ServerVad | Input.SemanticVad | null;
    }

    export namespace Input {
      /**
       * Configuration for input audio noise reduction. This can be set to `null` to turn
       * off. Noise reduction filters audio added to the input audio buffer before it is
       * sent to VAD and the model. Filtering the audio can improve VAD and turn
       * detection accuracy (reducing false positives) and model performance by improving
       * perception of the input audio.
       */
      export interface NoiseReduction {
        /**
         * Type of noise reduction. `near_field` is for close-talking microphones such as
         * headphones, `far_field` is for far-field microphones such as laptop or
         * conference room microphones.
         */
        type?: RealtimeAPI.NoiseReductionType;
      }

      /**
       * Server-side voice activity detection (VAD) which flips on when user speech is
       * detected and off after a period of silence.
       */
      export interface ServerVad {
        /**
         * Type of turn detection, `server_vad` to turn on simple Server VAD.
         */
        type: 'server_vad';

        /**
         * Whether or not to automatically generate a response when a VAD stop event
         * occurs. If `interrupt_response` is set to `false` this may fail to create a
         * response if the model is already responding.
         *
         * If both `create_response` and `interrupt_response` are set to `false`, the model
         * will never respond automatically but VAD events will still be emitted.
         */
        create_response?: boolean;

        /**
         * Optional timeout after which a model response will be triggered automatically.
         * This is useful for situations in which a long pause from the user is unexpected,
         * such as a phone call. The model will effectively prompt the user to continue the
         * conversation based on the current context.
         *
         * The timeout value will be applied after the last model response's audio has
         * finished playing, i.e. it's set to the `response.done` time plus audio playback
         * duration.
         *
         * An `input_audio_buffer.timeout_triggered` event (plus events associated with the
         * Response) will be emitted when the timeout is reached. Idle timeout is currently
         * only supported for `server_vad` mode.
         */
        idle_timeout_ms?: number | null;

        /**
         * Whether or not to automatically interrupt (cancel) any ongoing response with
         * output to the default conversation (i.e. `conversation` of `auto`) when a VAD
         * start event occurs. If `true` then the response will be cancelled, otherwise it
         * will continue until complete.
         *
         * If both `create_response` and `interrupt_response` are set to `false`, the model
         * will never respond automatically but VAD events will still be emitted.
         */
        interrupt_response?: boolean;

        /**
         * Used only for `server_vad` mode. Amount of audio to include before the VAD
         * detected speech (in milliseconds). Defaults to 300ms.
         */
        prefix_padding_ms?: number;

        /**
         * Used only for `server_vad` mode. Duration of silence to detect speech stop (in
         * milliseconds). Defaults to 500ms. With shorter values the model will respond
         * more quickly, but may jump in on short pauses from the user.
         */
        silence_duration_ms?: number;

        /**
         * Used only for `server_vad` mode. Activation threshold for VAD (0.0 to 1.0), this
         * defaults to 0.5. A higher threshold will require louder audio to activate the
         * model, and thus might perform better in noisy environments.
         */
        threshold?: number;
      }

      /**
       * Server-side semantic turn detection which uses a model to determine when the
       * user has finished speaking.
       */
      export interface SemanticVad {
        /**
         * Type of turn detection, `semantic_vad` to turn on Semantic VAD.
         */
        type: 'semantic_vad';

        /**
         * Whether or not to automatically generate a response when a VAD stop event
         * occurs.
         */
        create_response?: boolean;

        /**
         * Used only for `semantic_vad` mode. The eagerness of the model to respond. `low`
         * will wait longer for the user to continue speaking, `high` will respond more
         * quickly. `auto` is the default and is equivalent to `medium`. `low`, `medium`,
         * and `high` have max timeouts of 8s, 4s, and 2s respectively.
         */
        eagerness?: 'low' | 'medium' | 'high' | 'auto';

        /**
         * Whether or not to automatically interrupt any ongoing response with output to
         * the default conversation (i.e. `conversation` of `auto`) when a VAD start event
         * occurs.
         */
        interrupt_response?: boolean;
      }
    }

    export interface Output {
      /**
       * The format of the output audio.
       */
      format?: RealtimeAPI.RealtimeAudioFormats;

      /**
       * The speed of the model's spoken response as a multiple of the original speed.
       * 1.0 is the default speed. 0.25 is the minimum speed. 1.5 is the maximum speed.
       * This value can only be changed in between model turns, not while a response is
       * in progress.
       *
       * This parameter is a post-processing adjustment to the audio after it is
       * generated, it's also possible to prompt the model to speak faster or slower.
       */
      speed?: number;

      /**
       * The voice the model uses to respond. Voice cannot be changed during the session
       * once the model has responded with audio at least once. Current voice options are
       * `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`,
       * and `cedar`. We recommend `marin` and `cedar` for best quality.
       */
      voice?:
        | (string & {})
        | 'alloy'
        | 'ash'
        | 'ballad'
        | 'coral'
        | 'echo'
        | 'sage'
        | 'shimmer'
        | 'verse'
        | 'marin'
        | 'cedar';
    }
  }

  /**
   * Give the model access to additional tools via remote Model Context Protocol
   * (MCP) servers.
   * [Learn more about MCP](https://platform.openai.com/docs/guides/tools-remote-mcp).
   */
  export interface McpTool {
    /**
     * A label for this MCP server, used to identify it in tool calls.
     */
    server_label: string;

    /**
     * The type of the MCP tool. Always `mcp`.
     */
    type: 'mcp';

    /**
     * List of allowed tool names or a filter object.
     */
    allowed_tools?: Array<string> | McpTool.McpToolFilter | null;

    /**
     * An OAuth access token that can be used with a remote MCP server, either with a
     * custom MCP server URL or a service connector. Your application must handle the
     * OAuth authorization flow and provide the token here.
     */
    authorization?: string;

    /**
     * Identifier for service connectors, like those available in ChatGPT. One of
     * `server_url` or `connector_id` must be provided. Learn more about service
     * connectors
     * [here](https://platform.openai.com/docs/guides/tools-remote-mcp#connectors).
     *
     * Currently supported `connector_id` values are:
     *
     * - Dropbox: `connector_dropbox`
     * - Gmail: `connector_gmail`
     * - Google Calendar: `connector_googlecalendar`
     * - Google Drive: `connector_googledrive`
     * - Microsoft Teams: `connector_microsoftteams`
     * - Outlook Calendar: `connector_outlookcalendar`
     * - Outlook Email: `connector_outlookemail`
     * - SharePoint: `connector_sharepoint`
     */
    connector_id?:
      | 'connector_dropbox'
      | 'connector_gmail'
      | 'connector_googlecalendar'
      | 'connector_googledrive'
      | 'connector_microsoftteams'
      | 'connector_outlookcalendar'
      | 'connector_outlookemail'
      | 'connector_sharepoint';

    /**
     * Whether this MCP tool is deferred and discovered via tool search.
     */
    defer_loading?: boolean;

    /**
     * Optional HTTP headers to send to the MCP server. Use for authentication or other
     * purposes.
     */
    headers?: { [key: string]: string } | null;

    /**
     * Specify which of the MCP server's tools require approval.
     */
    require_approval?: McpTool.McpToolApprovalFilter | 'always' | 'never' | null;

    /**
     * Optional description of the MCP server, used to provide more context.
     */
    server_description?: string;

    /**
     * The URL for the MCP server. One of `server_url` or `connector_id` must be
     * provided.
     */
    server_url?: string;
  }

  export namespace McpTool {
    /**
     * A filter object to specify which tools are allowed.
     */
    export interface McpToolFilter {
      /**
       * Indicates whether or not a tool modifies data or is read-only. If an MCP server
       * is
       * [annotated with `readOnlyHint`](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations-readonlyhint),
       * it will match this filter.
       */
      read_only?: boolean;

      /**
       * List of allowed tool names.
       */
      tool_names?: Array<string>;
    }

    /**
     * Specify which of the MCP server's tools require approval. Can be `always`,
     * `never`, or a filter object associated with tools that require approval.
     */
    export interface McpToolApprovalFilter {
      /**
       * A filter object to specify which tools are allowed.
       */
      always?: McpToolApprovalFilter.Always;

      /**
       * A filter object to specify which tools are allowed.
       */
      never?: McpToolApprovalFilter.Never;
    }

    export namespace McpToolApprovalFilter {
      /**
       * A filter object to specify which tools are allowed.
       */
      export interface Always {
        /**
         * Indicates whether or not a tool modifies data or is read-only. If an MCP server
         * is
         * [annotated with `readOnlyHint`](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations-readonlyhint),
         * it will match this filter.
         */
        read_only?: boolean;

        /**
         * List of allowed tool names.
         */
        tool_names?: Array<string>;
      }

      /**
       * A filter object to specify which tools are allowed.
       */
      export interface Never {
        /**
         * Indicates whether or not a tool modifies data or is read-only. If an MCP server
         * is
         * [annotated with `readOnlyHint`](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations-readonlyhint),
         * it will match this filter.
         */
        read_only?: boolean;

        /**
         * List of allowed tool names.
         */
        tool_names?: Array<string>;
      }
    }
  }

  /**
   * Granular configuration for tracing.
   */
  export interface TracingConfiguration {
    /**
     * The group id to attach to this trace to enable filtering and grouping in the
     * Traces Dashboard.
     */
    group_id?: string;

    /**
     * The arbitrary metadata to attach to this trace to enable filtering in the Traces
     * Dashboard.
     */
    metadata?: unknown;

    /**
     * The name of the workflow to attach to this trace. This is used to name the trace
     * in the Traces Dashboard.
     */
    workflow_name?: string;
  }
}

/**
 * A Realtime transcription session configuration object.
 */
export interface RealtimeTranscriptionSessionCreateResponse {
  /**
   * Unique identifier for the session that looks like `sess_1234567890abcdef`.
   */
  id: string;

  /**
   * The object type. Always `realtime.transcription_session`.
   */
  object: string;

  /**
   * The type of session. Always `transcription` for transcription sessions.
   */
  type: 'transcription';

  /**
   * Configuration for input audio for the session.
   */
  audio?: RealtimeTranscriptionSessionCreateResponse.Audio;

  /**
   * Expiration timestamp for the session, in seconds since epoch.
   */
  expires_at?: number;

  /**
   * Additional fields to include in server outputs.
   *
   * - `item.input_audio_transcription.logprobs`: Include logprobs for input audio
   *   transcription.
   */
  include?: Array<'item.input_audio_transcription.logprobs'>;
}

export namespace RealtimeTranscriptionSessionCreateResponse {
  /**
   * Configuration for input audio for the session.
   */
  export interface Audio {
    input?: Audio.Input;
  }

  export namespace Audio {
    export interface Input {
      /**
       * The PCM audio format. Only a 24kHz sample rate is supported.
       */
      format?: RealtimeAPI.RealtimeAudioFormats;

      /**
       * Configuration for input audio noise reduction.
       */
      noise_reduction?: Input.NoiseReduction;

      /**
       * Configuration of the transcription model.
       */
      transcription?: RealtimeAPI.AudioTranscription;

      /**
       * Configuration for turn detection. Can be set to `null` to turn off. Server VAD
       * means that the model will detect the start and end of speech based on audio
       * volume and respond at the end of user speech.
       */
      turn_detection?: ClientSecretsAPI.RealtimeTranscriptionSessionTurnDetection;
    }

    export namespace Input {
      /**
       * Configuration for input audio noise reduction.
       */
      export interface NoiseReduction {
        /**
         * Type of noise reduction. `near_field` is for close-talking microphones such as
         * headphones, `far_field` is for far-field microphones such as laptop or
         * conference room microphones.
         */
        type?: RealtimeAPI.NoiseReductionType;
      }
    }
  }
}

/**
 * Configuration for turn detection. Can be set to `null` to turn off. Server VAD
 * means that the model will detect the start and end of speech based on audio
 * volume and respond at the end of user speech.
 */
export interface RealtimeTranscriptionSessionTurnDetection {
  /**
   * Amount of audio to include before the VAD detected speech (in milliseconds).
   * Defaults to 300ms.
   */
  prefix_padding_ms?: number;

  /**
   * Duration of silence to detect speech stop (in milliseconds). Defaults to 500ms.
   * With shorter values the model will respond more quickly, but may jump in on
   * short pauses from the user.
   */
  silence_duration_ms?: number;

  /**
   * Activation threshold for VAD (0.0 to 1.0), this defaults to 0.5. A higher
   * threshold will require louder audio to activate the model, and thus might
   * perform better in noisy environments.
   */
  threshold?: number;

  /**
   * Type of turn detection, only `server_vad` is currently supported.
   */
  type?: string;
}

/**
 * Response from creating a session and client secret for the Realtime API.
 */
export interface ClientSecretCreateResponse {
  /**
   * Expiration timestamp for the client secret, in seconds since epoch.
   */
  expires_at: number;

  /**
   * The session configuration for either a realtime or transcription session.
   */
  session: RealtimeSessionCreateResponse | RealtimeTranscriptionSessionCreateResponse;

  /**
   * The generated client secret value.
   */
  value: string;
}

export interface ClientSecretCreateParams {
  /**
   * Configuration for the client secret expiration. Expiration refers to the time
   * after which a client secret will no longer be valid for creating sessions. The
   * session itself may continue after that time once started. A secret can be used
   * to create multiple sessions until it expires.
   */
  expires_after?: ClientSecretCreateParams.ExpiresAfter;

  /**
   * Session configuration to use for the client secret. Choose either a realtime
   * session or a transcription session.
   */
  session?: RealtimeAPI.RealtimeSessionCreateRequest | RealtimeAPI.RealtimeTranscriptionSessionCreateRequest;
}

export namespace ClientSecretCreateParams {
  /**
   * Configuration for the client secret expiration. Expiration refers to the time
   * after which a client secret will no longer be valid for creating sessions. The
   * session itself may continue after that time once started. A secret can be used
   * to create multiple sessions until it expires.
   */
  export interface ExpiresAfter {
    /**
     * The anchor point for the client secret expiration, meaning that `seconds` will
     * be added to the `created_at` time of the client secret to produce an expiration
     * timestamp. Only `created_at` is currently supported.
     */
    anchor?: 'created_at';

    /**
     * The number of seconds from the anchor point to the expiration. Select a value
     * between `10` and `7200` (2 hours). This default to 600 seconds (10 minutes) if
     * not specified.
     */
    seconds?: number;
  }
}

export declare namespace ClientSecrets {
  export {
    type RealtimeSessionClientSecret as RealtimeSessionClientSecret,
    type RealtimeSessionCreateResponse as RealtimeSessionCreateResponse,
    type RealtimeTranscriptionSessionCreateResponse as RealtimeTranscriptionSessionCreateResponse,
    type RealtimeTranscriptionSessionTurnDetection as RealtimeTranscriptionSessionTurnDetection,
    type ClientSecretCreateResponse as ClientSecretCreateResponse,
    type ClientSecretCreateParams as ClientSecretCreateParams,
  };
}
