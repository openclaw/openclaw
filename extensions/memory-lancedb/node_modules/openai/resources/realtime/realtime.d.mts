import { APIResource } from "../../core/resource.mjs";
import * as RealtimeAPI from "./realtime.mjs";
import * as Shared from "../shared.mjs";
import * as CallsAPI from "./calls.mjs";
import { CallAcceptParams, CallReferParams, CallRejectParams, Calls } from "./calls.mjs";
import * as ClientSecretsAPI from "./client-secrets.mjs";
import { ClientSecretCreateParams, ClientSecretCreateResponse, ClientSecrets, RealtimeSessionClientSecret, RealtimeSessionCreateResponse, RealtimeTranscriptionSessionCreateResponse, RealtimeTranscriptionSessionTurnDetection } from "./client-secrets.mjs";
import * as ResponsesAPI from "../responses/responses.mjs";
export declare class Realtime extends APIResource {
    clientSecrets: ClientSecretsAPI.ClientSecrets;
    calls: CallsAPI.Calls;
}
export interface AudioTranscription {
    /**
     * The language of the input audio. Supplying the input language in
     * [ISO-639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) (e.g. `en`)
     * format will improve accuracy and latency.
     */
    language?: string;
    /**
     * The model to use for transcription. Current options are `whisper-1`,
     * `gpt-4o-mini-transcribe`, `gpt-4o-mini-transcribe-2025-12-15`,
     * `gpt-4o-transcribe`, and `gpt-4o-transcribe-diarize`. Use
     * `gpt-4o-transcribe-diarize` when you need diarization with speaker labels.
     */
    model?: (string & {}) | 'whisper-1' | 'gpt-4o-mini-transcribe' | 'gpt-4o-mini-transcribe-2025-12-15' | 'gpt-4o-transcribe' | 'gpt-4o-transcribe-diarize';
    /**
     * An optional text to guide the model's style or continue a previous audio
     * segment. For `whisper-1`, the
     * [prompt is a list of keywords](https://platform.openai.com/docs/guides/speech-to-text#prompting).
     * For `gpt-4o-transcribe` models (excluding `gpt-4o-transcribe-diarize`), the
     * prompt is a free text string, for example "expect words related to technology".
     */
    prompt?: string;
}
/**
 * Returned when a conversation is created. Emitted right after session creation.
 */
export interface ConversationCreatedEvent {
    /**
     * The conversation resource.
     */
    conversation: ConversationCreatedEvent.Conversation;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The event type, must be `conversation.created`.
     */
    type: 'conversation.created';
}
export declare namespace ConversationCreatedEvent {
    /**
     * The conversation resource.
     */
    interface Conversation {
        /**
         * The unique ID of the conversation.
         */
        id?: string;
        /**
         * The object type, must be `realtime.conversation`.
         */
        object?: 'realtime.conversation';
    }
}
/**
 * A single item within a Realtime conversation.
 */
export type ConversationItem = RealtimeConversationItemSystemMessage | RealtimeConversationItemUserMessage | RealtimeConversationItemAssistantMessage | RealtimeConversationItemFunctionCall | RealtimeConversationItemFunctionCallOutput | RealtimeMcpApprovalResponse | RealtimeMcpListTools | RealtimeMcpToolCall | RealtimeMcpApprovalRequest;
/**
 * Sent by the server when an Item is added to the default Conversation. This can
 * happen in several cases:
 *
 * - When the client sends a `conversation.item.create` event.
 * - When the input audio buffer is committed. In this case the item will be a user
 *   message containing the audio from the buffer.
 * - When the model is generating a Response. In this case the
 *   `conversation.item.added` event will be sent when the model starts generating
 *   a specific Item, and thus it will not yet have any content (and `status` will
 *   be `in_progress`).
 *
 * The event will include the full content of the Item (except when model is
 * generating a Response) except for audio data, which can be retrieved separately
 * with a `conversation.item.retrieve` event if necessary.
 */
export interface ConversationItemAdded {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * A single item within a Realtime conversation.
     */
    item: ConversationItem;
    /**
     * The event type, must be `conversation.item.added`.
     */
    type: 'conversation.item.added';
    /**
     * The ID of the item that precedes this one, if any. This is used to maintain
     * ordering when items are inserted.
     */
    previous_item_id?: string | null;
}
/**
 * Add a new Item to the Conversation's context, including messages, function
 * calls, and function call responses. This event can be used both to populate a
 * "history" of the conversation and to add new items mid-stream, but has the
 * current limitation that it cannot populate assistant audio messages.
 *
 * If successful, the server will respond with a `conversation.item.created` event,
 * otherwise an `error` event will be sent.
 */
export interface ConversationItemCreateEvent {
    /**
     * A single item within a Realtime conversation.
     */
    item: ConversationItem;
    /**
     * The event type, must be `conversation.item.create`.
     */
    type: 'conversation.item.create';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
    /**
     * The ID of the preceding item after which the new item will be inserted. If not
     * set, the new item will be appended to the end of the conversation.
     *
     * If set to `root`, the new item will be added to the beginning of the
     * conversation.
     *
     * If set to an existing ID, it allows an item to be inserted mid-conversation. If
     * the ID cannot be found, an error will be returned and the item will not be
     * added.
     */
    previous_item_id?: string;
}
/**
 * Returned when a conversation item is created. There are several scenarios that
 * produce this event:
 *
 * - The server is generating a Response, which if successful will produce either
 *   one or two Items, which will be of type `message` (role `assistant`) or type
 *   `function_call`.
 * - The input audio buffer has been committed, either by the client or the server
 *   (in `server_vad` mode). The server will take the content of the input audio
 *   buffer and add it to a new user message Item.
 * - The client has sent a `conversation.item.create` event to add a new Item to
 *   the Conversation.
 */
export interface ConversationItemCreatedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * A single item within a Realtime conversation.
     */
    item: ConversationItem;
    /**
     * The event type, must be `conversation.item.created`.
     */
    type: 'conversation.item.created';
    /**
     * The ID of the preceding item in the Conversation context, allows the client to
     * understand the order of the conversation. Can be `null` if the item has no
     * predecessor.
     */
    previous_item_id?: string | null;
}
/**
 * Send this event when you want to remove any item from the conversation history.
 * The server will respond with a `conversation.item.deleted` event, unless the
 * item does not exist in the conversation history, in which case the server will
 * respond with an error.
 */
export interface ConversationItemDeleteEvent {
    /**
     * The ID of the item to delete.
     */
    item_id: string;
    /**
     * The event type, must be `conversation.item.delete`.
     */
    type: 'conversation.item.delete';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
}
/**
 * Returned when an item in the conversation is deleted by the client with a
 * `conversation.item.delete` event. This event is used to synchronize the server's
 * understanding of the conversation history with the client's view.
 */
export interface ConversationItemDeletedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item that was deleted.
     */
    item_id: string;
    /**
     * The event type, must be `conversation.item.deleted`.
     */
    type: 'conversation.item.deleted';
}
/**
 * Returned when a conversation item is finalized.
 *
 * The event will include the full content of the Item except for audio data, which
 * can be retrieved separately with a `conversation.item.retrieve` event if needed.
 */
export interface ConversationItemDone {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * A single item within a Realtime conversation.
     */
    item: ConversationItem;
    /**
     * The event type, must be `conversation.item.done`.
     */
    type: 'conversation.item.done';
    /**
     * The ID of the item that precedes this one, if any. This is used to maintain
     * ordering when items are inserted.
     */
    previous_item_id?: string | null;
}
/**
 * This event is the output of audio transcription for user audio written to the
 * user audio buffer. Transcription begins when the input audio buffer is committed
 * by the client or server (when VAD is enabled). Transcription runs asynchronously
 * with Response creation, so this event may come before or after the Response
 * events.
 *
 * Realtime API models accept audio natively, and thus input transcription is a
 * separate process run on a separate ASR (Automatic Speech Recognition) model. The
 * transcript may diverge somewhat from the model's interpretation, and should be
 * treated as a rough guide.
 */
export interface ConversationItemInputAudioTranscriptionCompletedEvent {
    /**
     * The index of the content part containing the audio.
     */
    content_index: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item containing the audio that is being transcribed.
     */
    item_id: string;
    /**
     * The transcribed text.
     */
    transcript: string;
    /**
     * The event type, must be `conversation.item.input_audio_transcription.completed`.
     */
    type: 'conversation.item.input_audio_transcription.completed';
    /**
     * Usage statistics for the transcription, this is billed according to the ASR
     * model's pricing rather than the realtime model's pricing.
     */
    usage: ConversationItemInputAudioTranscriptionCompletedEvent.TranscriptTextUsageTokens | ConversationItemInputAudioTranscriptionCompletedEvent.TranscriptTextUsageDuration;
    /**
     * The log probabilities of the transcription.
     */
    logprobs?: Array<LogProbProperties> | null;
}
export declare namespace ConversationItemInputAudioTranscriptionCompletedEvent {
    /**
     * Usage statistics for models billed by token usage.
     */
    interface TranscriptTextUsageTokens {
        /**
         * Number of input tokens billed for this request.
         */
        input_tokens: number;
        /**
         * Number of output tokens generated.
         */
        output_tokens: number;
        /**
         * Total number of tokens used (input + output).
         */
        total_tokens: number;
        /**
         * The type of the usage object. Always `tokens` for this variant.
         */
        type: 'tokens';
        /**
         * Details about the input tokens billed for this request.
         */
        input_token_details?: TranscriptTextUsageTokens.InputTokenDetails;
    }
    namespace TranscriptTextUsageTokens {
        /**
         * Details about the input tokens billed for this request.
         */
        interface InputTokenDetails {
            /**
             * Number of audio tokens billed for this request.
             */
            audio_tokens?: number;
            /**
             * Number of text tokens billed for this request.
             */
            text_tokens?: number;
        }
    }
    /**
     * Usage statistics for models billed by audio input duration.
     */
    interface TranscriptTextUsageDuration {
        /**
         * Duration of the input audio in seconds.
         */
        seconds: number;
        /**
         * The type of the usage object. Always `duration` for this variant.
         */
        type: 'duration';
    }
}
/**
 * Returned when the text value of an input audio transcription content part is
 * updated with incremental transcription results.
 */
export interface ConversationItemInputAudioTranscriptionDeltaEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item containing the audio that is being transcribed.
     */
    item_id: string;
    /**
     * The event type, must be `conversation.item.input_audio_transcription.delta`.
     */
    type: 'conversation.item.input_audio_transcription.delta';
    /**
     * The index of the content part in the item's content array.
     */
    content_index?: number;
    /**
     * The text delta.
     */
    delta?: string;
    /**
     * The log probabilities of the transcription. These can be enabled by
     * configurating the session with
     * `"include": ["item.input_audio_transcription.logprobs"]`. Each entry in the
     * array corresponds a log probability of which token would be selected for this
     * chunk of transcription. This can help to identify if it was possible there were
     * multiple valid options for a given chunk of transcription.
     */
    logprobs?: Array<LogProbProperties> | null;
}
/**
 * Returned when input audio transcription is configured, and a transcription
 * request for a user message failed. These events are separate from other `error`
 * events so that the client can identify the related Item.
 */
