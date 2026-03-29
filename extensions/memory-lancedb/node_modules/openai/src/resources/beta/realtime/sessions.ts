// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { buildHeaders } from '../../../internal/headers';
import { RequestOptions } from '../../../internal/request-options';

export class Sessions extends APIResource {
  /**
   * Create an ephemeral API token for use in client-side applications with the
   * Realtime API. Can be configured with the same session parameters as the
   * `session.update` client event.
   *
   * It responds with a session object, plus a `client_secret` key which contains a
   * usable ephemeral API token that can be used to authenticate browser clients for
   * the Realtime API.
   *
   * @example
   * ```ts
   * const session =
   *   await client.beta.realtime.sessions.create();
   * ```
   */
  create(body: SessionCreateParams, options?: RequestOptions): APIPromise<SessionCreateResponse> {
    return this._client.post('/realtime/sessions', {
      body,
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }
}

/**
 * Realtime session object configuration.
 */
export interface Session {
  /**
   * Unique identifier for the session that looks like `sess_1234567890abcdef`.
   */
  id?: string;

  /**
   * The format of input audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`. For
   * `pcm16`, input audio must be 16-bit PCM at a 24kHz sample rate, single channel
   * (mono), and little-endian byte order.
   */
  input_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';

  /**
   * Configuration for input audio noise reduction. This can be set to `null` to turn
   * off. Noise reduction filters audio added to the input audio buffer before it is
   * sent to VAD and the model. Filtering the audio can improve VAD and turn
   * detection accuracy (reducing false positives) and model performance by improving
   * perception of the input audio.
   */
  input_audio_noise_reduction?: Session.InputAudioNoiseReduction;

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
  input_audio_transcription?: Session.InputAudioTranscription;

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
  max_response_output_tokens?: number | 'inf';

  /**
   * The set of modalities the model can respond with. To disable audio, set this to
   * ["text"].
   */
  modalities?: Array<'text' | 'audio'>;

  /**
   * The Realtime model used for this session.
   */
  model?:
    | 'gpt-4o-realtime-preview'
    | 'gpt-4o-realtime-preview-2024-10-01'
    | 'gpt-4o-realtime-preview-2024-12-17'
    | 'gpt-4o-realtime-preview-2025-06-03'
    | 'gpt-4o-mini-realtime-preview'
    | 'gpt-4o-mini-realtime-preview-2024-12-17';

  /**
   * The format of output audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`.
   * For `pcm16`, output audio is sampled at a rate of 24kHz.
   */
  output_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';

  /**
   * The speed of the model's spoken response. 1.0 is the default speed. 0.25 is the
   * minimum speed. 1.5 is the maximum speed. This value can only be changed in
   * between model turns, not while a response is in progress.
   */
  speed?: number;

  /**
   * Sampling temperature for the model, limited to [0.6, 1.2]. For audio models a
   * temperature of 0.8 is highly recommended for best performance.
   */
  temperature?: number;

  /**
   * How the model chooses tools. Options are `auto`, `none`, `required`, or specify
   * a function.
   */
  tool_choice?: string;

  /**
   * Tools (functions) available to the model.
   */
  tools?: Array<Session.Tool>;

  /**
   * Configuration options for tracing. Set to null to disable tracing. Once tracing
   * is enabled for a session, the configuration cannot be modified.
   *
   * `auto` will create a trace for the session with default values for the workflow
   * name, group id, and metadata.
   */
  tracing?: 'auto' | Session.TracingConfiguration;

  /**
   * Configuration for turn detection, ether Server VAD or Semantic VAD. This can be
   * set to `null` to turn off, in which case the client must manually trigger model
   * response. Server VAD means that the model will detect the start and end of
   * speech based on audio volume and respond at the end of user speech. Semantic VAD
   * is more advanced and uses a turn detection model (in conjunction with VAD) to
   * semantically estimate whether the user has finished speaking, then dynamically
   * sets a timeout based on this probability. For example, if user audio trails off
   * with "uhhm", the model will score a low probability of turn end and wait longer
   * for the user to continue speaking. This can be useful for more natural
   * conversations, but may have a higher latency.
   */
  turn_detection?: Session.TurnDetection;

  /**
   * The voice the model uses to respond. Voice cannot be changed during the session
   * once the model has responded with audio at least once. Current voice options are
   * `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, and `verse`.
   */
  voice?: (string & {}) | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse';
}

export namespace Session {
  /**
   * Configuration for input audio noise reduction. This can be set to `null` to turn
   * off. Noise reduction filters audio added to the input audio buffer before it is
   * sent to VAD and the model. Filtering the audio can improve VAD and turn
   * detection accuracy (reducing false positives) and model performance by improving
   * perception of the input audio.
   */
  export interface InputAudioNoiseReduction {
    /**
     * Type of noise reduction. `near_field` is for close-talking microphones such as
     * headphones, `far_field` is for far-field microphones such as laptop or
     * conference room microphones.
     */
    type?: 'near_field' | 'far_field';
  }

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
  export interface InputAudioTranscription {
    /**
     * The language of the input audio. Supplying the input language in
     * [ISO-639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) (e.g. `en`)
     * format will improve accuracy and latency.
     */
    language?: string;

    /**
     * The model to use for transcription, current options are `gpt-4o-transcribe`,
     * `gpt-4o-mini-transcribe`, and `whisper-1`.
     */
    model?: string;

    /**
     * An optional text to guide the model's style or continue a previous audio
     * segment. For `whisper-1`, the
     * [prompt is a list of keywords](https://platform.openai.com/docs/guides/speech-to-text#prompting).
     * For `gpt-4o-transcribe` models, the prompt is a free text string, for example
     * "expect words related to technology".
     */
    prompt?: string;
  }

  export interface Tool {
    /**
     * The description of the function, including guidance on when and how to call it,
     * and guidance about what to tell the user when calling (if anything).
     */
    description?: string;

    /**
     * The name of the function.
     */
    name?: string;

    /**
     * Parameters of the function in JSON Schema.
     */
    parameters?: unknown;

    /**
     * The type of the tool, i.e. `function`.
     */
    type?: 'function';
  }

  /**
   * Granular configuration for tracing.
   */
  export interface TracingConfiguration {
    /**
     * The group id to attach to this trace to enable filtering and grouping in the
     * traces dashboard.
     */
    group_id?: string;

    /**
     * The arbitrary metadata to attach to this trace to enable filtering in the traces
     * dashboard.
     */
    metadata?: unknown;

    /**
     * The name of the workflow to attach to this trace. This is used to name the trace
     * in the traces dashboard.
     */
    workflow_name?: string;
  }

  /**
   * Configuration for turn detection, ether Server VAD or Semantic VAD. This can be
   * set to `null` to turn off, in which case the client must manually trigger model
   * response. Server VAD means that the model will detect the start and end of
   * speech based on audio volume and respond at the end of user speech. Semantic VAD
   * is more advanced and uses a turn detection model (in conjunction with VAD) to
   * semantically estimate whether the user has finished speaking, then dynamically
   * sets a timeout based on this probability. For example, if user audio trails off
   * with "uhhm", the model will score a low probability of turn end and wait longer
   * for the user to continue speaking. This can be useful for more natural
   * conversations, but may have a higher latency.
   */
  export interface TurnDetection {
    /**
     * Whether or not to automatically generate a response when a VAD stop event
     * occurs.
     */
    create_response?: boolean;

    /**
     * Used only for `semantic_vad` mode. The eagerness of the model to respond. `low`
     * will wait longer for the user to continue speaking, `high` will respond more
     * quickly. `auto` is the default and is equivalent to `medium`.
     */
    eagerness?: 'low' | 'medium' | 'high' | 'auto';

    /**
     * Whether or not to automatically interrupt any ongoing response with output to
     * the default conversation (i.e. `conversation` of `auto`) when a VAD start event
     * occurs.
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

    /**
     * Type of turn detection.
     */
    type?: 'server_vad' | 'semantic_vad';
  }
}

/**
 * A new Realtime session configuration, with an ephemeral key. Default TTL for
 * keys is one minute.
 */
export interface SessionCreateResponse {
  /**
   * Ephemeral key returned by the API.
   */
  client_secret: SessionCreateResponse.ClientSecret;

  /**
   * The format of input audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`.
   */
  input_audio_format?: string;

  /**
   * Configuration for input audio transcription, defaults to off and can be set to
   * `null` to turn off once on. Input audio transcription is not native to the
   * model, since the model consumes audio directly. Transcription runs
   * asynchronously and should be treated as rough guidance rather than the
   * representation understood by the model.
   */
  input_audio_transcription?: SessionCreateResponse.InputAudioTranscription;

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
  max_response_output_tokens?: number | 'inf';

  /**
   * The set of modalities the model can respond with. To disable audio, set this to
   * ["text"].
   */
  modalities?: Array<'text' | 'audio'>;

  /**
   * The format of output audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`.
   */
  output_audio_format?: string;

  /**
   * The speed of the model's spoken response. 1.0 is the default speed. 0.25 is the
   * minimum speed. 1.5 is the maximum speed. This value can only be changed in
   * between model turns, not while a response is in progress.
   */
  speed?: number;

  /**
   * Sampling temperature for the model, limited to [0.6, 1.2]. Defaults to 0.8.
   */
  temperature?: number;

  /**
   * How the model chooses tools. Options are `auto`, `none`, `required`, or specify
   * a function.
   */
  tool_choice?: string;

  /**
   * Tools (functions) available to the model.
   */
  tools?: Array<SessionCreateResponse.Tool>;

  /**
   * Configuration options for tracing. Set to null to disable tracing. Once tracing
   * is enabled for a session, the configuration cannot be modified.
   *
   * `auto` will create a trace for the session with default values for the workflow
   * name, group id, and metadata.
   */
  tracing?: 'auto' | SessionCreateResponse.TracingConfiguration;

  /**
   * Configuration for turn detection. Can be set to `null` to turn off. Server VAD
   * means that the model will detect the start and end of speech based on audio
   * volume and respond at the end of user speech.
   */
  turn_detection?: SessionCreateResponse.TurnDetection;

  /**
   * The voice the model uses to respond. Voice cannot be changed during the session
   * once the model has responded with audio at least once. Current voice options are
   * `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, and `verse`.
   */
  voice?: (string & {}) | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse';
}

export namespace SessionCreateResponse {
  /**
   * Ephemeral key returned by the API.
   */
  export interface ClientSecret {
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
   * Configuration for input audio transcription, defaults to off and can be set to
   * `null` to turn off once on. Input audio transcription is not native to the
   * model, since the model consumes audio directly. Transcription runs
   * asynchronously and should be treated as rough guidance rather than the
   * representation understood by the model.
   */
  export interface InputAudioTranscription {
    /**
     * The model to use for transcription.
     */
    model?: string;
  }

  export interface Tool {
    /**
     * The description of the function, including guidance on when and how to call it,
     * and guidance about what to tell the user when calling (if anything).
     */
    description?: string;

    /**
     * The name of the function.
     */
    name?: string;

    /**
     * Parameters of the function in JSON Schema.
     */
    parameters?: unknown;

    /**
     * The type of the tool, i.e. `function`.
     */
    type?: 'function';
  }

  /**
   * Granular configuration for tracing.
   */
  export interface TracingConfiguration {
    /**
     * The group id to attach to this trace to enable filtering and grouping in the
     * traces dashboard.
     */
    group_id?: string;

    /**
     * The arbitrary metadata to attach to this trace to enable filtering in the traces
     * dashboard.
     */
    metadata?: unknown;

    /**
     * The name of the workflow to attach to this trace. This is used to name the trace
     * in the traces dashboard.
     */
    workflow_name?: string;
  }

  /**
   * Configuration for turn detection. Can be set to `null` to turn off. Server VAD
   * means that the model will detect the start and end of speech based on audio
   * volume and respond at the end of user speech.
   */
  export interface TurnDetection {
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
}

export interface SessionCreateParams {
  /**
   * Configuration options for the generated client secret.
   */
  client_secret?: SessionCreateParams.ClientSecret;

  /**
   * The format of input audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`. For
   * `pcm16`, input audio must be 16-bit PCM at a 24kHz sample rate, single channel
   * (mono), and little-endian byte order.
   */
  input_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';

  /**
   * Configuration for input audio noise reduction. This can be set to `null` to turn
   * off. Noise reduction filters audio added to the input audio buffer before it is
   * sent to VAD and the model. Filtering the audio can improve VAD and turn
   * detection accuracy (reducing false positives) and model performance by improving
   * perception of the input audio.
   */
  input_audio_noise_reduction?: SessionCreateParams.InputAudioNoiseReduction;

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
  input_audio_transcription?: SessionCreateParams.InputAudioTranscription;

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
  max_response_output_tokens?: number | 'inf';

  /**
   * The set of modalities the model can respond with. To disable audio, set this to
   * ["text"].
   */
  modalities?: Array<'text' | 'audio'>;

  /**
   * The Realtime model used for this session.
   */
  model?:
    | 'gpt-4o-realtime-preview'
    | 'gpt-4o-realtime-preview-2024-10-01'
    | 'gpt-4o-realtime-preview-2024-12-17'
    | 'gpt-4o-realtime-preview-2025-06-03'
    | 'gpt-4o-mini-realtime-preview'
    | 'gpt-4o-mini-realtime-preview-2024-12-17';

  /**
   * The format of output audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`.
   * For `pcm16`, output audio is sampled at a rate of 24kHz.
   */
  output_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';

  /**
   * The speed of the model's spoken response. 1.0 is the default speed. 0.25 is the
   * minimum speed. 1.5 is the maximum speed. This value can only be changed in
   * between model turns, not while a response is in progress.
   */
  speed?: number;

  /**
   * Sampling temperature for the model, limited to [0.6, 1.2]. For audio models a
   * temperature of 0.8 is highly recommended for best performance.
   */
  temperature?: number;

  /**
   * How the model chooses tools. Options are `auto`, `none`, `required`, or specify
   * a function.
   */
  tool_choice?: string;

  /**
   * Tools (functions) available to the model.
   */
  tools?: Array<SessionCreateParams.Tool>;

  /**
   * Configuration options for tracing. Set to null to disable tracing. Once tracing
   * is enabled for a session, the configuration cannot be modified.
   *
   * `auto` will create a trace for the session with default values for the workflow
   * name, group id, and metadata.
   */
  tracing?: 'auto' | SessionCreateParams.TracingConfiguration;

  /**
   * Configuration for turn detection, ether Server VAD or Semantic VAD. This can be
   * set to `null` to turn off, in which case the client must manually trigger model
   * response. Server VAD means that the model will detect the start and end of
   * speech based on audio volume and respond at the end of user speech. Semantic VAD
   * is more advanced and uses a turn detection model (in conjunction with VAD) to
   * semantically estimate whether the user has finished speaking, then dynamically
   * sets a timeout based on this probability. For example, if user audio trails off
   * with "uhhm", the model will score a low probability of turn end and wait longer
   * for the user to continue speaking. This can be useful for more natural
   * conversations, but may have a higher latency.
   */
  turn_detection?: SessionCreateParams.TurnDetection;

  /**
   * The voice the model uses to respond. Voice cannot be changed during the session
   * once the model has responded with audio at least once. Current voice options are
   * `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, and `verse`.
   */
  voice?: (string & {}) | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse';
}

export namespace SessionCreateParams {
  /**
   * Configuration options for the generated client secret.
   */
  export interface ClientSecret {
    /**
     * Configuration for the ephemeral token expiration.
     */
    expires_after?: ClientSecret.ExpiresAfter;
  }

  export namespace ClientSecret {
    /**
     * Configuration for the ephemeral token expiration.
     */
    export interface ExpiresAfter {
      /**
       * The anchor point for the ephemeral token expiration. Only `created_at` is
       * currently supported.
       */
      anchor: 'created_at';

      /**
       * The number of seconds from the anchor point to the expiration. Select a value
       * between `10` and `7200`.
       */
      seconds?: number;
    }
  }

  /**
   * Configuration for input audio noise reduction. This can be set to `null` to turn
   * off. Noise reduction filters audio added to the input audio buffer before it is
   * sent to VAD and the model. Filtering the audio can improve VAD and turn
   * detection accuracy (reducing false positives) and model performance by improving
   * perception of the input audio.
   */
  export interface InputAudioNoiseReduction {
    /**
     * Type of noise reduction. `near_field` is for close-talking microphones such as
     * headphones, `far_field` is for far-field microphones such as laptop or
     * conference room microphones.
     */
    type?: 'near_field' | 'far_field';
  }

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
  export interface InputAudioTranscription {
    /**
     * The language of the input audio. Supplying the input language in
     * [ISO-639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) (e.g. `en`)
     * format will improve accuracy and latency.
     */
    language?: string;

    /**
     * The model to use for transcription, current options are `gpt-4o-transcribe`,
     * `gpt-4o-mini-transcribe`, and `whisper-1`.
     */
    model?: string;

    /**
     * An optional text to guide the model's style or continue a previous audio
     * segment. For `whisper-1`, the
     * [prompt is a list of keywords](https://platform.openai.com/docs/guides/speech-to-text#prompting).
     * For `gpt-4o-transcribe` models, the prompt is a free text string, for example
     * "expect words related to technology".
     */
    prompt?: string;
  }

  export interface Tool {
    /**
     * The description of the function, including guidance on when and how to call it,
     * and guidance about what to tell the user when calling (if anything).
     */
    description?: string;

    /**
     * The name of the function.
     */
    name?: string;

    /**
     * Parameters of the function in JSON Schema.
     */
    parameters?: unknown;

    /**
     * The type of the tool, i.e. `function`.
     */
    type?: 'function';
  }

  /**
   * Granular configuration for tracing.
   */
  export interface TracingConfiguration {
    /**
     * The group id to attach to this trace to enable filtering and grouping in the
     * traces dashboard.
     */
    group_id?: string;

    /**
     * The arbitrary metadata to attach to this trace to enable filtering in the traces
     * dashboard.
     */
    metadata?: unknown;

    /**
     * The name of the workflow to attach to this trace. This is used to name the trace
     * in the traces dashboard.
     */
    workflow_name?: string;
  }

  /**
   * Configuration for turn detection, ether Server VAD or Semantic VAD. This can be
   * set to `null` to turn off, in which case the client must manually trigger model
   * response. Server VAD means that the model will detect the start and end of
   * speech based on audio volume and respond at the end of user speech. Semantic VAD
   * is more advanced and uses a turn detection model (in conjunction with VAD) to
   * semantically estimate whether the user has finished speaking, then dynamically
   * sets a timeout based on this probability. For example, if user audio trails off
   * with "uhhm", the model will score a low probability of turn end and wait longer
   * for the user to continue speaking. This can be useful for more natural
   * conversations, but may have a higher latency.
   */
  export interface TurnDetection {
    /**
     * Whether or not to automatically generate a response when a VAD stop event
     * occurs.
     */
    create_response?: boolean;

    /**
     * Used only for `semantic_vad` mode. The eagerness of the model to respond. `low`
     * will wait longer for the user to continue speaking, `high` will respond more
     * quickly. `auto` is the default and is equivalent to `medium`.
     */
    eagerness?: 'low' | 'medium' | 'high' | 'auto';

    /**
     * Whether or not to automatically interrupt any ongoing response with output to
     * the default conversation (i.e. `conversation` of `auto`) when a VAD start event
     * occurs.
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

    /**
     * Type of turn detection.
     */
    type?: 'server_vad' | 'semantic_vad';
  }
}

export declare namespace Sessions {
  export {
    type Session as Session,
    type SessionCreateResponse as SessionCreateResponse,
    type SessionCreateParams as SessionCreateParams,
  };
}
