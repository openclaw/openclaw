import { APIResource } from "../../core/resource.js";
import * as AudioAPI from "./audio.js";
import * as TranscriptionsAPI from "./transcriptions.js";
import { APIPromise } from "../../core/api-promise.js";
import { type Uploadable } from "../../core/uploads.js";
import { RequestOptions } from "../../internal/request-options.js";
/**
 * Turn audio into text or text into audio.
 */
export declare class Translations extends APIResource {
    /**
     * Translates audio into English.
     *
     * @example
     * ```ts
     * const translation = await client.audio.translations.create({
     *   file: fs.createReadStream('speech.mp3'),
     *   model: 'whisper-1',
     * });
     * ```
     */
    create(body: TranslationCreateParams<'json' | undefined>, options?: RequestOptions): APIPromise<Translation>;
    create(body: TranslationCreateParams<'verbose_json'>, options?: RequestOptions): APIPromise<TranslationVerbose>;
    create(body: TranslationCreateParams<'text' | 'srt' | 'vtt'>, options?: RequestOptions): APIPromise<string>;
    create(body: TranslationCreateParams, options?: RequestOptions): APIPromise<Translation>;
}
export interface Translation {
    text: string;
}
export interface TranslationVerbose {
    /**
     * The duration of the input audio.
     */
    duration: number;
    /**
     * The language of the output translation (always `english`).
     */
    language: string;
    /**
     * The translated text.
     */
    text: string;
    /**
     * Segments of the translated text and their corresponding details.
     */
    segments?: Array<TranscriptionsAPI.TranscriptionSegment>;
}
export type TranslationCreateResponse = Translation | TranslationVerbose;
export interface TranslationCreateParams<ResponseFormat extends AudioAPI.AudioResponseFormat | undefined = AudioAPI.AudioResponseFormat | undefined> {
    /**
     * The audio file object (not file name) translate, in one of these formats: flac,
     * mp3, mp4, mpeg, mpga, m4a, ogg, wav, or webm.
     */
    file: Uploadable;
    /**
     * ID of the model to use. Only `whisper-1` (which is powered by our open source
     * Whisper V2 model) is currently available.
     */
    model: (string & {}) | AudioAPI.AudioModel;
    /**
     * An optional text to guide the model's style or continue a previous audio
     * segment. The
     * [prompt](https://platform.openai.com/docs/guides/speech-to-text#prompting)
     * should be in English.
     */
    prompt?: string;
    /**
     * The format of the output, in one of these options: `json`, `text`, `srt`,
     * `verbose_json`, or `vtt`.
     */
    response_format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
    /**
     * The sampling temperature, between 0 and 1. Higher values like 0.8 will make the
     * output more random, while lower values like 0.2 will make it more focused and
     * deterministic. If set to 0, the model will use
     * [log probability](https://en.wikipedia.org/wiki/Log_probability) to
     * automatically increase the temperature until certain thresholds are hit.
     */
    temperature?: number;
}
export declare namespace Translations {
    export { type Translation as Translation, type TranslationVerbose as TranslationVerbose, type TranslationCreateResponse as TranslationCreateResponse, type TranslationCreateParams as TranslationCreateParams, };
}
//# sourceMappingURL=translations.d.ts.map