export interface ConversationItemInputAudioTranscriptionFailedEvent {
    /**
     * The index of the content part containing the audio.
     */
    content_index: number;
    /**
     * Details of the transcription error.
     */
    error: ConversationItemInputAudioTranscriptionFailedEvent.Error;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the user message item.
     */
    item_id: string;
    /**
     * The event type, must be `conversation.item.input_audio_transcription.failed`.
     */
    type: 'conversation.item.input_audio_transcription.failed';
}
export declare namespace ConversationItemInputAudioTranscriptionFailedEvent {
    /**
     * Details of the transcription error.
     */
    interface Error {
        /**
         * Error code, if any.
         */
        code?: string;
        /**
         * A human-readable error message.
         */
        message?: string;
        /**
         * Parameter related to the error, if any.
         */
        param?: string;
        /**
         * The type of error.
         */
        type?: string;
    }
}
/**
 * Returned when an input audio transcription segment is identified for an item.
 */
export interface ConversationItemInputAudioTranscriptionSegment {
    /**
     * The segment identifier.
     */
    id: string;
    /**
     * The index of the input audio content part within the item.
     */
    content_index: number;
    /**
     * End time of the segment in seconds.
     */
    end: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item containing the input audio content.
     */
    item_id: string;
    /**
     * The detected speaker label for this segment.
     */
    speaker: string;
    /**
     * Start time of the segment in seconds.
     */
    start: number;
    /**
     * The text for this segment.
     */
    text: string;
    /**
     * The event type, must be `conversation.item.input_audio_transcription.segment`.
     */
    type: 'conversation.item.input_audio_transcription.segment';
}
/**
 * Send this event when you want to retrieve the server's representation of a
 * specific item in the conversation history. This is useful, for example, to
 * inspect user audio after noise cancellation and VAD. The server will respond
 * with a `conversation.item.retrieved` event, unless the item does not exist in
 * the conversation history, in which case the server will respond with an error.
 */
export interface ConversationItemRetrieveEvent {
    /**
     * The ID of the item to retrieve.
     */
    item_id: string;
    /**
     * The event type, must be `conversation.item.retrieve`.
     */
    type: 'conversation.item.retrieve';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
}
/**
 * Send this event to truncate a previous assistant message’s audio. The server
 * will produce audio faster than realtime, so this event is useful when the user
 * interrupts to truncate audio that has already been sent to the client but not
 * yet played. This will synchronize the server's understanding of the audio with
 * the client's playback.
 *
 * Truncating audio will delete the server-side text transcript to ensure there is
 * not text in the context that hasn't been heard by the user.
 *
 * If successful, the server will respond with a `conversation.item.truncated`
 * event.
 */
export interface ConversationItemTruncateEvent {
    /**
     * Inclusive duration up to which audio is truncated, in milliseconds. If the
     * audio_end_ms is greater than the actual audio duration, the server will respond
     * with an error.
     */
    audio_end_ms: number;
    /**
     * The index of the content part to truncate. Set this to `0`.
     */
    content_index: number;
    /**
     * The ID of the assistant message item to truncate. Only assistant message items
     * can be truncated.
     */
    item_id: string;
    /**
     * The event type, must be `conversation.item.truncate`.
     */
    type: 'conversation.item.truncate';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
}
/**
 * Returned when an earlier assistant audio message item is truncated by the client
 * with a `conversation.item.truncate` event. This event is used to synchronize the
 * server's understanding of the audio with the client's playback.
 *
 * This action will truncate the audio and remove the server-side text transcript
 * to ensure there is no text in the context that hasn't been heard by the user.
 */
export interface ConversationItemTruncatedEvent {
    /**
     * The duration up to which the audio was truncated, in milliseconds.
     */
    audio_end_ms: number;
    /**
     * The index of the content part that was truncated.
     */
    content_index: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the assistant message item that was truncated.
     */
    item_id: string;
    /**
     * The event type, must be `conversation.item.truncated`.
     */
    type: 'conversation.item.truncated';
}
/**
 * The item to add to the conversation.
 */
export interface ConversationItemWithReference {
    /**
     * For an item of type (`message` | `function_call` | `function_call_output`) this
     * field allows the client to assign the unique ID of the item. It is not required
     * because the server will generate one if not provided.
     *
     * For an item of type `item_reference`, this field is required and is a reference
     * to any item that has previously existed in the conversation.
     */
    id?: string;
    /**
     * The arguments of the function call (for `function_call` items).
     */
    arguments?: string;
    /**
     * The ID of the function call (for `function_call` and `function_call_output`
     * items). If passed on a `function_call_output` item, the server will check that a
     * `function_call` item with the same ID exists in the conversation history.
     */
    call_id?: string;
    /**
     * The content of the message, applicable for `message` items.
     *
     * - Message items of role `system` support only `input_text` content
     * - Message items of role `user` support `input_text` and `input_audio` content
     * - Message items of role `assistant` support `text` content.
     */
    content?: Array<ConversationItemWithReference.Content>;
    /**
     * The name of the function being called (for `function_call` items).
     */
    name?: string;
    /**
     * Identifier for the API object being returned - always `realtime.item`.
     */
    object?: 'realtime.item';
    /**
     * The output of the function call (for `function_call_output` items).
     */
    output?: string;
    /**
     * The role of the message sender (`user`, `assistant`, `system`), only applicable
     * for `message` items.
     */
    role?: 'user' | 'assistant' | 'system';
    /**
     * The status of the item (`completed`, `incomplete`, `in_progress`). These have no
     * effect on the conversation, but are accepted for consistency with the
     * `conversation.item.created` event.
     */
    status?: 'completed' | 'incomplete' | 'in_progress';
    /**
     * The type of the item (`message`, `function_call`, `function_call_output`,
     * `item_reference`).
     */
    type?: 'message' | 'function_call' | 'function_call_output' | 'item_reference';
}
export declare namespace ConversationItemWithReference {
    interface Content {
        /**
         * ID of a previous conversation item to reference (for `item_reference` content
         * types in `response.create` events). These can reference both client and server
         * created items.
         */
        id?: string;
        /**
         * Base64-encoded audio bytes, used for `input_audio` content type.
         */
        audio?: string;
        /**
         * The text content, used for `input_text` and `text` content types.
         */
        text?: string;
        /**
         * The transcript of the audio, used for `input_audio` content type.
         */
        transcript?: string;
        /**
         * The content type (`input_text`, `input_audio`, `item_reference`, `text`).
         */
        type?: 'input_text' | 'input_audio' | 'item_reference' | 'text';
    }
}
/**
 * Send this event to append audio bytes to the input audio buffer. The audio
 * buffer is temporary storage you can write to and later commit. A "commit" will
 * create a new user message item in the conversation history from the buffer
 * content and clear the buffer. Input audio transcription (if enabled) will be
 * generated when the buffer is committed.
 *
 * If VAD is enabled the audio buffer is used to detect speech and the server will
 * decide when to commit. When Server VAD is disabled, you must commit the audio
 * buffer manually. Input audio noise reduction operates on writes to the audio
 * buffer.
 *
 * The client may choose how much audio to place in each event up to a maximum of
 * 15 MiB, for example streaming smaller chunks from the client may allow the VAD
 * to be more responsive. Unlike most other client events, the server will not send
 * a confirmation response to this event.
 */
export interface InputAudioBufferAppendEvent {
    /**
     * Base64-encoded audio bytes. This must be in the format specified by the
     * `input_audio_format` field in the session configuration.
     */
    audio: string;
    /**
     * The event type, must be `input_audio_buffer.append`.
     */
    type: 'input_audio_buffer.append';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
}
/**
 * Send this event to clear the audio bytes in the buffer. The server will respond
 * with an `input_audio_buffer.cleared` event.
 */
export interface InputAudioBufferClearEvent {
    /**
     * The event type, must be `input_audio_buffer.clear`.
     */
    type: 'input_audio_buffer.clear';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
}
/**
 * Returned when the input audio buffer is cleared by the client with a
 * `input_audio_buffer.clear` event.
 */
export interface InputAudioBufferClearedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The event type, must be `input_audio_buffer.cleared`.
     */
    type: 'input_audio_buffer.cleared';
}
/**
 * Send this event to commit the user input audio buffer, which will create a new
 * user message item in the conversation. This event will produce an error if the
 * input audio buffer is empty. When in Server VAD mode, the client does not need
 * to send this event, the server will commit the audio buffer automatically.
 *
 * Committing the input audio buffer will trigger input audio transcription (if
 * enabled in session configuration), but it will not create a response from the
 * model. The server will respond with an `input_audio_buffer.committed` event.
 */
export interface InputAudioBufferCommitEvent {
    /**
     * The event type, must be `input_audio_buffer.commit`.
     */
    type: 'input_audio_buffer.commit';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
}
/**
 * Returned when an input audio buffer is committed, either by the client or
 * automatically in server VAD mode. The `item_id` property is the ID of the user
 * message item that will be created, thus a `conversation.item.created` event will
 * also be sent to the client.
 */
export interface InputAudioBufferCommittedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the user message item that will be created.
     */
    item_id: string;
    /**
     * The event type, must be `input_audio_buffer.committed`.
     */
    type: 'input_audio_buffer.committed';
    /**
     * The ID of the preceding item after which the new item will be inserted. Can be
     * `null` if the item has no predecessor.
     */
    previous_item_id?: string | null;
}
/**
 * **SIP Only:** Returned when an DTMF event is received. A DTMF event is a message
 * that represents a telephone keypad press (0–9, \*, #, A–D). The `event` property
 * is the keypad that the user press. The `received_at` is the UTC Unix Timestamp
 * that the server received the event.
 */
export interface InputAudioBufferDtmfEventReceivedEvent {
    /**
     * The telephone keypad that was pressed by the user.
     */
    event: string;
    /**
     * UTC Unix Timestamp when DTMF Event was received by server.
     */
    received_at: number;
    /**
     * The event type, must be `input_audio_buffer.dtmf_event_received`.
     */
    type: 'input_audio_buffer.dtmf_event_received';
}
/**
 * Sent by the server when in `server_vad` mode to indicate that speech has been
 * detected in the audio buffer. This can happen any time audio is added to the
 * buffer (unless speech is already detected). The client may want to use this
 * event to interrupt audio playback or provide visual feedback to the user.
 *
 * The client should expect to receive a `input_audio_buffer.speech_stopped` event
 * when speech stops. The `item_id` property is the ID of the user message item
 * that will be created when speech stops and will also be included in the
 * `input_audio_buffer.speech_stopped` event (unless the client manually commits
 * the audio buffer during VAD activation).
 */
export interface InputAudioBufferSpeechStartedEvent {
    /**
     * Milliseconds from the start of all audio written to the buffer during the
     * session when speech was first detected. This will correspond to the beginning of
     * audio sent to the model, and thus includes the `prefix_padding_ms` configured in
     * the Session.
     */
    audio_start_ms: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the user message item that will be created when speech stops.
     */
    item_id: string;
    /**
     * The event type, must be `input_audio_buffer.speech_started`.
     */
    type: 'input_audio_buffer.speech_started';
}
/**
 * Returned in `server_vad` mode when the server detects the end of speech in the
 * audio buffer. The server will also send an `conversation.item.created` event
 * with the user message item that is created from the audio buffer.
 */
