// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as SpeechAPI from './speech';
import { Speech, SpeechCreateParams, SpeechModel } from './speech';
import * as TranscriptionsAPI from './transcriptions';
import {
  Transcription,
  TranscriptionCreateParams,
  TranscriptionCreateParamsNonStreaming,
  TranscriptionCreateParamsStreaming,
  TranscriptionCreateResponse,
  TranscriptionDiarized,
  TranscriptionDiarizedSegment,
  TranscriptionInclude,
  TranscriptionSegment,
  TranscriptionStreamEvent,
  TranscriptionTextDeltaEvent,
  TranscriptionTextDoneEvent,
  TranscriptionTextSegmentEvent,
  TranscriptionVerbose,
  TranscriptionWord,
  Transcriptions,
} from './transcriptions';
import * as TranslationsAPI from './translations';
import {
  Translation,
  TranslationCreateParams,
  TranslationCreateResponse,
  TranslationVerbose,
  Translations,
} from './translations';

export class Audio extends APIResource {
  transcriptions: TranscriptionsAPI.Transcriptions = new TranscriptionsAPI.Transcriptions(this._client);
  translations: TranslationsAPI.Translations = new TranslationsAPI.Translations(this._client);
  speech: SpeechAPI.Speech = new SpeechAPI.Speech(this._client);
}

export type AudioModel =
  | 'whisper-1'
  | 'gpt-4o-transcribe'
  | 'gpt-4o-mini-transcribe'
  | 'gpt-4o-mini-transcribe-2025-12-15'
  | 'gpt-4o-transcribe-diarize';

/**
 * The format of the output, in one of these options: `json`, `text`, `srt`,
 * `verbose_json`, `vtt`, or `diarized_json`. For `gpt-4o-transcribe` and
 * `gpt-4o-mini-transcribe`, the only supported format is `json`. For
 * `gpt-4o-transcribe-diarize`, the supported formats are `json`, `text`, and
 * `diarized_json`, with `diarized_json` required to receive speaker annotations.
 */
export type AudioResponseFormat = 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json';

Audio.Transcriptions = Transcriptions;
Audio.Translations = Translations;
Audio.Speech = Speech;

export declare namespace Audio {
  export { type AudioModel as AudioModel, type AudioResponseFormat as AudioResponseFormat };

  export {
    Transcriptions as Transcriptions,
    type Transcription as Transcription,
    type TranscriptionDiarized as TranscriptionDiarized,
    type TranscriptionDiarizedSegment as TranscriptionDiarizedSegment,
    type TranscriptionInclude as TranscriptionInclude,
    type TranscriptionSegment as TranscriptionSegment,
    type TranscriptionStreamEvent as TranscriptionStreamEvent,
    type TranscriptionTextDeltaEvent as TranscriptionTextDeltaEvent,
    type TranscriptionTextDoneEvent as TranscriptionTextDoneEvent,
    type TranscriptionTextSegmentEvent as TranscriptionTextSegmentEvent,
    type TranscriptionVerbose as TranscriptionVerbose,
    type TranscriptionWord as TranscriptionWord,
    type TranscriptionCreateResponse as TranscriptionCreateResponse,
    type TranscriptionCreateParams as TranscriptionCreateParams,
    type TranscriptionCreateParamsNonStreaming as TranscriptionCreateParamsNonStreaming,
    type TranscriptionCreateParamsStreaming as TranscriptionCreateParamsStreaming,
  };

  export {
    Translations as Translations,
    type Translation as Translation,
    type TranslationVerbose as TranslationVerbose,
    type TranslationCreateResponse as TranslationCreateResponse,
    type TranslationCreateParams as TranslationCreateParams,
  };

  export { Speech as Speech, type SpeechModel as SpeechModel, type SpeechCreateParams as SpeechCreateParams };
}
