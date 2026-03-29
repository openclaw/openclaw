import { APIResource } from "../../../core/resource.js";
import { APIPromise } from "../../../core/api-promise.js";
import { RequestOptions } from "../../../internal/request-options.js";
export declare class TranscriptionSessions extends APIResource {
    /**
     * Create an ephemeral API token for use in client-side applications with the
     * Realtime API specifically for realtime transcriptions. Can be configured with
     * the same session parameters as the `transcription_session.update` client event.
     *
     * It responds with a session object, plus a `client_secret` key which contains a
     * usable ephemeral API token that can be used to authenticate browser clients for
     * the Realtime API.
     *
     * @example
     * ```ts
     * const transcriptionSession =
     *   await client.beta.realtime.transcriptionSessions.create();
     * ```
     */
    create(body: TranscriptionSessionCreateParams, options?: RequestOptions): APIPromise<TranscriptionSession>;
}
/**
 * A new Realtime transcription session configuration.
 *
 * When a session is created on the server via REST API, the session object also
 * contains an ephemeral key. Default TTL for keys is 10 minutes. This property is
 * not present when a session is updated via the WebSocket API.
 */
export interface TranscriptionSession {
    /**
     * Ephemeral key returned by the API. Only present when the session is created on
     * the server via REST API.
     */
    client_secret: TranscriptionSession.ClientSecret;
    /**
     * The format of input audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`.
     */
    input_audio_format?: string;
    /**
     * Configuration of the transcription model.
     */
    input_audio_transcription?: TranscriptionSession.InputAudioTranscription;
    /**
     * The set of modalities the model can respond with. To disable audio, set this to
     * ["text"].
     */
    modalities?: Array<'text' | 'audio'>;
    /**
     * Configuration for turn detection. Can be set to `null` to turn off. Server VAD
     * means that the model will detect the start and end of speech based on audio
     * volume and respond at the end of user speech.
     */
    turn_detection?: TranscriptionSession.TurnDetection;
}
export declare namespace TranscriptionSession {
    /**
     * Ephemeral key returned by the API. Only present when the session is created on
     * the server via REST API.
     */
    interface ClientSecret {
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
     * Configuration of the transcription model.
     */
    interface InputAudioTranscription {
        /**
         * The language of the input audio. Supplying the input language in
         * [ISO-639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) (e.g. `en`)
         * format will improve accuracy and latency.
         */
        language?: string;
        /**
         * The model to use for transcription. Can be `gpt-4o-transcribe`,
         * `gpt-4o-mini-transcribe`, or `whisper-1`.
         */
        model?: 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' | 'whisper-1';
        /**
         * An optional text to guide the model's style or continue a previous audio
         * segment. The
         * [prompt](https://platform.openai.com/docs/guides/speech-to-text#prompting)
         * should match the audio language.
         */
        prompt?: string;
    }
    /**
     * Configuration for turn detection. Can be set to `null` to turn off. Server VAD
     * means that the model will detect the start and end of speech based on audio
     * volume and respond at the end of user speech.
     */
    interface TurnDetection {
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
export interface TranscriptionSessionCreateParams {
    /**
     * Configuration options for the generated client secret.
     */
    client_secret?: TranscriptionSessionCreateParams.ClientSecret;
    /**
     * The set of items to include in the transcription. Current available items are:
     *
     * - `item.input_audio_transcription.logprobs`
     */
    include?: Array<string>;
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
    input_audio_noise_reduction?: TranscriptionSessionCreateParams.InputAudioNoiseReduction;
    /**
     * Configuration for input audio transcription. The client can optionally set the
     * language and prompt for transcription, these offer additional guidance to the
     * transcription service.
     */
    input_audio_transcription?: TranscriptionSessionCreateParams.InputAudioTranscription;
    /**
     * The set of modalities the model can respond with. To disable audio, set this to
     * ["text"].
     */
    modalities?: Array<'text' | 'audio'>;
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
    turn_detection?: TranscriptionSessionCreateParams.TurnDetection;
}
export declare namespace TranscriptionSessionCreateParams {
    /**
     * Configuration options for the generated client secret.
     */
    interface ClientSecret {
        /**
         * Configuration for the ephemeral token expiration.
         */
        expires_at?: ClientSecret.ExpiresAt;
    }
    namespace ClientSecret {
        /**
         * Configuration for the ephemeral token expiration.
         */
        interface ExpiresAt {
            /**
             * The anchor point for the ephemeral token expiration. Only `created_at` is
             * currently supported.
             */
            anchor?: 'created_at';
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
    interface InputAudioNoiseReduction {
        /**
         * Type of noise reduction. `near_field` is for close-talking microphones such as
         * headphones, `far_field` is for far-field microphones such as laptop or
         * conference room microphones.
         */
        type?: 'near_field' | 'far_field';
    }
    /**
     * Configuration for input audio transcription. The client can optionally set the
     * language and prompt for transcription, these offer additional guidance to the
     * transcription service.
     */
    interface InputAudioTranscription {
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
        model?: 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' | 'whisper-1';
        /**
         * An optional text to guide the model's style or continue a previous audio
         * segment. For `whisper-1`, the
         * [prompt is a list of keywords](https://platform.openai.com/docs/guides/speech-to-text#prompting).
         * For `gpt-4o-transcribe` models, the prompt is a free text string, for example
         * "expect words related to technology".
         */
        prompt?: string;
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
    interface TurnDetection {
        /**
         * Whether or not to automatically generate a response when a VAD stop event
         * occurs. Not available for transcription sessions.
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
         * occurs. Not available for transcription sessions.
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
export declare namespace TranscriptionSessions {
    export { type TranscriptionSession as TranscriptionSession, type TranscriptionSessionCreateParams as TranscriptionSessionCreateParams, };
}
//# sourceMappingURL=transcription-sessions.d.ts.map