export interface InputAudioBufferSpeechStoppedEvent {
    /**
     * Milliseconds since the session started when speech stopped. This will correspond
     * to the end of audio sent to the model, and thus includes the
     * `min_silence_duration_ms` configured in the Session.
     */
    audio_end_ms: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the user message item that will be created.
     */
    item_id: string;
    /**
     * The event type, must be `input_audio_buffer.speech_stopped`.
     */
    type: 'input_audio_buffer.speech_stopped';
}
/**
 * Returned when the Server VAD timeout is triggered for the input audio buffer.
 * This is configured with `idle_timeout_ms` in the `turn_detection` settings of
 * the session, and it indicates that there hasn't been any speech detected for the
 * configured duration.
 *
 * The `audio_start_ms` and `audio_end_ms` fields indicate the segment of audio
 * after the last model response up to the triggering time, as an offset from the
 * beginning of audio written to the input audio buffer. This means it demarcates
 * the segment of audio that was silent and the difference between the start and
 * end values will roughly match the configured timeout.
 *
 * The empty audio will be committed to the conversation as an `input_audio` item
 * (there will be a `input_audio_buffer.committed` event) and a model response will
 * be generated. There may be speech that didn't trigger VAD but is still detected
 * by the model, so the model may respond with something relevant to the
 * conversation or a prompt to continue speaking.
 */
export interface InputAudioBufferTimeoutTriggered {
    /**
     * Millisecond offset of audio written to the input audio buffer at the time the
     * timeout was triggered.
     */
    audio_end_ms: number;
    /**
     * Millisecond offset of audio written to the input audio buffer that was after the
     * playback time of the last model response.
     */
    audio_start_ms: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item associated with this segment.
     */
    item_id: string;
    /**
     * The event type, must be `input_audio_buffer.timeout_triggered`.
     */
    type: 'input_audio_buffer.timeout_triggered';
}
/**
 * A log probability object.
 */
export interface LogProbProperties {
    /**
     * The token that was used to generate the log probability.
     */
    token: string;
    /**
     * The bytes that were used to generate the log probability.
     */
    bytes: Array<number>;
    /**
     * The log probability of the token.
     */
    logprob: number;
}
/**
 * Returned when listing MCP tools has completed for an item.
 */
export interface McpListToolsCompleted {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the MCP list tools item.
     */
    item_id: string;
    /**
     * The event type, must be `mcp_list_tools.completed`.
     */
    type: 'mcp_list_tools.completed';
}
/**
 * Returned when listing MCP tools has failed for an item.
 */
export interface McpListToolsFailed {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the MCP list tools item.
     */
    item_id: string;
    /**
     * The event type, must be `mcp_list_tools.failed`.
     */
    type: 'mcp_list_tools.failed';
}
/**
 * Returned when listing MCP tools is in progress for an item.
 */
export interface McpListToolsInProgress {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the MCP list tools item.
     */
    item_id: string;
    /**
     * The event type, must be `mcp_list_tools.in_progress`.
     */
    type: 'mcp_list_tools.in_progress';
}
/**
 * Type of noise reduction. `near_field` is for close-talking microphones such as
 * headphones, `far_field` is for far-field microphones such as laptop or
 * conference room microphones.
 */
export type NoiseReductionType = 'near_field' | 'far_field';
/**
 * **WebRTC/SIP Only:** Emit to cut off the current audio response. This will
 * trigger the server to stop generating audio and emit a
 * `output_audio_buffer.cleared` event. This event should be preceded by a
 * `response.cancel` client event to stop the generation of the current response.
 * [Learn more](https://platform.openai.com/docs/guides/realtime-conversations#client-and-server-events-for-audio-in-webrtc).
 */
export interface OutputAudioBufferClearEvent {
    /**
     * The event type, must be `output_audio_buffer.clear`.
     */
    type: 'output_audio_buffer.clear';
    /**
     * The unique ID of the client event used for error handling.
     */
    event_id?: string;
}
/**
 * Emitted at the beginning of a Response to indicate the updated rate limits. When
 * a Response is created some tokens will be "reserved" for the output tokens, the
 * rate limits shown here reflect that reservation, which is then adjusted
 * accordingly once the Response is completed.
 */
export interface RateLimitsUpdatedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * List of rate limit information.
     */
    rate_limits: Array<RateLimitsUpdatedEvent.RateLimit>;
    /**
     * The event type, must be `rate_limits.updated`.
     */
    type: 'rate_limits.updated';
}
export declare namespace RateLimitsUpdatedEvent {
    interface RateLimit {
        /**
         * The maximum allowed value for the rate limit.
         */
        limit?: number;
        /**
         * The name of the rate limit (`requests`, `tokens`).
         */
        name?: 'requests' | 'tokens';
        /**
         * The remaining value before the limit is reached.
         */
        remaining?: number;
        /**
         * Seconds until the rate limit resets.
         */
        reset_seconds?: number;
    }
}
/**
 * Configuration for input and output audio.
 */
