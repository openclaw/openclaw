import { APIResource } from "../../core/resource.mjs";
import * as SpeechAPI from "./speech.mjs";
import { Speech, SpeechCreateParams, SpeechModel } from "./speech.mjs";
import * as TranscriptionsAPI from "./transcriptions.mjs";
import { Transcription, TranscriptionCreateParams, TranscriptionCreateParamsNonStreaming, TranscriptionCreateParamsStreaming, TranscriptionCreateResponse, TranscriptionDiarized, TranscriptionDiarizedSegment, TranscriptionInclude, TranscriptionSegment, TranscriptionStreamEvent, TranscriptionTextDeltaEvent, TranscriptionTextDoneEvent, TranscriptionTextSegmentEvent, TranscriptionVerbose, TranscriptionWord, Transcriptions } from "./transcriptions.mjs";
import * as TranslationsAPI from "./translations.mjs";
import { Translation, TranslationCreateParams, TranslationCreateResponse, TranslationVerbose, Translations } from "./translations.mjs";
export declare class Audio extends APIResource {
    transcriptions: TranscriptionsAPI.Transcriptions;
    translations: TranslationsAPI.Translations;
    speech: SpeechAPI.Speech;
}
export type AudioModel = 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' | 'gpt-4o-mini-transcribe-2025-12-15' | 'gpt-4o-transcribe-diarize';
/**
 * The format of the output, in one of these options: `json`, `text`, `srt`,
 * `verbose_json`, `vtt`, or `diarized_json`. For `gpt-4o-transcribe` and
 * `gpt-4o-mini-transcribe`, the only supported format is `json`. For
 * `gpt-4o-transcribe-diarize`, the supported formats are `json`, `text`, and
 * `diarized_json`, with `diarized_json` required to receive speaker annotations.
 */
export type AudioResponseFormat = 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json';
export declare namespace Audio {
    export { type AudioModel as AudioModel, type AudioResponseFormat as AudioResponseFormat };
    export { Transcriptions as Transcriptions, type Transcription as Transcription, type TranscriptionDiarized as TranscriptionDiarized, type TranscriptionDiarizedSegment as TranscriptionDiarizedSegment, type TranscriptionInclude as TranscriptionInclude, type TranscriptionSegment as TranscriptionSegment, type TranscriptionStreamEvent as TranscriptionStreamEvent, type TranscriptionTextDeltaEvent as TranscriptionTextDeltaEvent, type TranscriptionTextDoneEvent as TranscriptionTextDoneEvent, type TranscriptionTextSegmentEvent as TranscriptionTextSegmentEvent, type TranscriptionVerbose as TranscriptionVerbose, type TranscriptionWord as TranscriptionWord, type TranscriptionCreateResponse as TranscriptionCreateResponse, type TranscriptionCreateParams as TranscriptionCreateParams, type TranscriptionCreateParamsNonStreaming as TranscriptionCreateParamsNonStreaming, type TranscriptionCreateParamsStreaming as TranscriptionCreateParamsStreaming, };
    export { Translations as Translations, type Translation as Translation, type TranslationVerbose as TranslationVerbose, type TranslationCreateResponse as TranslationCreateResponse, type TranslationCreateParams as TranslationCreateParams, };
    export { Speech as Speech, type SpeechModel as SpeechModel, type SpeechCreateParams as SpeechCreateParams };
}
//# sourceMappingURL=audio.d.mts.map