export interface RealtimeAudioConfig {
    input?: RealtimeAudioConfigInput;
    output?: RealtimeAudioConfigOutput;
}
export interface RealtimeAudioConfigInput {
    /**
     * The format of the input audio.
     */
    format?: RealtimeAudioFormats;
    /**
     * Configuration for input audio noise reduction. This can be set to `null` to turn
     * off. Noise reduction filters audio added to the input audio buffer before it is
     * sent to VAD and the model. Filtering the audio can improve VAD and turn
     * detection accuracy (reducing false positives) and model performance by improving
     * perception of the input audio.
     */
    noise_reduction?: RealtimeAudioConfigInput.NoiseReduction;
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
    transcription?: AudioTranscription;
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
    turn_detection?: RealtimeAudioInputTurnDetection | null;
}
export declare namespace RealtimeAudioConfigInput {
    /**
     * Configuration for input audio noise reduction. This can be set to `null` to turn
     * off. Noise reduction filters audio added to the input audio buffer before it is
     * sent to VAD and the model. Filtering the audio can improve VAD and turn
     * detection accuracy (reducing false positives) and model performance by improving
     * perception of the input audio.
     */
    interface NoiseReduction {
        /**
         * Type of noise reduction. `near_field` is for close-talking microphones such as
         * headphones, `far_field` is for far-field microphones such as laptop or
         * conference room microphones.
         */
        type?: RealtimeAPI.NoiseReductionType;
    }
}
export interface RealtimeAudioConfigOutput {
    /**
     * The format of the output audio.
     */
    format?: RealtimeAudioFormats;
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
     * The voice the model uses to respond. Supported built-in voices are `alloy`,
     * `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, and
     * `cedar`. You may also provide a custom voice object with an `id`, for example
     * `{ "id": "voice_1234" }`. Voice cannot be changed during the session once the
     * model has responded with audio at least once. We recommend `marin` and `cedar`
     * for best quality.
     */
    voice?: string | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar' | RealtimeAudioConfigOutput.ID;
}
export declare namespace RealtimeAudioConfigOutput {
    /**
     * Custom voice reference.
     */
    interface ID {
        /**
         * The custom voice ID, e.g. `voice_1234`.
         */
        id: string;
    }
}
/**
 * The PCM audio format. Only a 24kHz sample rate is supported.
 */
export type RealtimeAudioFormats = RealtimeAudioFormats.AudioPCM | RealtimeAudioFormats.AudioPCMU | RealtimeAudioFormats.AudioPCMA;
export declare namespace RealtimeAudioFormats {
    /**
     * The PCM audio format. Only a 24kHz sample rate is supported.
     */
    interface AudioPCM {
        /**
         * The sample rate of the audio. Always `24000`.
         */
        rate?: 24000;
        /**
         * The audio format. Always `audio/pcm`.
         */
        type?: 'audio/pcm';
    }
    /**
     * The G.711 μ-law format.
     */
    interface AudioPCMU {
        /**
         * The audio format. Always `audio/pcmu`.
         */
        type?: 'audio/pcmu';
    }
    /**
     * The G.711 A-law format.
     */
    interface AudioPCMA {
        /**
         * The audio format. Always `audio/pcma`.
         */
        type?: 'audio/pcma';
    }
}
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
export type RealtimeAudioInputTurnDetection = RealtimeAudioInputTurnDetection.ServerVad | RealtimeAudioInputTurnDetection.SemanticVad;
export declare namespace RealtimeAudioInputTurnDetection {
    /**
     * Server-side voice activity detection (VAD) which flips on when user speech is
     * detected and off after a period of silence.
     */
    interface ServerVad {
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
    interface SemanticVad {
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
/**
 * A realtime client event.
 */
export type RealtimeClientEvent = ConversationItemCreateEvent | ConversationItemDeleteEvent | ConversationItemRetrieveEvent | ConversationItemTruncateEvent | InputAudioBufferAppendEvent | InputAudioBufferClearEvent | OutputAudioBufferClearEvent | InputAudioBufferCommitEvent | ResponseCancelEvent | ResponseCreateEvent | SessionUpdateEvent;
/**
 * An assistant message item in a Realtime conversation.
 */
export interface RealtimeConversationItemAssistantMessage {
    /**
     * The content of the message.
     */
    content: Array<RealtimeConversationItemAssistantMessage.Content>;
    /**
     * The role of the message sender. Always `assistant`.
     */
    role: 'assistant';
    /**
     * The type of the item. Always `message`.
     */
    type: 'message';
    /**
     * The unique ID of the item. This may be provided by the client or generated by
     * the server.
     */
    id?: string;
    /**
     * Identifier for the API object being returned - always `realtime.item`. Optional
     * when creating a new item.
     */
    object?: 'realtime.item';
    /**
     * The status of the item. Has no effect on the conversation.
     */
    status?: 'completed' | 'incomplete' | 'in_progress';
}
export declare namespace RealtimeConversationItemAssistantMessage {
    interface Content {
        /**
         * Base64-encoded audio bytes, these will be parsed as the format specified in the
         * session output audio type configuration. This defaults to PCM 16-bit 24kHz mono
         * if not specified.
         */
        audio?: string;
        /**
         * The text content.
         */
        text?: string;
        /**
         * The transcript of the audio content, this will always be present if the output
         * type is `audio`.
         */
        transcript?: string;
        /**
         * The content type, `output_text` or `output_audio` depending on the session
         * `output_modalities` configuration.
         */
        type?: 'output_text' | 'output_audio';
    }
}
/**
 * A function call item in a Realtime conversation.
 */
export interface RealtimeConversationItemFunctionCall {
    /**
     * The arguments of the function call. This is a JSON-encoded string representing
     * the arguments passed to the function, for example
     * `{"arg1": "value1", "arg2": 42}`.
     */
    arguments: string;
    /**
     * The name of the function being called.
     */
    name: string;
    /**
     * The type of the item. Always `function_call`.
     */
    type: 'function_call';
    /**
     * The unique ID of the item. This may be provided by the client or generated by
     * the server.
     */
    id?: string;
    /**
     * The ID of the function call.
     */
    call_id?: string;
    /**
     * Identifier for the API object being returned - always `realtime.item`. Optional
     * when creating a new item.
     */
    object?: 'realtime.item';
    /**
     * The status of the item. Has no effect on the conversation.
     */
    status?: 'completed' | 'incomplete' | 'in_progress';
}
/**
 * A function call output item in a Realtime conversation.
 */
export interface RealtimeConversationItemFunctionCallOutput {
    /**
     * The ID of the function call this output is for.
     */
    call_id: string;
    /**
     * The output of the function call, this is free text and can contain any
     * information or simply be empty.
     */
    output: string;
    /**
     * The type of the item. Always `function_call_output`.
     */
    type: 'function_call_output';
    /**
     * The unique ID of the item. This may be provided by the client or generated by
     * the server.
     */
    id?: string;
    /**
     * Identifier for the API object being returned - always `realtime.item`. Optional
     * when creating a new item.
     */
    object?: 'realtime.item';
    /**
     * The status of the item. Has no effect on the conversation.
     */
    status?: 'completed' | 'incomplete' | 'in_progress';
}
/**
 * A system message in a Realtime conversation can be used to provide additional
 * context or instructions to the model. This is similar but distinct from the
 * instruction prompt provided at the start of a conversation, as system messages
 * can be added at any point in the conversation. For major changes to the
 * conversation's behavior, use instructions, but for smaller updates (e.g. "the
 * user is now asking about a different topic"), use system messages.
 */
export interface RealtimeConversationItemSystemMessage {
    /**
     * The content of the message.
     */
    content: Array<RealtimeConversationItemSystemMessage.Content>;
    /**
     * The role of the message sender. Always `system`.
     */
    role: 'system';
    /**
     * The type of the item. Always `message`.
     */
    type: 'message';
    /**
     * The unique ID of the item. This may be provided by the client or generated by
     * the server.
     */
    id?: string;
    /**
     * Identifier for the API object being returned - always `realtime.item`. Optional
     * when creating a new item.
     */
    object?: 'realtime.item';
    /**
     * The status of the item. Has no effect on the conversation.
     */
    status?: 'completed' | 'incomplete' | 'in_progress';
}
export declare namespace RealtimeConversationItemSystemMessage {
    interface Content {
        /**
         * The text content.
         */
        text?: string;
        /**
         * The content type. Always `input_text` for system messages.
         */
        type?: 'input_text';
    }
}
/**
 * A user message item in a Realtime conversation.
 */
export interface RealtimeConversationItemUserMessage {
    /**
     * The content of the message.
     */
    content: Array<RealtimeConversationItemUserMessage.Content>;
    /**
     * The role of the message sender. Always `user`.
     */
    role: 'user';
    /**
     * The type of the item. Always `message`.
     */
    type: 'message';
    /**
     * The unique ID of the item. This may be provided by the client or generated by
     * the server.
     */
    id?: string;
    /**
     * Identifier for the API object being returned - always `realtime.item`. Optional
     * when creating a new item.
     */
    object?: 'realtime.item';
    /**
     * The status of the item. Has no effect on the conversation.
     */
    status?: 'completed' | 'incomplete' | 'in_progress';
}
export declare namespace RealtimeConversationItemUserMessage {
    interface Content {
        /**
         * Base64-encoded audio bytes (for `input_audio`), these will be parsed as the
         * format specified in the session input audio type configuration. This defaults to
         * PCM 16-bit 24kHz mono if not specified.
         */
        audio?: string;
        /**
         * The detail level of the image (for `input_image`). `auto` will default to
         * `high`.
         */
        detail?: 'auto' | 'low' | 'high';
        /**
         * Base64-encoded image bytes (for `input_image`) as a data URI. For example
         * `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...`. Supported formats are PNG
         * and JPEG.
         */
        image_url?: string;
        /**
         * The text content (for `input_text`).
         */
        text?: string;
        /**
         * Transcript of the audio (for `input_audio`). This is not sent to the model, but
         * will be attached to the message item for reference.
         */
        transcript?: string;
        /**
         * The content type (`input_text`, `input_audio`, or `input_image`).
         */
        type?: 'input_text' | 'input_audio' | 'input_image';
    }
}
/**
 * Details of the error.
 */
export interface RealtimeError {
    /**
     * A human-readable error message.
     */
    message: string;
    /**
     * The type of error (e.g., "invalid_request_error", "server_error").
     */
    type: string;
    /**
     * Error code, if any.
     */
    code?: string | null;
    /**
     * The event_id of the client event that caused the error, if applicable.
     */
    event_id?: string | null;
    /**
     * Parameter related to the error, if any.
     */
    param?: string | null;
}
/**
 * Returned when an error occurs, which could be a client problem or a server
 * problem. Most errors are recoverable and the session will stay open, we
 * recommend to implementors to monitor and log error messages by default.
 */
export interface RealtimeErrorEvent {
    /**
     * Details of the error.
     */
    error: RealtimeError;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The event type, must be `error`.
     */
    type: 'error';
}
export interface RealtimeFunctionTool {
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
 * A Realtime item requesting human approval of a tool invocation.
 */
export interface RealtimeMcpApprovalRequest {
    /**
     * The unique ID of the approval request.
     */
    id: string;
    /**
     * A JSON string of arguments for the tool.
     */
    arguments: string;
    /**
     * The name of the tool to run.
     */
    name: string;
    /**
     * The label of the MCP server making the request.
     */
    server_label: string;
    /**
     * The type of the item. Always `mcp_approval_request`.
     */
    type: 'mcp_approval_request';
}
/**
 * A Realtime item responding to an MCP approval request.
 */
export interface RealtimeMcpApprovalResponse {
    /**
     * The unique ID of the approval response.
     */
    id: string;
    /**
     * The ID of the approval request being answered.
     */
    approval_request_id: string;
    /**
     * Whether the request was approved.
     */
    approve: boolean;
    /**
     * The type of the item. Always `mcp_approval_response`.
     */
    type: 'mcp_approval_response';
    /**
     * Optional reason for the decision.
     */
    reason?: string | null;
}
/**
 * A Realtime item listing tools available on an MCP server.
 */
export interface RealtimeMcpListTools {
    /**
     * The label of the MCP server.
     */
    server_label: string;
    /**
     * The tools available on the server.
     */
    tools: Array<RealtimeMcpListTools.Tool>;
    /**
     * The type of the item. Always `mcp_list_tools`.
     */
    type: 'mcp_list_tools';
    /**
     * The unique ID of the list.
     */
    id?: string;
}
export declare namespace RealtimeMcpListTools {
    /**
     * A tool available on an MCP server.
     */
    interface Tool {
        /**
         * The JSON schema describing the tool's input.
         */
        input_schema: unknown;
        /**
         * The name of the tool.
         */
        name: string;
        /**
         * Additional annotations about the tool.
         */
        annotations?: unknown | null;
        /**
         * The description of the tool.
         */
        description?: string | null;
    }
}
export interface RealtimeMcpProtocolError {
    code: number;
    message: string;
    type: 'protocol_error';
}
/**
 * A Realtime item representing an invocation of a tool on an MCP server.
 */
export interface RealtimeMcpToolCall {
    /**
     * The unique ID of the tool call.
     */
    id: string;
    /**
     * A JSON string of the arguments passed to the tool.
     */
    arguments: string;
    /**
     * The name of the tool that was run.
     */
    name: string;
    /**
     * The label of the MCP server running the tool.
     */
    server_label: string;
    /**
     * The type of the item. Always `mcp_call`.
     */
    type: 'mcp_call';
    /**
     * The ID of an associated approval request, if any.
     */
    approval_request_id?: string | null;
    /**
     * The error from the tool call, if any.
     */
    error?: RealtimeMcpProtocolError | RealtimeMcpToolExecutionError | RealtimeMcphttpError | null;
    /**
     * The output from the tool call.
     */
    output?: string | null;
}
export interface RealtimeMcpToolExecutionError {
    message: string;
    type: 'tool_execution_error';
}
export interface RealtimeMcphttpError {
    code: number;
    message: string;
    type: 'http_error';
}
/**
 * The response resource.
 */
export interface RealtimeResponse {
    /**
     * The unique ID of the response, will look like `resp_1234`.
     */
    id?: string;
    /**
     * Configuration for audio output.
     */
    audio?: RealtimeResponse.Audio;
    /**
     * Which conversation the response is added to, determined by the `conversation`
     * field in the `response.create` event. If `auto`, the response will be added to
     * the default conversation and the value of `conversation_id` will be an id like
     * `conv_1234`. If `none`, the response will not be added to any conversation and
     * the value of `conversation_id` will be `null`. If responses are being triggered
     * automatically by VAD the response will be added to the default conversation
     */
    conversation_id?: string;
    /**
     * Maximum number of output tokens for a single assistant response, inclusive of
     * tool calls, that was used in this response.
     */
    max_output_tokens?: number | 'inf';
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
     * The object type, must be `realtime.response`.
     */
    object?: 'realtime.response';
    /**
     * The list of output items generated by the response.
     */
    output?: Array<ConversationItem>;
    /**
     * The set of modalities the model used to respond, currently the only possible
     * values are `[\"audio\"]`, `[\"text\"]`. Audio output always include a text
     * transcript. Setting the output to mode `text` will disable audio output from the
     * model.
     */
    output_modalities?: Array<'text' | 'audio'>;
    /**
     * The final status of the response (`completed`, `cancelled`, `failed`, or
     * `incomplete`, `in_progress`).
     */
    status?: 'completed' | 'cancelled' | 'failed' | 'incomplete' | 'in_progress';
    /**
     * Additional details about the status.
     */
    status_details?: RealtimeResponseStatus;
    /**
     * Usage statistics for the Response, this will correspond to billing. A Realtime
     * API session will maintain a conversation context and append new Items to the
     * Conversation, thus output from previous turns (text and audio tokens) will
     * become the input for later turns.
     */
    usage?: RealtimeResponseUsage;
}
export declare namespace RealtimeResponse {
    /**
     * Configuration for audio output.
     */
    interface Audio {
        output?: Audio.Output;
    }
    namespace Audio {
        interface Output {
            /**
             * The format of the output audio.
             */
            format?: RealtimeAPI.RealtimeAudioFormats;
            /**
             * The voice the model uses to respond. Voice cannot be changed during the session
             * once the model has responded with audio at least once. Current voice options are
             * `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`,
             * and `cedar`. We recommend `marin` and `cedar` for best quality.
             */
            voice?: (string & {}) | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';
        }
    }
}
/**
 * Configuration for audio input and output.
 */
export interface RealtimeResponseCreateAudioOutput {
    output?: RealtimeResponseCreateAudioOutput.Output;
}
export declare namespace RealtimeResponseCreateAudioOutput {
    interface Output {
        /**
         * The format of the output audio.
         */
        format?: RealtimeAPI.RealtimeAudioFormats;
        /**
         * The voice the model uses to respond. Supported built-in voices are `alloy`,
         * `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, and
         * `cedar`. You may also provide a custom voice object with an `id`, for example
         * `{ "id": "voice_1234" }`. Voice cannot be changed during the session once the
         * model has responded with audio at least once. We recommend `marin` and `cedar`
         * for best quality.
         */
        voice?: string | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar' | Output.ID;
    }
    namespace Output {
        /**
         * Custom voice reference.
         */
        interface ID {
            /**
             * The custom voice ID, e.g. `voice_1234`.
             */
            id: string;
        }
    }
}
/**
 * Give the model access to additional tools via remote Model Context Protocol
 * (MCP) servers.
 * [Learn more about MCP](https://platform.openai.com/docs/guides/tools-remote-mcp).
 */
export interface RealtimeResponseCreateMcpTool {
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
    allowed_tools?: Array<string> | RealtimeResponseCreateMcpTool.McpToolFilter | null;
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
    connector_id?: 'connector_dropbox' | 'connector_gmail' | 'connector_googlecalendar' | 'connector_googledrive' | 'connector_microsoftteams' | 'connector_outlookcalendar' | 'connector_outlookemail' | 'connector_sharepoint';
    /**
     * Whether this MCP tool is deferred and discovered via tool search.
     */
    defer_loading?: boolean;
    /**
     * Optional HTTP headers to send to the MCP server. Use for authentication or other
     * purposes.
     */
    headers?: {
        [key: string]: string;
    } | null;
    /**
     * Specify which of the MCP server's tools require approval.
     */
    require_approval?: RealtimeResponseCreateMcpTool.McpToolApprovalFilter | 'always' | 'never' | null;
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
export declare namespace RealtimeResponseCreateMcpTool {
    /**
     * A filter object to specify which tools are allowed.
     */
    interface McpToolFilter {
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
    interface McpToolApprovalFilter {
        /**
         * A filter object to specify which tools are allowed.
         */
        always?: McpToolApprovalFilter.Always;
        /**
         * A filter object to specify which tools are allowed.
         */
        never?: McpToolApprovalFilter.Never;
    }
    namespace McpToolApprovalFilter {
        /**
         * A filter object to specify which tools are allowed.
         */
        interface Always {
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
        interface Never {
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
 * Create a new Realtime response with these parameters
 */
export interface RealtimeResponseCreateParams {
    /**
     * Configuration for audio input and output.
     */
    audio?: RealtimeResponseCreateAudioOutput;
    /**
     * Controls which conversation the response is added to. Currently supports `auto`
     * and `none`, with `auto` as the default value. The `auto` value means that the
     * contents of the response will be added to the default conversation. Set this to
     * `none` to create an out-of-band response which will not add items to default
     * conversation.
     */
    conversation?: (string & {}) | 'auto' | 'none';
    /**
     * Input items to include in the prompt for the model. Using this field creates a
     * new context for this Response instead of using the default conversation. An
     * empty array `[]` will clear the context for this Response. Note that this can
     * include references to items that previously appeared in the session using their
     * id.
     */
    input?: Array<ConversationItem>;
    /**
     * The default system instructions (i.e. system message) prepended to model calls.
     * This field allows the client to guide the model on desired responses. The model
     * can be instructed on response content and format, (e.g. "be extremely succinct",
     * "act friendly", "here are examples of good responses") and on audio behavior
     * (e.g. "talk quickly", "inject emotion into your voice", "laugh frequently"). The
     * instructions are not guaranteed to be followed by the model, but they provide
     * guidance to the model on the desired behavior. Note that the server sets default
     * instructions which will be used if this field is not set and are visible in the
     * `session.created` event at the start of the session.
     */
    instructions?: string;
    /**
     * Maximum number of output tokens for a single assistant response, inclusive of
     * tool calls. Provide an integer between 1 and 4096 to limit output tokens, or
     * `inf` for the maximum available tokens for a given model. Defaults to `inf`.
     */
    max_output_tokens?: number | 'inf';
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
     * The set of modalities the model used to respond, currently the only possible
     * values are `[\"audio\"]`, `[\"text\"]`. Audio output always include a text
     * transcript. Setting the output to mode `text` will disable audio output from the
     * model.
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
    tools?: Array<RealtimeFunctionTool | RealtimeResponseCreateMcpTool>;
}
/**
 * Additional details about the status.
 */
export interface RealtimeResponseStatus {
    /**
     * A description of the error that caused the response to fail, populated when the
     * `status` is `failed`.
     */
    error?: RealtimeResponseStatus.Error;
    /**
     * The reason the Response did not complete. For a `cancelled` Response, one of
     * `turn_detected` (the server VAD detected a new start of speech) or
     * `client_cancelled` (the client sent a cancel event). For an `incomplete`
     * Response, one of `max_output_tokens` or `content_filter` (the server-side safety
     * filter activated and cut off the response).
     */
    reason?: 'turn_detected' | 'client_cancelled' | 'max_output_tokens' | 'content_filter';
    /**
     * The type of error that caused the response to fail, corresponding with the
     * `status` field (`completed`, `cancelled`, `incomplete`, `failed`).
     */
    type?: 'completed' | 'cancelled' | 'incomplete' | 'failed';
}
export declare namespace RealtimeResponseStatus {
    /**
     * A description of the error that caused the response to fail, populated when the
     * `status` is `failed`.
     */
    interface Error {
        /**
         * Error code, if any.
         */
        code?: string;
        /**
         * The type of error.
         */
        type?: string;
    }
}
/**
 * Usage statistics for the Response, this will correspond to billing. A Realtime
 * API session will maintain a conversation context and append new Items to the
 * Conversation, thus output from previous turns (text and audio tokens) will
 * become the input for later turns.
 */
export interface RealtimeResponseUsage {
    /**
     * Details about the input tokens used in the Response. Cached tokens are tokens
     * from previous turns in the conversation that are included as context for the
     * current response. Cached tokens here are counted as a subset of input tokens,
     * meaning input tokens will include cached and uncached tokens.
     */
    input_token_details?: RealtimeResponseUsageInputTokenDetails;
    /**
     * The number of input tokens used in the Response, including text and audio
     * tokens.
     */
    input_tokens?: number;
    /**
     * Details about the output tokens used in the Response.
     */
    output_token_details?: RealtimeResponseUsageOutputTokenDetails;
    /**
     * The number of output tokens sent in the Response, including text and audio
     * tokens.
     */
    output_tokens?: number;
    /**
     * The total number of tokens in the Response including input and output text and
     * audio tokens.
     */
    total_tokens?: number;
}
/**
 * Details about the input tokens used in the Response. Cached tokens are tokens
 * from previous turns in the conversation that are included as context for the
 * current response. Cached tokens here are counted as a subset of input tokens,
 * meaning input tokens will include cached and uncached tokens.
 */
export interface RealtimeResponseUsageInputTokenDetails {
    /**
     * The number of audio tokens used as input for the Response.
     */
    audio_tokens?: number;
    /**
     * The number of cached tokens used as input for the Response.
     */
    cached_tokens?: number;
    /**
     * Details about the cached tokens used as input for the Response.
     */
    cached_tokens_details?: RealtimeResponseUsageInputTokenDetails.CachedTokensDetails;
    /**
     * The number of image tokens used as input for the Response.
     */
    image_tokens?: number;
    /**
     * The number of text tokens used as input for the Response.
     */
    text_tokens?: number;
}
export declare namespace RealtimeResponseUsageInputTokenDetails {
    /**
     * Details about the cached tokens used as input for the Response.
     */
    interface CachedTokensDetails {
        /**
         * The number of cached audio tokens used as input for the Response.
         */
        audio_tokens?: number;
        /**
         * The number of cached image tokens used as input for the Response.
         */
        image_tokens?: number;
        /**
         * The number of cached text tokens used as input for the Response.
         */
        text_tokens?: number;
    }
}
/**
 * Details about the output tokens used in the Response.
 */
export interface RealtimeResponseUsageOutputTokenDetails {
    /**
     * The number of audio tokens used in the Response.
     */
    audio_tokens?: number;
    /**
     * The number of text tokens used in the Response.
     */
    text_tokens?: number;
}
/**
 * A realtime server event.
 */
export type RealtimeServerEvent = ConversationCreatedEvent | ConversationItemCreatedEvent | ConversationItemDeletedEvent | ConversationItemInputAudioTranscriptionCompletedEvent | ConversationItemInputAudioTranscriptionDeltaEvent | ConversationItemInputAudioTranscriptionFailedEvent | RealtimeServerEvent.ConversationItemRetrieved | ConversationItemTruncatedEvent | RealtimeErrorEvent | InputAudioBufferClearedEvent | InputAudioBufferCommittedEvent | InputAudioBufferDtmfEventReceivedEvent | InputAudioBufferSpeechStartedEvent | InputAudioBufferSpeechStoppedEvent | RateLimitsUpdatedEvent | ResponseAudioDeltaEvent | ResponseAudioDoneEvent | ResponseAudioTranscriptDeltaEvent | ResponseAudioTranscriptDoneEvent | ResponseContentPartAddedEvent | ResponseContentPartDoneEvent | ResponseCreatedEvent | ResponseDoneEvent | ResponseFunctionCallArgumentsDeltaEvent | ResponseFunctionCallArgumentsDoneEvent | ResponseOutputItemAddedEvent | ResponseOutputItemDoneEvent | ResponseTextDeltaEvent | ResponseTextDoneEvent | SessionCreatedEvent | SessionUpdatedEvent | RealtimeServerEvent.OutputAudioBufferStarted | RealtimeServerEvent.OutputAudioBufferStopped | RealtimeServerEvent.OutputAudioBufferCleared | ConversationItemAdded | ConversationItemDone | InputAudioBufferTimeoutTriggered | ConversationItemInputAudioTranscriptionSegment | McpListToolsInProgress | McpListToolsCompleted | McpListToolsFailed | ResponseMcpCallArgumentsDelta | ResponseMcpCallArgumentsDone | ResponseMcpCallInProgress | ResponseMcpCallCompleted | ResponseMcpCallFailed;
export declare namespace RealtimeServerEvent {
    /**
     * Returned when a conversation item is retrieved with
     * `conversation.item.retrieve`. This is provided as a way to fetch the server's
     * representation of an item, for example to get access to the post-processed audio
     * data after noise cancellation and VAD. It includes the full content of the Item,
     * including audio data.
     */
    interface ConversationItemRetrieved {
        /**
         * The unique ID of the server event.
         */
        event_id: string;
        /**
         * A single item within a Realtime conversation.
         */
        item: RealtimeAPI.ConversationItem;
        /**
         * The event type, must be `conversation.item.retrieved`.
         */
        type: 'conversation.item.retrieved';
    }
    /**
     * **WebRTC/SIP Only:** Emitted when the server begins streaming audio to the
     * client. This event is emitted after an audio content part has been added
     * (`response.content_part.added`) to the response.
     * [Learn more](https://platform.openai.com/docs/guides/realtime-conversations#client-and-server-events-for-audio-in-webrtc).
     */
    interface OutputAudioBufferStarted {
        /**
         * The unique ID of the server event.
         */
        event_id: string;
        /**
         * The unique ID of the response that produced the audio.
         */
        response_id: string;
        /**
         * The event type, must be `output_audio_buffer.started`.
         */
        type: 'output_audio_buffer.started';
    }
    /**
     * **WebRTC/SIP Only:** Emitted when the output audio buffer has been completely
     * drained on the server, and no more audio is forthcoming. This event is emitted
     * after the full response data has been sent to the client (`response.done`).
     * [Learn more](https://platform.openai.com/docs/guides/realtime-conversations#client-and-server-events-for-audio-in-webrtc).
     */
    interface OutputAudioBufferStopped {
        /**
         * The unique ID of the server event.
         */
        event_id: string;
        /**
         * The unique ID of the response that produced the audio.
         */
        response_id: string;
        /**
         * The event type, must be `output_audio_buffer.stopped`.
         */
        type: 'output_audio_buffer.stopped';
    }
    /**
     * **WebRTC/SIP Only:** Emitted when the output audio buffer is cleared. This
     * happens either in VAD mode when the user has interrupted
     * (`input_audio_buffer.speech_started`), or when the client has emitted the
     * `output_audio_buffer.clear` event to manually cut off the current audio
     * response.
     * [Learn more](https://platform.openai.com/docs/guides/realtime-conversations#client-and-server-events-for-audio-in-webrtc).
     */
    interface OutputAudioBufferCleared {
        /**
         * The unique ID of the server event.
         */
        event_id: string;
        /**
         * The unique ID of the response that produced the audio.
         */
        response_id: string;
        /**
         * The event type, must be `output_audio_buffer.cleared`.
         */
        type: 'output_audio_buffer.cleared';
    }
}
/**
 * Realtime session object for the beta interface.
 */
export interface RealtimeSession {
    /**
     * Unique identifier for the session that looks like `sess_1234567890abcdef`.
     */
    id?: string;
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
    include?: Array<'item.input_audio_transcription.logprobs'> | null;
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
    input_audio_noise_reduction?: RealtimeSession.InputAudioNoiseReduction;
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
    input_audio_transcription?: AudioTranscription | null;
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
    model?: (string & {}) | 'gpt-realtime' | 'gpt-realtime-1.5' | 'gpt-realtime-2025-08-28' | 'gpt-4o-realtime-preview' | 'gpt-4o-realtime-preview-2024-10-01' | 'gpt-4o-realtime-preview-2024-12-17' | 'gpt-4o-realtime-preview-2025-06-03' | 'gpt-4o-mini-realtime-preview' | 'gpt-4o-mini-realtime-preview-2024-12-17' | 'gpt-realtime-mini' | 'gpt-realtime-mini-2025-10-06' | 'gpt-realtime-mini-2025-12-15' | 'gpt-audio-1.5' | 'gpt-audio-mini' | 'gpt-audio-mini-2025-10-06' | 'gpt-audio-mini-2025-12-15';
    /**
     * The object type. Always `realtime.session`.
     */
    object?: 'realtime.session';
    /**
     * The format of output audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`.
     * For `pcm16`, output audio is sampled at a rate of 24kHz.
     */
    output_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
    /**
     * Reference to a prompt template and its variables.
     * [Learn more](https://platform.openai.com/docs/guides/text?api-mode=responses#reusable-prompts).
     */
    prompt?: ResponsesAPI.ResponsePrompt | null;
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
    tools?: Array<RealtimeFunctionTool>;
    /**
     * Configuration options for tracing. Set to null to disable tracing. Once tracing
     * is enabled for a session, the configuration cannot be modified.
     *
     * `auto` will create a trace for the session with default values for the workflow
     * name, group id, and metadata.
     */
    tracing?: 'auto' | RealtimeSession.TracingConfiguration | null;
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
    turn_detection?: RealtimeSession.ServerVad | RealtimeSession.SemanticVad | null;
    /**
     * The voice the model uses to respond. Voice cannot be changed during the session
     * once the model has responded with audio at least once. Current voice options are
     * `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, and `verse`.
     */
    voice?: (string & {}) | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';
}
export declare namespace RealtimeSession {
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
        type?: RealtimeAPI.NoiseReductionType;
    }
    /**
     * Granular configuration for tracing.
     */
    interface TracingConfiguration {
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
     * Server-side voice activity detection (VAD) which flips on when user speech is
     * detected and off after a period of silence.
     */
    interface ServerVad {
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
    interface SemanticVad {
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
/**
 * Realtime session object configuration.
 */
export interface RealtimeSessionCreateRequest {
    /**
     * The type of session to create. Always `realtime` for the Realtime API.
     */
    type: 'realtime';
    /**
     * Configuration for input and output audio.
     */
    audio?: RealtimeAudioConfig;
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
    model?: (string & {}) | 'gpt-realtime' | 'gpt-realtime-1.5' | 'gpt-realtime-2025-08-28' | 'gpt-4o-realtime-preview' | 'gpt-4o-realtime-preview-2024-10-01' | 'gpt-4o-realtime-preview-2024-12-17' | 'gpt-4o-realtime-preview-2025-06-03' | 'gpt-4o-mini-realtime-preview' | 'gpt-4o-mini-realtime-preview-2024-12-17' | 'gpt-realtime-mini' | 'gpt-realtime-mini-2025-10-06' | 'gpt-realtime-mini-2025-12-15' | 'gpt-audio-1.5' | 'gpt-audio-mini' | 'gpt-audio-mini-2025-10-06' | 'gpt-audio-mini-2025-12-15';
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
    tool_choice?: RealtimeToolChoiceConfig;
    /**
     * Tools available to the model.
     */
    tools?: RealtimeToolsConfig;
    /**
     * Realtime API can write session traces to the
     * [Traces Dashboard](/logs?api=traces). Set to null to disable tracing. Once
     * tracing is enabled for a session, the configuration cannot be modified.
     *
     * `auto` will create a trace for the session with default values for the workflow
     * name, group id, and metadata.
     */
    tracing?: RealtimeTracingConfig | null;
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
    truncation?: RealtimeTruncation;
}
/**
 * How the model chooses tools. Provide one of the string modes or force a specific
 * function/MCP tool.
 */
export type RealtimeToolChoiceConfig = ResponsesAPI.ToolChoiceOptions | ResponsesAPI.ToolChoiceFunction | ResponsesAPI.ToolChoiceMcp;
/**
 * Tools available to the model.
 */
export type RealtimeToolsConfig = Array<RealtimeToolsConfigUnion>;
/**
 * Give the model access to additional tools via remote Model Context Protocol
 * (MCP) servers.
 * [Learn more about MCP](https://platform.openai.com/docs/guides/tools-remote-mcp).
 */
export type RealtimeToolsConfigUnion = RealtimeFunctionTool | RealtimeToolsConfigUnion.Mcp;
export declare namespace RealtimeToolsConfigUnion {
    /**
     * Give the model access to additional tools via remote Model Context Protocol
     * (MCP) servers.
     * [Learn more about MCP](https://platform.openai.com/docs/guides/tools-remote-mcp).
     */
    interface Mcp {
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
        allowed_tools?: Array<string> | Mcp.McpToolFilter | null;
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
        connector_id?: 'connector_dropbox' | 'connector_gmail' | 'connector_googlecalendar' | 'connector_googledrive' | 'connector_microsoftteams' | 'connector_outlookcalendar' | 'connector_outlookemail' | 'connector_sharepoint';
        /**
         * Whether this MCP tool is deferred and discovered via tool search.
         */
        defer_loading?: boolean;
        /**
         * Optional HTTP headers to send to the MCP server. Use for authentication or other
         * purposes.
         */
        headers?: {
            [key: string]: string;
        } | null;
        /**
         * Specify which of the MCP server's tools require approval.
         */
        require_approval?: Mcp.McpToolApprovalFilter | 'always' | 'never' | null;
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
    namespace Mcp {
        /**
         * A filter object to specify which tools are allowed.
         */
        interface McpToolFilter {
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
        interface McpToolApprovalFilter {
            /**
             * A filter object to specify which tools are allowed.
             */
            always?: McpToolApprovalFilter.Always;
            /**
             * A filter object to specify which tools are allowed.
             */
            never?: McpToolApprovalFilter.Never;
        }
        namespace McpToolApprovalFilter {
            /**
             * A filter object to specify which tools are allowed.
             */
            interface Always {
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
            interface Never {
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
}
/**
 * Realtime API can write session traces to the
 * [Traces Dashboard](/logs?api=traces). Set to null to disable tracing. Once
 * tracing is enabled for a session, the configuration cannot be modified.
 *
 * `auto` will create a trace for the session with default values for the workflow
 * name, group id, and metadata.
 */
export type RealtimeTracingConfig = 'auto' | RealtimeTracingConfig.TracingConfiguration;
export declare namespace RealtimeTracingConfig {
    /**
     * Granular configuration for tracing.
     */
    interface TracingConfiguration {
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
 * Configuration for input and output audio.
 */
export interface RealtimeTranscriptionSessionAudio {
    input?: RealtimeTranscriptionSessionAudioInput;
}
export interface RealtimeTranscriptionSessionAudioInput {
    /**
     * The PCM audio format. Only a 24kHz sample rate is supported.
     */
    format?: RealtimeAudioFormats;
    /**
     * Configuration for input audio noise reduction. This can be set to `null` to turn
     * off. Noise reduction filters audio added to the input audio buffer before it is
     * sent to VAD and the model. Filtering the audio can improve VAD and turn
     * detection accuracy (reducing false positives) and model performance by improving
     * perception of the input audio.
     */
    noise_reduction?: RealtimeTranscriptionSessionAudioInput.NoiseReduction;
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
    transcription?: AudioTranscription;
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
    turn_detection?: RealtimeTranscriptionSessionAudioInputTurnDetection | null;
}
export declare namespace RealtimeTranscriptionSessionAudioInput {
    /**
     * Configuration for input audio noise reduction. This can be set to `null` to turn
     * off. Noise reduction filters audio added to the input audio buffer before it is
     * sent to VAD and the model. Filtering the audio can improve VAD and turn
     * detection accuracy (reducing false positives) and model performance by improving
     * perception of the input audio.
     */
    interface NoiseReduction {
        /**
         * Type of noise reduction. `near_field` is for close-talking microphones such as
         * headphones, `far_field` is for far-field microphones such as laptop or
         * conference room microphones.
         */
        type?: RealtimeAPI.NoiseReductionType;
    }
}
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
export type RealtimeTranscriptionSessionAudioInputTurnDetection = RealtimeTranscriptionSessionAudioInputTurnDetection.ServerVad | RealtimeTranscriptionSessionAudioInputTurnDetection.SemanticVad;
export declare namespace RealtimeTranscriptionSessionAudioInputTurnDetection {
    /**
     * Server-side voice activity detection (VAD) which flips on when user speech is
     * detected and off after a period of silence.
     */
    interface ServerVad {
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
    interface SemanticVad {
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
/**
 * Realtime transcription session object configuration.
 */
export interface RealtimeTranscriptionSessionCreateRequest {
    /**
     * The type of session to create. Always `transcription` for transcription
     * sessions.
     */
    type: 'transcription';
    /**
     * Configuration for input and output audio.
     */
    audio?: RealtimeTranscriptionSessionAudio;
    /**
     * Additional fields to include in server outputs.
     *
     * `item.input_audio_transcription.logprobs`: Include logprobs for input audio
     * transcription.
     */
    include?: Array<'item.input_audio_transcription.logprobs'>;
}
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
export type RealtimeTruncation = 'auto' | 'disabled' | RealtimeTruncationRetentionRatio;
/**
 * Retain a fraction of the conversation tokens when the conversation exceeds the
 * input token limit. This allows you to amortize truncations across multiple
 * turns, which can help improve cached token usage.
 */
export interface RealtimeTruncationRetentionRatio {
    /**
     * Fraction of post-instruction conversation tokens to retain (`0.0` - `1.0`) when
     * the conversation exceeds the input token limit. Setting this to `0.8` means that
     * messages will be dropped until 80% of the maximum allowed tokens are used. This
     * helps reduce the frequency of truncations and improve cache rates.
     */
    retention_ratio: number;
    /**
     * Use retention ratio truncation.
     */
    type: 'retention_ratio';
    /**
     * Optional custom token limits for this truncation strategy. If not provided, the
     * model's default token limits will be used.
     */
    token_limits?: RealtimeTruncationRetentionRatio.TokenLimits;
}
export declare namespace RealtimeTruncationRetentionRatio {
    /**
     * Optional custom token limits for this truncation strategy. If not provided, the
     * model's default token limits will be used.
     */
    interface TokenLimits {
        /**
         * Maximum tokens allowed in the conversation after instructions (which including
         * tool definitions). For example, setting this to 5,000 would mean that truncation
         * would occur when the conversation exceeds 5,000 tokens after instructions. This
         * cannot be higher than the model's context window size minus the maximum output
         * tokens.
         */
        post_instructions?: number;
    }
}
/**
 * Returned when the model-generated audio is updated.
 */
export interface ResponseAudioDeltaEvent {
    /**
     * The index of the content part in the item's content array.
     */
    content_index: number;
    /**
     * Base64-encoded audio data delta.
     */
    delta: string;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.output_audio.delta`.
     */
    type: 'response.output_audio.delta';
}
/**
 * Returned when the model-generated audio is done. Also emitted when a Response is
 * interrupted, incomplete, or cancelled.
 */
export interface ResponseAudioDoneEvent {
    /**
     * The index of the content part in the item's content array.
     */
    content_index: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.output_audio.done`.
     */
    type: 'response.output_audio.done';
}
/**
 * Returned when the model-generated transcription of audio output is updated.
 */
export interface ResponseAudioTranscriptDeltaEvent {
    /**
     * The index of the content part in the item's content array.
     */
    content_index: number;
    /**
     * The transcript delta.
     */
    delta: string;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.output_audio_transcript.delta`.
     */
    type: 'response.output_audio_transcript.delta';
}
/**
 * Returned when the model-generated transcription of audio output is done
 * streaming. Also emitted when a Response is interrupted, incomplete, or
 * cancelled.
 */
export interface ResponseAudioTranscriptDoneEvent {
    /**
     * The index of the content part in the item's content array.
     */
    content_index: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The final transcript of the audio.
     */
    transcript: string;
    /**
     * The event type, must be `response.output_audio_transcript.done`.
     */
    type: 'response.output_audio_transcript.done';
}
/**
 * Send this event to cancel an in-progress response. The server will respond with
 * a `response.done` event with a status of `response.status=cancelled`. If there
 * is no response to cancel, the server will respond with an error. It's safe to
 * call `response.cancel` even if no response is in progress, an error will be
 * returned the session will remain unaffected.
 */
export interface ResponseCancelEvent {
    /**
     * The event type, must be `response.cancel`.
     */
    type: 'response.cancel';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
    /**
     * A specific response ID to cancel - if not provided, will cancel an in-progress
     * response in the default conversation.
     */
    response_id?: string;
}
/**
 * Returned when a new content part is added to an assistant message item during
 * response generation.
 */
export interface ResponseContentPartAddedEvent {
    /**
     * The index of the content part in the item's content array.
     */
    content_index: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item to which the content part was added.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The content part that was added.
     */
    part: ResponseContentPartAddedEvent.Part;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.content_part.added`.
     */
    type: 'response.content_part.added';
}
export declare namespace ResponseContentPartAddedEvent {
    /**
     * The content part that was added.
     */
    interface Part {
        /**
         * Base64-encoded audio data (if type is "audio").
         */
        audio?: string;
        /**
         * The text content (if type is "text").
         */
        text?: string;
        /**
         * The transcript of the audio (if type is "audio").
         */
        transcript?: string;
        /**
         * The content type ("text", "audio").
         */
        type?: 'text' | 'audio';
    }
}
/**
 * Returned when a content part is done streaming in an assistant message item.
 * Also emitted when a Response is interrupted, incomplete, or cancelled.
 */
export interface ResponseContentPartDoneEvent {
    /**
     * The index of the content part in the item's content array.
     */
    content_index: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The content part that is done.
     */
    part: ResponseContentPartDoneEvent.Part;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.content_part.done`.
     */
    type: 'response.content_part.done';
}
export declare namespace ResponseContentPartDoneEvent {
    /**
     * The content part that is done.
     */
    interface Part {
        /**
         * Base64-encoded audio data (if type is "audio").
         */
        audio?: string;
        /**
         * The text content (if type is "text").
         */
        text?: string;
        /**
         * The transcript of the audio (if type is "audio").
         */
        transcript?: string;
        /**
         * The content type ("text", "audio").
         */
        type?: 'text' | 'audio';
    }
}
/**
 * This event instructs the server to create a Response, which means triggering
 * model inference. When in Server VAD mode, the server will create Responses
 * automatically.
 *
 * A Response will include at least one Item, and may have two, in which case the
 * second will be a function call. These Items will be appended to the conversation
 * history by default.
 *
 * The server will respond with a `response.created` event, events for Items and
 * content created, and finally a `response.done` event to indicate the Response is
 * complete.
 *
 * The `response.create` event includes inference configuration like `instructions`
 * and `tools`. If these are set, they will override the Session's configuration
 * for this Response only.
 *
 * Responses can be created out-of-band of the default Conversation, meaning that
 * they can have arbitrary input, and it's possible to disable writing the output
 * to the Conversation. Only one Response can write to the default Conversation at
 * a time, but otherwise multiple Responses can be created in parallel. The
 * `metadata` field is a good way to disambiguate multiple simultaneous Responses.
 *
 * Clients can set `conversation` to `none` to create a Response that does not
 * write to the default Conversation. Arbitrary input can be provided with the
 * `input` field, which is an array accepting raw Items and references to existing
 * Items.
 */
export interface ResponseCreateEvent {
    /**
     * The event type, must be `response.create`.
     */
    type: 'response.create';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
    /**
     * Create a new Realtime response with these parameters
     */
    response?: RealtimeResponseCreateParams;
}
/**
 * Returned when a new Response is created. The first event of response creation,
 * where the response is in an initial state of `in_progress`.
 */
export interface ResponseCreatedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The response resource.
     */
    response: RealtimeResponse;
    /**
     * The event type, must be `response.created`.
     */
    type: 'response.created';
}
/**
 * Returned when a Response is done streaming. Always emitted, no matter the final
 * state. The Response object included in the `response.done` event will include
 * all output Items in the Response but will omit the raw audio data.
 *
 * Clients should check the `status` field of the Response to determine if it was
 * successful (`completed`) or if there was another outcome: `cancelled`, `failed`,
 * or `incomplete`.
 *
 * A response will contain all output items that were generated during the
 * response, excluding any audio content.
 */
export interface ResponseDoneEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The response resource.
     */
    response: RealtimeResponse;
    /**
     * The event type, must be `response.done`.
     */
    type: 'response.done';
}
/**
 * Returned when the model-generated function call arguments are updated.
 */
export interface ResponseFunctionCallArgumentsDeltaEvent {
    /**
     * The ID of the function call.
     */
    call_id: string;
    /**
     * The arguments delta as a JSON string.
     */
    delta: string;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the function call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.function_call_arguments.delta`.
     */
    type: 'response.function_call_arguments.delta';
}
/**
 * Returned when the model-generated function call arguments are done streaming.
 * Also emitted when a Response is interrupted, incomplete, or cancelled.
 */
export interface ResponseFunctionCallArgumentsDoneEvent {
    /**
     * The final arguments as a JSON string.
     */
    arguments: string;
    /**
     * The ID of the function call.
     */
    call_id: string;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the function call item.
     */
    item_id: string;
    /**
     * The name of the function that was called.
     */
    name: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.function_call_arguments.done`.
     */
    type: 'response.function_call_arguments.done';
}
/**
 * Returned when MCP tool call arguments are updated during response generation.
 */
export interface ResponseMcpCallArgumentsDelta {
    /**
     * The JSON-encoded arguments delta.
     */
    delta: string;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the MCP tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.mcp_call_arguments.delta`.
     */
    type: 'response.mcp_call_arguments.delta';
    /**
     * If present, indicates the delta text was obfuscated.
     */
    obfuscation?: string | null;
}
/**
 * Returned when MCP tool call arguments are finalized during response generation.
 */
export interface ResponseMcpCallArgumentsDone {
    /**
     * The final JSON-encoded arguments string.
     */
    arguments: string;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the MCP tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.mcp_call_arguments.done`.
     */
    type: 'response.mcp_call_arguments.done';
}
/**
 * Returned when an MCP tool call has completed successfully.
 */
export interface ResponseMcpCallCompleted {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the MCP tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The event type, must be `response.mcp_call.completed`.
     */
    type: 'response.mcp_call.completed';
}
/**
 * Returned when an MCP tool call has failed.
 */
export interface ResponseMcpCallFailed {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the MCP tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The event type, must be `response.mcp_call.failed`.
     */
    type: 'response.mcp_call.failed';
}
/**
 * Returned when an MCP tool call has started and is in progress.
 */
export interface ResponseMcpCallInProgress {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the MCP tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The event type, must be `response.mcp_call.in_progress`.
     */
    type: 'response.mcp_call.in_progress';
}
/**
 * Returned when a new Item is created during Response generation.
 */
export interface ResponseOutputItemAddedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * A single item within a Realtime conversation.
     */
    item: ConversationItem;
    /**
     * The index of the output item in the Response.
     */
    output_index: number;
    /**
     * The ID of the Response to which the item belongs.
     */
    response_id: string;
    /**
     * The event type, must be `response.output_item.added`.
     */
    type: 'response.output_item.added';
}
/**
 * Returned when an Item is done streaming. Also emitted when a Response is
 * interrupted, incomplete, or cancelled.
 */
export interface ResponseOutputItemDoneEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * A single item within a Realtime conversation.
     */
    item: ConversationItem;
    /**
     * The index of the output item in the Response.
     */
    output_index: number;
    /**
     * The ID of the Response to which the item belongs.
     */
    response_id: string;
    /**
     * The event type, must be `response.output_item.done`.
     */
    type: 'response.output_item.done';
}
/**
 * Returned when the text value of an "output_text" content part is updated.
 */
export interface ResponseTextDeltaEvent {
    /**
     * The index of the content part in the item's content array.
     */
    content_index: number;
    /**
     * The text delta.
     */
    delta: string;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The event type, must be `response.output_text.delta`.
     */
    type: 'response.output_text.delta';
}
/**
 * Returned when the text value of an "output_text" content part is done streaming.
 * Also emitted when a Response is interrupted, incomplete, or cancelled.
 */
export interface ResponseTextDoneEvent {
    /**
     * The index of the content part in the item's content array.
     */
    content_index: number;
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The ID of the item.
     */
    item_id: string;
    /**
     * The index of the output item in the response.
     */
    output_index: number;
    /**
     * The ID of the response.
     */
    response_id: string;
    /**
     * The final text content.
     */
    text: string;
    /**
     * The event type, must be `response.output_text.done`.
     */
    type: 'response.output_text.done';
}
/**
 * Returned when a Session is created. Emitted automatically when a new connection
 * is established as the first server event. This event will contain the default
 * Session configuration.
 */
export interface SessionCreatedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The session configuration.
     */
    session: RealtimeSessionCreateRequest | RealtimeTranscriptionSessionCreateRequest;
    /**
     * The event type, must be `session.created`.
     */
    type: 'session.created';
}
/**
 * Send this event to update the session’s configuration. The client may send this
 * event at any time to update any field except for `voice` and `model`. `voice`
 * can be updated only if there have been no other audio outputs yet.
 *
 * When the server receives a `session.update`, it will respond with a
 * `session.updated` event showing the full, effective configuration. Only the
 * fields that are present in the `session.update` are updated. To clear a field
 * like `instructions`, pass an empty string. To clear a field like `tools`, pass
 * an empty array. To clear a field like `turn_detection`, pass `null`.
 */
export interface SessionUpdateEvent {
    /**
     * Update the Realtime session. Choose either a realtime session or a transcription
     * session.
     */
    session: RealtimeSessionCreateRequest | RealtimeTranscriptionSessionCreateRequest;
    /**
     * The event type, must be `session.update`.
     */
    type: 'session.update';
    /**
     * Optional client-generated ID used to identify this event. This is an arbitrary
     * string that a client may assign. It will be passed back if there is an error
     * with the event, but the corresponding `session.updated` event will not include
     * it.
     */
    event_id?: string;
}
/**
 * Returned when a session is updated with a `session.update` event, unless there
 * is an error.
 */
export interface SessionUpdatedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * The session configuration.
     */
    session: RealtimeSessionCreateRequest | RealtimeTranscriptionSessionCreateRequest;
    /**
     * The event type, must be `session.updated`.
     */
    type: 'session.updated';
}
/**
 * Send this event to update a transcription session.
 */
export interface TranscriptionSessionUpdate {
    /**
     * Realtime transcription session object configuration.
     */
    session: TranscriptionSessionUpdate.Session;
    /**
     * The event type, must be `transcription_session.update`.
     */
    type: 'transcription_session.update';
    /**
     * Optional client-generated ID used to identify this event.
     */
    event_id?: string;
}
export declare namespace TranscriptionSessionUpdate {
    /**
     * Realtime transcription session object configuration.
     */
    interface Session {
        /**
         * The set of items to include in the transcription. Current available items are:
         * `item.input_audio_transcription.logprobs`
         */
        include?: Array<'item.input_audio_transcription.logprobs'>;
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
         * Configuration for input audio transcription. The client can optionally set the
         * language and prompt for transcription, these offer additional guidance to the
         * transcription service.
         */
        input_audio_transcription?: RealtimeAPI.AudioTranscription;
        /**
         * Configuration for turn detection. Can be set to `null` to turn off. Server VAD
         * means that the model will detect the start and end of speech based on audio
         * volume and respond at the end of user speech.
         */
        turn_detection?: Session.TurnDetection;
    }
    namespace Session {
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
            type?: RealtimeAPI.NoiseReductionType;
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
             * Type of turn detection. Only `server_vad` is currently supported for
             * transcription sessions.
             */
            type?: 'server_vad';
        }
    }
}
/**
 * Returned when a transcription session is updated with a
 * `transcription_session.update` event, unless there is an error.
 */
export interface TranscriptionSessionUpdatedEvent {
    /**
     * The unique ID of the server event.
     */
    event_id: string;
    /**
     * A new Realtime transcription session configuration.
     *
     * When a session is created on the server via REST API, the session object also
     * contains an ephemeral key. Default TTL for keys is 10 minutes. This property is
     * not present when a session is updated via the WebSocket API.
     */
    session: TranscriptionSessionUpdatedEvent.Session;
    /**
     * The event type, must be `transcription_session.updated`.
     */
    type: 'transcription_session.updated';
}
export declare namespace TranscriptionSessionUpdatedEvent {
    /**
     * A new Realtime transcription session configuration.
     *
     * When a session is created on the server via REST API, the session object also
     * contains an ephemeral key. Default TTL for keys is 10 minutes. This property is
     * not present when a session is updated via the WebSocket API.
     */
    interface Session {
        /**
         * Ephemeral key returned by the API. Only present when the session is created on
         * the server via REST API.
         */
        client_secret: Session.ClientSecret;
        /**
         * The format of input audio. Options are `pcm16`, `g711_ulaw`, or `g711_alaw`.
         */
        input_audio_format?: string;
        /**
         * Configuration of the transcription model.
         */
        input_audio_transcription?: RealtimeAPI.AudioTranscription;
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
        turn_detection?: Session.TurnDetection;
    }
    namespace Session {
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
}
export declare namespace Realtime {
    export { type AudioTranscription as AudioTranscription, type ConversationCreatedEvent as ConversationCreatedEvent, type ConversationItem as ConversationItem, type ConversationItemAdded as ConversationItemAdded, type ConversationItemCreateEvent as ConversationItemCreateEvent, type ConversationItemCreatedEvent as ConversationItemCreatedEvent, type ConversationItemDeleteEvent as ConversationItemDeleteEvent, type ConversationItemDeletedEvent as ConversationItemDeletedEvent, type ConversationItemDone as ConversationItemDone, type ConversationItemInputAudioTranscriptionCompletedEvent as ConversationItemInputAudioTranscriptionCompletedEvent, type ConversationItemInputAudioTranscriptionDeltaEvent as ConversationItemInputAudioTranscriptionDeltaEvent, type ConversationItemInputAudioTranscriptionFailedEvent as ConversationItemInputAudioTranscriptionFailedEvent, type ConversationItemInputAudioTranscriptionSegment as ConversationItemInputAudioTranscriptionSegment, type ConversationItemRetrieveEvent as ConversationItemRetrieveEvent, type ConversationItemTruncateEvent as ConversationItemTruncateEvent, type ConversationItemTruncatedEvent as ConversationItemTruncatedEvent, type ConversationItemWithReference as ConversationItemWithReference, type InputAudioBufferAppendEvent as InputAudioBufferAppendEvent, type InputAudioBufferClearEvent as InputAudioBufferClearEvent, type InputAudioBufferClearedEvent as InputAudioBufferClearedEvent, type InputAudioBufferCommitEvent as InputAudioBufferCommitEvent, type InputAudioBufferCommittedEvent as InputAudioBufferCommittedEvent, type InputAudioBufferDtmfEventReceivedEvent as InputAudioBufferDtmfEventReceivedEvent, type InputAudioBufferSpeechStartedEvent as InputAudioBufferSpeechStartedEvent, type InputAudioBufferSpeechStoppedEvent as InputAudioBufferSpeechStoppedEvent, type InputAudioBufferTimeoutTriggered as InputAudioBufferTimeoutTriggered, type LogProbProperties as LogProbProperties, type McpListToolsCompleted as McpListToolsCompleted, type McpListToolsFailed as McpListToolsFailed, type McpListToolsInProgress as McpListToolsInProgress, type NoiseReductionType as NoiseReductionType, type OutputAudioBufferClearEvent as OutputAudioBufferClearEvent, type RateLimitsUpdatedEvent as RateLimitsUpdatedEvent, type RealtimeAudioConfig as RealtimeAudioConfig, type RealtimeAudioConfigInput as RealtimeAudioConfigInput, type RealtimeAudioConfigOutput as RealtimeAudioConfigOutput, type RealtimeAudioFormats as RealtimeAudioFormats, type RealtimeAudioInputTurnDetection as RealtimeAudioInputTurnDetection, type RealtimeClientEvent as RealtimeClientEvent, type RealtimeConversationItemAssistantMessage as RealtimeConversationItemAssistantMessage, type RealtimeConversationItemFunctionCall as RealtimeConversationItemFunctionCall, type RealtimeConversationItemFunctionCallOutput as RealtimeConversationItemFunctionCallOutput, type RealtimeConversationItemSystemMessage as RealtimeConversationItemSystemMessage, type RealtimeConversationItemUserMessage as RealtimeConversationItemUserMessage, type RealtimeError as RealtimeError, type RealtimeErrorEvent as RealtimeErrorEvent, type RealtimeFunctionTool as RealtimeFunctionTool, type RealtimeMcpApprovalRequest as RealtimeMcpApprovalRequest, type RealtimeMcpApprovalResponse as RealtimeMcpApprovalResponse, type RealtimeMcpListTools as RealtimeMcpListTools, type RealtimeMcpProtocolError as RealtimeMcpProtocolError, type RealtimeMcpToolCall as RealtimeMcpToolCall, type RealtimeMcpToolExecutionError as RealtimeMcpToolExecutionError, type RealtimeMcphttpError as RealtimeMcphttpError, type RealtimeResponse as RealtimeResponse, type RealtimeResponseCreateAudioOutput as RealtimeResponseCreateAudioOutput, type RealtimeResponseCreateMcpTool as RealtimeResponseCreateMcpTool, type RealtimeResponseCreateParams as RealtimeResponseCreateParams, type RealtimeResponseStatus as RealtimeResponseStatus, type RealtimeResponseUsage as RealtimeResponseUsage, type RealtimeResponseUsageInputTokenDetails as RealtimeResponseUsageInputTokenDetails, type RealtimeResponseUsageOutputTokenDetails as RealtimeResponseUsageOutputTokenDetails, type RealtimeServerEvent as RealtimeServerEvent, type RealtimeSession as RealtimeSession, type RealtimeSessionCreateRequest as RealtimeSessionCreateRequest, type RealtimeToolChoiceConfig as RealtimeToolChoiceConfig, type RealtimeToolsConfig as RealtimeToolsConfig, type RealtimeToolsConfigUnion as RealtimeToolsConfigUnion, type RealtimeTracingConfig as RealtimeTracingConfig, type RealtimeTranscriptionSessionAudio as RealtimeTranscriptionSessionAudio, type RealtimeTranscriptionSessionAudioInput as RealtimeTranscriptionSessionAudioInput, type RealtimeTranscriptionSessionAudioInputTurnDetection as RealtimeTranscriptionSessionAudioInputTurnDetection, type RealtimeTranscriptionSessionCreateRequest as RealtimeTranscriptionSessionCreateRequest, type RealtimeTruncation as RealtimeTruncation, type RealtimeTruncationRetentionRatio as RealtimeTruncationRetentionRatio, type ResponseAudioDeltaEvent as ResponseAudioDeltaEvent, type ResponseAudioDoneEvent as ResponseAudioDoneEvent, type ResponseAudioTranscriptDeltaEvent as ResponseAudioTranscriptDeltaEvent, type ResponseAudioTranscriptDoneEvent as ResponseAudioTranscriptDoneEvent, type ResponseCancelEvent as ResponseCancelEvent, type ResponseContentPartAddedEvent as ResponseContentPartAddedEvent, type ResponseContentPartDoneEvent as ResponseContentPartDoneEvent, type ResponseCreateEvent as ResponseCreateEvent, type ResponseCreatedEvent as ResponseCreatedEvent, type ResponseDoneEvent as ResponseDoneEvent, type ResponseFunctionCallArgumentsDeltaEvent as ResponseFunctionCallArgumentsDeltaEvent, type ResponseFunctionCallArgumentsDoneEvent as ResponseFunctionCallArgumentsDoneEvent, type ResponseMcpCallArgumentsDelta as ResponseMcpCallArgumentsDelta, type ResponseMcpCallArgumentsDone as ResponseMcpCallArgumentsDone, type ResponseMcpCallCompleted as ResponseMcpCallCompleted, type ResponseMcpCallFailed as ResponseMcpCallFailed, type ResponseMcpCallInProgress as ResponseMcpCallInProgress, type ResponseOutputItemAddedEvent as ResponseOutputItemAddedEvent, type ResponseOutputItemDoneEvent as ResponseOutputItemDoneEvent, type ResponseTextDeltaEvent as ResponseTextDeltaEvent, type ResponseTextDoneEvent as ResponseTextDoneEvent, type SessionCreatedEvent as SessionCreatedEvent, type SessionUpdateEvent as SessionUpdateEvent, type SessionUpdatedEvent as SessionUpdatedEvent, type TranscriptionSessionUpdate as TranscriptionSessionUpdate, type TranscriptionSessionUpdatedEvent as TranscriptionSessionUpdatedEvent, };
    export { ClientSecrets as ClientSecrets, type RealtimeSessionClientSecret as RealtimeSessionClientSecret, type RealtimeSessionCreateResponse as RealtimeSessionCreateResponse, type RealtimeTranscriptionSessionCreateResponse as RealtimeTranscriptionSessionCreateResponse, type RealtimeTranscriptionSessionTurnDetection as RealtimeTranscriptionSessionTurnDetection, type ClientSecretCreateResponse as ClientSecretCreateResponse, type ClientSecretCreateParams as ClientSecretCreateParams, };
    export { Calls as Calls, type CallAcceptParams as CallAcceptParams, type CallReferParams as CallReferParams, type CallRejectParams as CallRejectParams, };
}
//# sourceMappingURL=realtime.d.mts.map