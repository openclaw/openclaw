import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Readable, ReadableOptions } from 'node:stream';
import prism from 'prism-media';
import { VoiceDavePrepareTransitionData, VoiceDavePrepareEpochData, VoiceOpcodes, VoiceSendPayload, VoiceReceivePayload } from 'discord-api-types/voice/v8';
import WebSocket, { MessageEvent } from 'ws';
import { GatewayVoiceServerUpdateDispatchData, GatewayVoiceStateUpdateDispatchData } from 'discord-api-types/v10';

/**
 * The different types of stream that can exist within the pipeline.
 */
declare enum StreamType {
    /**
     * The type of the stream at this point is unknown.
     */
    Arbitrary = "arbitrary",
    /**
     * The stream at this point is Opus audio encoded in an Ogg wrapper.
     */
    OggOpus = "ogg/opus",
    /**
     * The stream at this point is Opus audio, and the stream is in object-mode. This is ready to play.
     */
    Opus = "opus",
    /**
     * The stream at this point is s16le PCM.
     */
    Raw = "raw",
    /**
     * The stream at this point is Opus audio encoded in a WebM wrapper.
     */
    WebmOpus = "webm/opus"
}
/**
 * The different types of transformers that can exist within the pipeline.
 */
declare enum TransformerType {
    FFmpegOgg = "ffmpeg ogg",
    FFmpegPCM = "ffmpeg pcm",
    InlineVolume = "volume transformer",
    OggOpusDemuxer = "ogg/opus demuxer",
    OpusDecoder = "opus decoder",
    OpusEncoder = "opus encoder",
    WebmOpusDemuxer = "webm/opus demuxer"
}
/**
 * Represents a pathway from one stream type to another using a transformer.
 */
interface Edge {
    cost: number;
    from: Node;
    to: Node;
    transformer(input: Readable | string): Readable;
    type: TransformerType;
}
/**
 * Represents a type of stream within the graph, e.g. an Opus stream, or a stream of raw audio.
 */
declare class Node {
    /**
     * The outbound edges from this node.
     */
    readonly edges: Edge[];
    /**
     * The type of stream for this node.
     */
    readonly type: StreamType;
    constructor(type: StreamType);
    /**
     * Creates an outbound edge from this node.
     *
     * @param edge - The edge to create
     */
    addEdge(edge: Omit<Edge, 'from'>): void;
}

/**
 * Options that are set when creating a new audio resource.
 *
 * @typeParam Metadata - the type for the metadata (if any) of the audio resource
 */
interface CreateAudioResourceOptions<Metadata> {
    /**
     * Whether or not inline volume should be enabled. If enabled, you will be able to change the volume
     * of the stream on-the-fly. However, this also increases the performance cost of playback. Defaults to `false`.
     */
    inlineVolume?: boolean;
    /**
     * The type of the input stream. Defaults to `StreamType.Arbitrary`.
     */
    inputType?: StreamType;
    /**
     * Optional metadata that can be attached to the resource (e.g. track title, random id).
     * This is useful for identification purposes when the resource is passed around in events.
     * See {@link AudioResource.metadata}
     */
    metadata?: Metadata;
    /**
     * The number of silence frames to append to the end of the resource's audio stream, to prevent interpolation glitches.
     * Defaults to 5.
     */
    silencePaddingFrames?: number;
}
/**
 * Represents an audio resource that can be played by an audio player.
 *
 * @typeParam Metadata - the type for the metadata (if any) of the audio resource
 */
declare class AudioResource<Metadata = unknown> {
    /**
     * An object-mode Readable stream that emits Opus packets. This is what is played by audio players.
     */
    readonly playStream: Readable;
    /**
     * The pipeline used to convert the input stream into a playable format. For example, this may
     * contain an FFmpeg component for arbitrary inputs, and it may contain a VolumeTransformer component
     * for resources with inline volume transformation enabled.
     */
    readonly edges: readonly Edge[];
    /**
     * Optional metadata that can be used to identify the resource.
     */
    metadata: Metadata;
    /**
     * If the resource was created with inline volume transformation enabled, then this will be a
     * prism-media VolumeTransformer. You can use this to alter the volume of the stream.
     */
    readonly volume?: prism.VolumeTransformer;
    /**
     * If using an Opus encoder to create this audio resource, then this will be a prism-media opus.Encoder.
     * You can use this to control settings such as bitrate, FEC, PLP.
     */
    readonly encoder?: prism.opus.Encoder;
    /**
     * The audio player that the resource is subscribed to, if any.
     */
    audioPlayer?: AudioPlayer | undefined;
    /**
     * The playback duration of this audio resource, given in milliseconds.
     */
    playbackDuration: number;
    /**
     * Whether or not the stream for this resource has started (data has become readable)
     */
    started: boolean;
    /**
     * The number of silence frames to append to the end of the resource's audio stream, to prevent interpolation glitches.
     */
    readonly silencePaddingFrames: number;
    /**
     * The number of remaining silence frames to play. If -1, the frames have not yet started playing.
     */
    silenceRemaining: number;
    constructor(edges: readonly Edge[], streams: readonly Readable[], metadata: Metadata, silencePaddingFrames: number);
    /**
     * Whether this resource is readable. If the underlying resource is no longer readable, this will still return true
     * while there are silence padding frames left to play.
     */
    get readable(): boolean;
    /**
     * Whether this resource has ended or not.
     */
    get ended(): boolean;
    /**
     * Attempts to read an Opus packet from the audio resource. If a packet is available, the playbackDuration
     * is incremented.
     *
     * @remarks
     * It is advisable to check that the playStream is readable before calling this method. While no runtime
     * errors will be thrown, you should check that the resource is still available before attempting to
     * read from it.
     * @internal
     */
    read(): Buffer | null;
}
/**
 * Creates an audio resource that can be played by audio players.
 *
 * @remarks
 * If the input is given as a string, then the inputType option will be overridden and FFmpeg will be used.
 *
 * If the input is not in the correct format, then a pipeline of transcoders and transformers will be created
 * to ensure that the resultant stream is in the correct format for playback. This could involve using FFmpeg,
 * Opus transcoders, and Ogg/WebM demuxers.
 * @param input - The resource to play
 * @param options - Configurable options for creating the resource
 * @typeParam Metadata - the type for the metadata (if any) of the audio resource
 */
declare function createAudioResource<Metadata>(input: Readable | string, options: CreateAudioResourceOptions<Metadata> & Pick<Metadata extends null | undefined ? CreateAudioResourceOptions<Metadata> : Required<CreateAudioResourceOptions<Metadata>>, 'metadata'>): AudioResource<Metadata extends null | undefined ? null : Metadata>;
/**
 * Creates an audio resource that can be played by audio players.
 *
 * @remarks
 * If the input is given as a string, then the inputType option will be overridden and FFmpeg will be used.
 *
 * If the input is not in the correct format, then a pipeline of transcoders and transformers will be created
 * to ensure that the resultant stream is in the correct format for playback. This could involve using FFmpeg,
 * Opus transcoders, and Ogg/WebM demuxers.
 * @param input - The resource to play
 * @param options - Configurable options for creating the resource
 * @typeParam Metadata - the type for the metadata (if any) of the audio resource
 */
declare function createAudioResource<Metadata extends null | undefined>(input: Readable | string, options?: Omit<CreateAudioResourceOptions<Metadata>, 'metadata'>): AudioResource<null>;

/**
 * An error emitted by an AudioPlayer. Contains an attached resource to aid with
 * debugging and identifying where the error came from.
 */
declare class AudioPlayerError extends Error {
    /**
     * The resource associated with the audio player at the time the error was thrown.
     */
    readonly resource: AudioResource;
    constructor(error: Error, resource: AudioResource);
}

/**
 * Represents a subscription of a voice connection to an audio player, allowing
 * the audio player to play audio on the voice connection.
 */
declare class PlayerSubscription {
    /**
     * The voice connection of this subscription.
     */
    readonly connection: VoiceConnection;
    /**
     * The audio player of this subscription.
     */
    readonly player: AudioPlayer;
    constructor(connection: VoiceConnection, player: AudioPlayer);
    /**
     * Unsubscribes the connection from the audio player, meaning that the
     * audio player cannot stream audio to it until a new subscription is made.
     */
    unsubscribe(): void;
}

/**
 * Describes the behavior of the player when an audio packet is played but there are no available
 * voice connections to play to.
 */
declare enum NoSubscriberBehavior {
    /**
     * Pauses playing the stream until a voice connection becomes available.
     */
    Pause = "pause",
    /**
     * Continues to play through the resource regardless.
     */
    Play = "play",
    /**
     * The player stops and enters the Idle state.
     */
    Stop = "stop"
}
declare enum AudioPlayerStatus {
    /**
     * When the player has paused itself. Only possible with the "pause" no subscriber behavior.
     */
    AutoPaused = "autopaused",
    /**
     * When the player is waiting for an audio resource to become readable before transitioning to Playing.
     */
    Buffering = "buffering",
    /**
     * When there is currently no resource for the player to be playing.
     */
    Idle = "idle",
    /**
     * When the player has been manually paused.
     */
    Paused = "paused",
    /**
     * When the player is actively playing an audio resource.
     */
    Playing = "playing"
}
/**
 * Options that can be passed when creating an audio player, used to specify its behavior.
 */
interface CreateAudioPlayerOptions {
    behaviors?: {
        maxMissedFrames?: number;
        noSubscriber?: NoSubscriberBehavior;
    };
    debug?: boolean;
}
/**
 * The state that an AudioPlayer is in when it has no resource to play. This is the starting state.
 */
interface AudioPlayerIdleState {
    status: AudioPlayerStatus.Idle;
}
/**
 * The state that an AudioPlayer is in when it is waiting for a resource to become readable. Once this
 * happens, the AudioPlayer will enter the Playing state. If the resource ends/errors before this, then
 * it will re-enter the Idle state.
 */
interface AudioPlayerBufferingState {
    onFailureCallback: () => void;
    onReadableCallback: () => void;
    onStreamError: (error: Error) => void;
    /**
     * The resource that the AudioPlayer is waiting for
     */
    resource: AudioResource;
    status: AudioPlayerStatus.Buffering;
}
/**
 * The state that an AudioPlayer is in when it is actively playing an AudioResource. When playback ends,
 * it will enter the Idle state.
 */
interface AudioPlayerPlayingState {
    /**
     * The number of consecutive times that the audio resource has been unable to provide an Opus frame.
     */
    missedFrames: number;
    onStreamError: (error: Error) => void;
    /**
     * The playback duration in milliseconds of the current audio resource. This includes filler silence packets
     * that have been played when the resource was buffering.
     */
    playbackDuration: number;
    /**
     * The resource that is being played.
     */
    resource: AudioResource;
    status: AudioPlayerStatus.Playing;
}
/**
 * The state that an AudioPlayer is in when it has either been explicitly paused by the user, or done
 * automatically by the AudioPlayer itself if there are no available subscribers.
 */
interface AudioPlayerPausedState {
    onStreamError: (error: Error) => void;
    /**
     * The playback duration in milliseconds of the current audio resource. This includes filler silence packets
     * that have been played when the resource was buffering.
     */
    playbackDuration: number;
    /**
     * The current resource of the audio player.
     */
    resource: AudioResource;
    /**
     * How many silence packets still need to be played to avoid audio interpolation due to the stream suddenly pausing.
     */
    silencePacketsRemaining: number;
    status: AudioPlayerStatus.AutoPaused | AudioPlayerStatus.Paused;
}
/**
 * The various states that the player can be in.
 */
type AudioPlayerState = AudioPlayerBufferingState | AudioPlayerIdleState | AudioPlayerPausedState | AudioPlayerPlayingState;
interface AudioPlayer extends EventEmitter {
    /**
     * Emitted when there is an error emitted from the audio resource played by the audio player
     *
     * @eventProperty
     */
    on(event: 'error', listener: (error: AudioPlayerError) => void): this;
    /**
     * Emitted debugging information about the audio player
     *
     * @eventProperty
     */
    on(event: 'debug', listener: (message: string) => void): this;
    /**
     * Emitted when the state of the audio player changes
     *
     * @eventProperty
     */
    on(event: 'stateChange', listener: (oldState: AudioPlayerState, newState: AudioPlayerState) => void): this;
    /**
     * Emitted when the audio player is subscribed to a voice connection
     *
     * @eventProperty
     */
    on(event: 'subscribe' | 'unsubscribe', listener: (subscription: PlayerSubscription) => void): this;
    /**
     * Emitted when the status of state changes to a specific status
     *
     * @eventProperty
     */
    on<Event extends AudioPlayerStatus>(event: Event, listener: (oldState: AudioPlayerState, newState: AudioPlayerState & {
        status: Event;
    }) => void): this;
}
/**
 * Used to play audio resources (i.e. tracks, streams) to voice connections.
 *
 * @remarks
 * Audio players are designed to be re-used - even if a resource has finished playing, the player itself
 * can still be used.
 *
 * The AudioPlayer drives the timing of playback, and therefore is unaffected by voice connections
 * becoming unavailable. Its behavior in these scenarios can be configured.
 */
declare class AudioPlayer extends EventEmitter {
    /**
     * The state that the AudioPlayer is in.
     */
    private _state;
    /**
     * A list of VoiceConnections that are registered to this AudioPlayer. The player will attempt to play audio
     * to the streams in this list.
     */
    private readonly subscribers;
    /**
     * The behavior that the player should follow when it enters certain situations.
     */
    private readonly behaviors;
    /**
     * The debug logger function, if debugging is enabled.
     */
    private readonly debug;
    /**
     * Creates a new AudioPlayer.
     */
    constructor(options?: CreateAudioPlayerOptions);
    /**
     * A list of subscribed voice connections that can currently receive audio to play.
     */
    get playable(): VoiceConnection[];
    /**
     * Subscribes a VoiceConnection to the audio player's play list. If the VoiceConnection is already subscribed,
     * then the existing subscription is used.
     *
     * @remarks
     * This method should not be directly called. Instead, use VoiceConnection#subscribe.
     * @param connection - The connection to subscribe
     * @returns The new subscription if the voice connection is not yet subscribed, otherwise the existing subscription
     */
    private subscribe;
    /**
     * Unsubscribes a subscription - i.e. removes a voice connection from the play list of the audio player.
     *
     * @remarks
     * This method should not be directly called. Instead, use PlayerSubscription#unsubscribe.
     * @param subscription - The subscription to remove
     * @returns Whether or not the subscription existed on the player and was removed
     */
    private unsubscribe;
    /**
     * The state that the player is in.
     *
     * @remarks
     * The setter will perform clean-up operations where necessary.
     */
    get state(): AudioPlayerState;
    set state(newState: AudioPlayerState);
    /**
     * Plays a new resource on the player. If the player is already playing a resource, the existing resource is destroyed
     * (it cannot be reused, even in another player) and is replaced with the new resource.
     *
     * @remarks
     * The player will transition to the Playing state once playback begins, and will return to the Idle state once
     * playback is ended.
     *
     * If the player was previously playing a resource and this method is called, the player will not transition to the
     * Idle state during the swap over.
     * @param resource - The resource to play
     * @throws Will throw if attempting to play an audio resource that has already ended, or is being played by another player
     */
    play<Metadata>(resource: AudioResource<Metadata>): void;
    /**
     * Pauses playback of the current resource, if any.
     *
     * @param interpolateSilence - If true, the player will play 5 packets of silence after pausing to prevent audio glitches
     * @returns `true` if the player was successfully paused, otherwise `false`
     */
    pause(interpolateSilence?: boolean): boolean;
    /**
     * Unpauses playback of the current resource, if any.
     *
     * @returns `true` if the player was successfully unpaused, otherwise `false`
     */
    unpause(): boolean;
    /**
     * Stops playback of the current resource and destroys the resource. The player will either transition to the Idle state,
     * or remain in its current state until the silence padding frames of the resource have been played.
     *
     * @param force - If true, will force the player to enter the Idle state even if the resource has silence padding frames
     * @returns `true` if the player will come to a stop, otherwise `false`
     */
    stop(force?: boolean): boolean;
    /**
     * Checks whether the underlying resource (if any) is playable (readable)
     *
     * @returns `true` if the resource is playable, otherwise `false`
     */
    checkPlayable(): boolean;
    /**
     * Called roughly every 20ms by the global audio player timer. Dispatches any audio packets that are buffered
     * by the active connections of this audio player.
     */
    private _stepDispatch;
    /**
     * Called roughly every 20ms by the global audio player timer. Attempts to read an audio packet from the
     * underlying resource of the stream, and then has all the active connections of the audio player prepare it
     * (encrypt it, append header data) so that it is ready to play at the start of the next cycle.
     */
    private _stepPrepare;
    /**
     * Signals to all the subscribed connections that they should send a packet to Discord indicating
     * they are no longer speaking. Called once playback of a resource ends.
     */
    private _signalStopSpeaking;
    /**
     * Instructs the given connections to each prepare this packet to be played at the start of the
     * next cycle.
     *
     * @param packet - The Opus packet to be prepared by each receiver
     * @param receivers - The connections that should play this packet
     */
    private _preparePacket;
}
/**
 * Creates a new AudioPlayer to be used.
 */
declare function createAudioPlayer(options?: CreateAudioPlayerOptions): AudioPlayer;

interface JoinConfig {
    channelId: string | null;
    group: string;
    guildId: string;
    selfDeaf: boolean;
    selfMute: boolean;
}
/**
 * Retrieves the map of group names to maps of voice connections. By default, all voice connections
 * are created under the 'default' group.
 *
 * @returns The group map
 */
declare function getGroups(): Map<string, Map<string, VoiceConnection>>;
/**
 * Retrieves all the voice connections under the 'default' group.
 *
 * @param group - The group to look up
 * @returns The map of voice connections
 */
declare function getVoiceConnections(group?: 'default'): Map<string, VoiceConnection>;
/**
 * Retrieves all the voice connections under the given group name.
 *
 * @param group - The group to look up
 * @returns The map of voice connections
 */
declare function getVoiceConnections(group: string): Map<string, VoiceConnection> | undefined;
/**
 * Finds a voice connection with the given guild id and group. Defaults to the 'default' group.
 *
 * @param guildId - The guild id of the voice connection
 * @param group - the group that the voice connection was registered with
 * @returns The voice connection, if it exists
 */
declare function getVoiceConnection(guildId: string, group?: string): VoiceConnection | undefined;

interface SessionMethods {
    canPassthrough(userId: string): boolean;
    decrypt(userId: string, mediaType: 0 | 1, packet: Buffer): Buffer;
    encryptOpus(packet: Buffer): Buffer;
    getSerializedKeyPackage(): Buffer;
    getVerificationCode(userId: string): Promise<string>;
    processCommit(commit: Buffer): void;
    processProposals(optype: 0 | 1, proposals: Buffer, recognizedUserIds?: string[]): ProposalsResult;
    processWelcome(welcome: Buffer): void;
    ready: boolean;
    reinit(protocolVersion: number, userId: string, channelId: string): void;
    reset(): void;
    setExternalSender(externalSender: Buffer): void;
    setPassthroughMode(passthrough: boolean, expiry: number): void;
    voicePrivacyCode: string;
}
interface ProposalsResult {
    commit?: Buffer;
    welcome?: Buffer;
}
interface TransitionResult {
    success: boolean;
    transitionId: number;
}
/**
 * Options that dictate the session behavior.
 */
interface DAVESessionOptions {
    decryptionFailureTolerance?: number | undefined;
}
interface DAVESession extends EventEmitter {
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'debug', listener: (message: string) => void): this;
    on(event: 'keyPackage', listener: (message: Buffer) => void): this;
    on(event: 'invalidateTransition', listener: (transitionId: number) => void): this;
}
/**
 * Manages the DAVE protocol group session.
 */
declare class DAVESession extends EventEmitter {
    /**
     * The channel id represented by this session.
     */
    channelId: string;
    /**
     * The user id represented by this session.
     */
    userId: string;
    /**
     * The protocol version being used.
     */
    protocolVersion: number;
    /**
     * The last transition id executed.
     */
    lastTransitionId?: number | undefined;
    /**
     * The pending transitions, mapped by their ID and the protocol version.
     */
    private pendingTransitions;
    /**
     * Whether this session was downgraded previously.
     */
    private downgraded;
    /**
     * The amount of consecutive failures encountered when decrypting.
     */
    private consecutiveFailures;
    /**
     * The amount of consecutive failures needed to attempt to recover.
     */
    private readonly failureTolerance;
    /**
     * Whether this session is currently re-initializing due to an invalid transition.
     */
    reinitializing: boolean;
    /**
     * The underlying DAVE Session of this wrapper.
     */
    session: SessionMethods | undefined;
    constructor(protocolVersion: number, userId: string, channelId: string, options: DAVESessionOptions);
    /**
     * The current voice privacy code of the session. Will be `null` if there is no session.
     */
    get voicePrivacyCode(): string | null;
    /**
     * Gets the verification code for a user in the session.
     *
     * @throws Will throw if there is not an active session or the user id provided is invalid or not in the session.
     */
    getVerificationCode(userId: string): Promise<string>;
    /**
     * Re-initializes (or initializes) the underlying session.
     */
    reinit(): void;
    /**
     * Set the external sender for this session.
     *
     * @param externalSender - The external sender
     */
    setExternalSender(externalSender: Buffer): void;
    /**
     * Prepare for a transition.
     *
     * @param data - The transition data
     * @returns Whether we should signal to the voice server that we are ready
     */
    prepareTransition(data: VoiceDavePrepareTransitionData): boolean;
    /**
     * Execute a transition.
     *
     * @param transitionId - The transition id to execute on
     */
    executeTransition(transitionId: number): boolean;
    /**
     * Prepare for a new epoch.
     *
     * @param data - The epoch data
     */
    prepareEpoch(data: VoiceDavePrepareEpochData): void;
    /**
     * Recover from an invalid transition by re-initializing.
     *
     * @param transitionId - The transition id to invalidate
     */
    recoverFromInvalidTransition(transitionId: number): void;
    /**
     * Processes proposals from the MLS group.
     *
     * @param payload - The binary message payload
     * @param connectedClients - The set of connected client IDs
     * @returns The payload to send back to the voice server, if there is one
     */
    processProposals(payload: Buffer, connectedClients: Set<string>): Buffer | undefined;
    /**
     * Processes a commit from the MLS group.
     *
     * @param payload - The payload
     * @returns The transaction id and whether it was successful
     */
    processCommit(payload: Buffer): TransitionResult;
    /**
     * Processes a welcome from the MLS group.
     *
     * @param payload - The payload
     * @returns The transaction id and whether it was successful
     */
    processWelcome(payload: Buffer): TransitionResult;
    /**
     * Encrypt a packet using end-to-end encryption.
     *
     * @param packet - The packet to encrypt
     */
    encrypt(packet: Buffer): Buffer<ArrayBufferLike>;
    /**
     * Decrypt a packet using end-to-end encryption.
     *
     * @param packet - The packet to decrypt
     * @param userId - The user id that sent the packet
     * @returns The decrypted packet, or `null` if the decryption failed but should be ignored
     */
    decrypt(packet: Buffer, userId: string): Buffer<ArrayBufferLike> | null;
    /**
     * Resets the session.
     */
    destroy(): void;
}

/**
 * Stores an IP address and port. Used to store socket details for the local client as well as
 * for Discord.
 */
interface SocketConfig {
    ip: string;
    port: number;
}
interface VoiceUDPSocket extends EventEmitter {
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'debug', listener: (message: string) => void): this;
    on(event: 'message', listener: (message: Buffer) => void): this;
}
/**
 * Manages the UDP networking for a voice connection.
 */
declare class VoiceUDPSocket extends EventEmitter {
    /**
     * The underlying network Socket for the VoiceUDPSocket.
     */
    private readonly socket;
    /**
     * The socket details for Discord (remote)
     */
    private readonly remote;
    /**
     * The counter used in the keep alive mechanism.
     */
    private keepAliveCounter;
    /**
     * The buffer used to write the keep alive counter into.
     */
    private readonly keepAliveBuffer;
    /**
     * The Node.js interval for the keep-alive mechanism.
     */
    private readonly keepAliveInterval;
    /**
     * The time taken to receive a response to keep alive messages.
     *
     * @deprecated This field is no longer updated as keep alive messages are no longer tracked.
     */
    ping?: number;
    /**
     * Creates a new VoiceUDPSocket.
     *
     * @param remote - Details of the remote socket
     */
    constructor(remote: SocketConfig);
    /**
     * Called when a message is received on the UDP socket.
     *
     * @param buffer - The received buffer
     */
    private onMessage;
    /**
     * Called at a regular interval to check whether we are still able to send datagrams to Discord.
     */
    private keepAlive;
    /**
     * Sends a buffer to Discord.
     *
     * @param buffer - The buffer to send
     */
    send(buffer: Buffer): void;
    /**
     * Closes the socket, the instance will not be able to be reused.
     */
    destroy(): void;
    /**
     * Performs IP discovery to discover the local address and port to be used for the voice connection.
     *
     * @param ssrc - The SSRC received from Discord
     */
    performIPDiscovery(ssrc: number): Promise<SocketConfig>;
}

/**
 * A binary WebSocket message.
 */
interface BinaryWebSocketMessage {
    op: VoiceOpcodes;
    payload: Buffer;
    seq: number;
}
interface VoiceWebSocket extends EventEmitter {
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'open', listener: (event: WebSocket.Event) => void): this;
    on(event: 'close', listener: (event: WebSocket.CloseEvent) => void): this;
    /**
     * Debug event for VoiceWebSocket.
     *
     * @eventProperty
     */
    on(event: 'debug', listener: (message: string) => void): this;
    /**
     * Packet event.
     *
     * @eventProperty
     */
    on(event: 'packet', listener: (packet: any) => void): this;
    /**
     * Binary message event.
     *
     * @eventProperty
     */
    on(event: 'binary', listener: (message: BinaryWebSocketMessage) => void): this;
}
/**
 * An extension of the WebSocket class to provide helper functionality when interacting
 * with the Discord Voice gateway.
 */
declare class VoiceWebSocket extends EventEmitter {
    /**
     * The current heartbeat interval, if any.
     */
    private heartbeatInterval?;
    /**
     * The time (milliseconds since UNIX epoch) that the last heartbeat acknowledgement packet was received.
     * This is set to 0 if an acknowledgement packet hasn't been received yet.
     */
    private lastHeartbeatAck;
    /**
     * The time (milliseconds since UNIX epoch) that the last heartbeat was sent. This is set to 0 if a heartbeat
     * hasn't been sent yet.
     */
    private lastHeartbeatSend;
    /**
     * The number of consecutively missed heartbeats.
     */
    private missedHeartbeats;
    /**
     * The last recorded ping.
     */
    ping?: number;
    /**
     * The last sequence number acknowledged from Discord. Will be `-1` if no sequence numbered messages have been received.
     */
    sequence: number;
    /**
     * The debug logger function, if debugging is enabled.
     */
    private readonly debug;
    /**
     * The underlying WebSocket of this wrapper.
     */
    private readonly ws;
    /**
     * Creates a new VoiceWebSocket.
     *
     * @param address - The address to connect to
     */
    constructor(address: string, debug: boolean);
    /**
     * Destroys the VoiceWebSocket. The heartbeat interval is cleared, and the connection is closed.
     */
    destroy(): void;
    /**
     * Handles message events on the WebSocket. Attempts to JSON parse the messages and emit them
     * as packets. Binary messages will be parsed and emitted.
     *
     * @param event - The message event
     */
    onMessage(event: MessageEvent): void;
    /**
     * Sends a JSON-stringifiable packet over the WebSocket.
     *
     * @param packet - The packet to send
     */
    sendPacket(packet: VoiceSendPayload): void;
    /**
     * Sends a binary message over the WebSocket.
     *
     * @param opcode - The opcode to use
     * @param payload - The payload to send
     */
    sendBinaryMessage(opcode: VoiceOpcodes, payload: Buffer): void;
    /**
     * Sends a heartbeat over the WebSocket.
     */
    private sendHeartbeat;
    /**
     * Sets/clears an interval to send heartbeats over the WebSocket.
     *
     * @param ms - The interval in milliseconds. If negative, the interval will be unset
     */
    setHeartbeatInterval(ms: number): void;
}

/**
 * The different statuses that a networking instance can hold. The order
 * of the states between OpeningWs and Ready is chronological (first the
 * instance enters OpeningWs, then it enters Identifying etc.)
 */
declare enum NetworkingStatusCode {
    OpeningWs = 0,
    Identifying = 1,
    UdpHandshaking = 2,
    SelectingProtocol = 3,
    Ready = 4,
    Resuming = 5,
    Closed = 6
}
/**
 * The initial Networking state. Instances will be in this state when a WebSocket connection to a Discord
 * voice gateway is being opened.
 */
interface NetworkingOpeningWsState {
    code: NetworkingStatusCode.OpeningWs;
    connectionOptions: ConnectionOptions;
    ws: VoiceWebSocket;
}
/**
 * The state that a Networking instance will be in when it is attempting to authorize itself.
 */
interface NetworkingIdentifyingState {
    code: NetworkingStatusCode.Identifying;
    connectionOptions: ConnectionOptions;
    ws: VoiceWebSocket;
}
/**
 * The state that a Networking instance will be in when opening a UDP connection to the IP and port provided
 * by Discord, as well as performing IP discovery.
 */
interface NetworkingUdpHandshakingState {
    code: NetworkingStatusCode.UdpHandshaking;
    connectionData: Pick<ConnectionData, 'connectedClients' | 'ssrc'>;
    connectionOptions: ConnectionOptions;
    udp: VoiceUDPSocket;
    ws: VoiceWebSocket;
}
/**
 * The state that a Networking instance will be in when selecting an encryption protocol for audio packets.
 */
interface NetworkingSelectingProtocolState {
    code: NetworkingStatusCode.SelectingProtocol;
    connectionData: Pick<ConnectionData, 'connectedClients' | 'ssrc'>;
    connectionOptions: ConnectionOptions;
    udp: VoiceUDPSocket;
    ws: VoiceWebSocket;
}
/**
 * The state that a Networking instance will be in when it has a fully established connection to a Discord
 * voice server.
 */
interface NetworkingReadyState {
    code: NetworkingStatusCode.Ready;
    connectionData: ConnectionData;
    connectionOptions: ConnectionOptions;
    dave?: DAVESession | undefined;
    preparedPacket?: Buffer | undefined;
    udp: VoiceUDPSocket;
    ws: VoiceWebSocket;
}
/**
 * The state that a Networking instance will be in when its connection has been dropped unexpectedly, and it
 * is attempting to resume an existing session.
 */
interface NetworkingResumingState {
    code: NetworkingStatusCode.Resuming;
    connectionData: ConnectionData;
    connectionOptions: ConnectionOptions;
    dave?: DAVESession | undefined;
    preparedPacket?: Buffer | undefined;
    udp: VoiceUDPSocket;
    ws: VoiceWebSocket;
}
/**
 * The state that a Networking instance will be in when it has been destroyed. It cannot be recovered from this
 * state.
 */
interface NetworkingClosedState {
    code: NetworkingStatusCode.Closed;
}
/**
 * The various states that a networking instance can be in.
 */
type NetworkingState = NetworkingClosedState | NetworkingIdentifyingState | NetworkingOpeningWsState | NetworkingReadyState | NetworkingResumingState | NetworkingSelectingProtocolState | NetworkingUdpHandshakingState;
/**
 * Details required to connect to the Discord voice gateway. These details
 * are first received on the main bot gateway, in the form of VOICE_SERVER_UPDATE
 * and VOICE_STATE_UPDATE packets.
 */
interface ConnectionOptions {
    channelId: string;
    endpoint: string;
    serverId: string;
    sessionId: string;
    token: string;
    userId: string;
}
/**
 * Information about the current connection, e.g. which encryption mode is to be used on
 * the connection, timing information for playback of streams.
 */
interface ConnectionData {
    connectedClients: Set<string>;
    encryptionMode: string;
    nonce: number;
    nonceBuffer: Buffer;
    packetsPlayed: number;
    secretKey: Uint8Array;
    sequence: number;
    speaking: boolean;
    ssrc: number;
    timestamp: number;
}
/**
 * Options for networking that dictate behavior.
 */
interface NetworkingOptions {
    daveEncryption?: boolean | undefined;
    debug?: boolean | undefined;
    decryptionFailureTolerance?: number | undefined;
}
interface Networking extends EventEmitter {
    /**
     * Debug event for Networking.
     *
     * @eventProperty
     */
    on(event: 'debug', listener: (message: string) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'stateChange', listener: (oldState: NetworkingState, newState: NetworkingState) => void): this;
    on(event: 'close', listener: (code: number) => void): this;
    on(event: 'transitioned', listener: (transitionId: number) => void): this;
}
/**
 * Manages the networking required to maintain a voice connection and dispatch audio packets
 */
declare class Networking extends EventEmitter {
    private _state;
    /**
     * The debug logger function, if debugging is enabled.
     */
    private readonly debug;
    /**
     * The options used to create this Networking instance.
     */
    private readonly options;
    /**
     * Creates a new Networking instance.
     */
    constructor(connectionOptions: ConnectionOptions, options: NetworkingOptions);
    /**
     * Destroys the Networking instance, transitioning it into the Closed state.
     */
    destroy(): void;
    /**
     * The current state of the networking instance.
     *
     * @remarks
     * The setter will perform clean-up operations where necessary.
     */
    get state(): NetworkingState;
    set state(newState: NetworkingState);
    /**
     * Creates a new WebSocket to a Discord Voice gateway.
     *
     * @param endpoint - The endpoint to connect to
     * @param lastSequence - The last sequence to set for this WebSocket
     */
    private createWebSocket;
    /**
     * Creates a new DAVE session for this voice connection if we can create one.
     *
     * @param protocolVersion - The protocol version to use
     */
    private createDaveSession;
    /**
     * Propagates errors from the children VoiceWebSocket, VoiceUDPSocket and DAVESession.
     *
     * @param error - The error that was emitted by a child
     */
    private onChildError;
    /**
     * Called when the WebSocket opens. Depending on the state that the instance is in,
     * it will either identify with a new session, or it will attempt to resume an existing session.
     */
    private onWsOpen;
    /**
     * Called when the WebSocket closes. Based on the reason for closing (given by the code parameter),
     * the instance will either attempt to resume, or enter the closed state and emit a 'close' event
     * with the close code, allowing the user to decide whether or not they would like to reconnect.
     *
     * @param code - The close code
     */
    private onWsClose;
    /**
     * Called when the UDP socket has closed itself if it has stopped receiving replies from Discord.
     */
    private onUdpClose;
    /**
     * Called when a packet is received on the connection's WebSocket.
     *
     * @param packet - The received packet
     */
    private onWsPacket;
    /**
     * Called when a binary message is received on the connection's WebSocket.
     *
     * @param message - The received message
     */
    private onWsBinary;
    /**
     * Called when a new key package is ready to be sent to the voice server.
     *
     * @param keyPackage - The new key package
     */
    private onDaveKeyPackage;
    /**
     * Called when the DAVE session wants to invalidate their transition and re-initialize.
     *
     * @param transitionId - The transition to invalidate
     */
    private onDaveInvalidateTransition;
    /**
     * Propagates debug messages from the child WebSocket.
     *
     * @param message - The emitted debug message
     */
    private onWsDebug;
    /**
     * Propagates debug messages from the child UDPSocket.
     *
     * @param message - The emitted debug message
     */
    private onUdpDebug;
    /**
     * Propagates debug messages from the child DAVESession.
     *
     * @param message - The emitted debug message
     */
    private onDaveDebug;
    /**
     * Prepares an Opus packet for playback. This includes attaching metadata to it and encrypting it.
     * It will be stored within the instance, and can be played by dispatchAudio()
     *
     * @remarks
     * Calling this method while there is already a prepared audio packet that has not yet been dispatched
     * will overwrite the existing audio packet. This should be avoided.
     * @param opusPacket - The Opus packet to encrypt
     * @returns The audio packet that was prepared
     */
    prepareAudioPacket(opusPacket: Buffer): Buffer<ArrayBufferLike> | undefined;
    /**
     * Dispatches the audio packet previously prepared by prepareAudioPacket(opusPacket). The audio packet
     * is consumed and cannot be dispatched again.
     */
    dispatchAudio(): boolean;
    /**
     * Plays an audio packet, updating timing metadata used for playback.
     *
     * @param audioPacket - The audio packet to play
     */
    private playAudioPacket;
    /**
     * Sends a packet to the voice gateway indicating that the client has start/stopped sending
     * audio.
     *
     * @param speaking - Whether or not the client should be shown as speaking
     */
    setSpeaking(speaking: boolean): void;
    /**
     * Creates a new audio packet from an Opus packet. This involves encrypting the packet,
     * then prepending a header that includes metadata.
     *
     * @param opusPacket - The Opus packet to prepare
     * @param connectionData - The current connection data of the instance
     * @param daveSession - The DAVE session to use for encryption
     */
    private createAudioPacket;
    /**
     * Encrypts an Opus packet using the format agreed upon by the instance and Discord.
     *
     * @param opusPacket - The Opus packet to encrypt
     * @param connectionData - The current connection data of the instance
     * @param daveSession - The DAVE session to use for encryption
     */
    private encryptOpusPacket;
}

/**
 * The different behaviors an audio receive stream can have for deciding when to end.
 */
declare enum EndBehaviorType {
    /**
     * The stream will only end when manually destroyed.
     */
    Manual = 0,
    /**
     * The stream will end after a given time period of silence/no audio packets.
     */
    AfterSilence = 1,
    /**
     * The stream will end after a given time period of no audio packets.
     */
    AfterInactivity = 2
}
type EndBehavior = {
    behavior: EndBehaviorType.AfterInactivity | EndBehaviorType.AfterSilence;
    duration: number;
} | {
    behavior: EndBehaviorType.Manual;
};
interface AudioReceiveStreamOptions extends ReadableOptions {
    end: EndBehavior;
}
declare function createDefaultAudioReceiveStreamOptions(): AudioReceiveStreamOptions;
/**
 * A readable stream of Opus packets received from a specific entity
 * in a Discord voice connection.
 */
declare class AudioReceiveStream extends Readable {
    /**
     * The end behavior of the receive stream.
     */
    readonly end: EndBehavior;
    private endTimeout?;
    constructor(options: AudioReceiveStreamOptions);
    push(buffer: Buffer | null): boolean;
    private renewEndTimeout;
    _read(): void;
}

/**
 * The known data for a user in a Discord voice connection.
 */
interface VoiceUserData {
    /**
     * The SSRC of the user's audio stream.
     */
    audioSSRC: number;
    /**
     * The Discord user id of the user.
     */
    userId: string;
    /**
     * The SSRC of the user's video stream (if one exists)
     * Cannot be 0. If undefined, the user has no video stream.
     */
    videoSSRC?: number;
}
interface SSRCMap extends EventEmitter {
    on(event: 'create', listener: (newData: VoiceUserData) => void): this;
    on(event: 'update', listener: (oldData: VoiceUserData | undefined, newData: VoiceUserData) => void): this;
    on(event: 'delete', listener: (deletedData: VoiceUserData) => void): this;
}
/**
 * Maps audio SSRCs to data of users in voice connections.
 */
declare class SSRCMap extends EventEmitter {
    /**
     * The underlying map.
     */
    private readonly map;
    constructor();
    /**
     * Updates the map with new user data
     *
     * @param data - The data to update with
     */
    update(data: VoiceUserData): void;
    /**
     * Gets the stored voice data of a user.
     *
     * @param target - The target, either their user id or audio SSRC
     */
    get(target: number | string): VoiceUserData | undefined;
    /**
     * Deletes the stored voice data about a user.
     *
     * @param target - The target of the delete operation, either their audio SSRC or user id
     * @returns The data that was deleted, if any
     */
    delete(target: number | string): VoiceUserData | undefined;
}

interface SpeakingMap extends EventEmitter {
    /**
     * Emitted when a user starts speaking.
     *
     * @eventProperty
     */
    on(event: 'start', listener: (userId: string) => void): this;
    /**
     * Emitted when a user ends speaking.
     *
     * @eventProperty
     */
    on(event: 'end', listener: (userId: string) => void): this;
}
/**
 * Tracks the speaking states of users in a voice channel.
 */
declare class SpeakingMap extends EventEmitter {
    /**
     * The delay after a packet is received from a user until they're marked as not speaking anymore.
     */
    static readonly DELAY = 100;
    /**
     * The currently speaking users, mapped to the milliseconds since UNIX epoch at which they started speaking.
     */
    readonly users: Map<string, number>;
    private readonly speakingTimeouts;
    constructor();
    onPacket(userId: string): void;
    private startTimeout;
}

/**
 * Attaches to a VoiceConnection, allowing you to receive audio packets from other
 * users that are speaking.
 *
 * @beta
 */
declare class VoiceReceiver {
    /**
     * The attached connection of this receiver.
     */
    readonly voiceConnection: VoiceConnection;
    /**
     * Maps SSRCs to Discord user ids.
     */
    readonly ssrcMap: SSRCMap;
    /**
     * The current audio subscriptions of this receiver.
     */
    readonly subscriptions: Map<string, AudioReceiveStream>;
    /**
     * The connection data of the receiver.
     *
     * @internal
     */
    connectionData: Partial<ConnectionData>;
    /**
     * The speaking map of the receiver.
     */
    readonly speaking: SpeakingMap;
    constructor(voiceConnection: VoiceConnection);
    /**
     * Called when a packet is received on the attached connection's WebSocket.
     *
     * @param packet - The received packet
     * @internal
     */
    onWsPacket(packet: VoiceReceivePayload): void;
    private decrypt;
    /**
     * Parses an audio packet, decrypting it to yield an Opus packet.
     *
     * @param buffer - The buffer to parse
     * @param mode - The encryption mode
     * @param nonce - The nonce buffer used by the connection for encryption
     * @param secretKey - The secret key used by the connection for encryption
     * @param userId - The user id that sent the packet
     * @returns The parsed Opus packet
     */
    private parsePacket;
    /**
     * Called when the UDP socket of the attached connection receives a message.
     *
     * @param msg - The received message
     * @internal
     */
    onUdpMessage(msg: Buffer): void;
    /**
     * Creates a subscription for the given user id.
     *
     * @param target - The id of the user to subscribe to
     * @returns A readable stream of Opus packets received from the target
     */
    subscribe(userId: string, options?: Partial<AudioReceiveStreamOptions>): AudioReceiveStream;
}

/**
 * Methods that are provided by the \@discordjs/voice library to implementations of
 * Discord gateway DiscordGatewayAdapters.
 */
interface DiscordGatewayAdapterLibraryMethods {
    /**
     * Call this when the adapter can no longer be used (e.g. due to a disconnect from the main gateway)
     */
    destroy(): void;
    /**
     * Call this when you receive a VOICE_SERVER_UPDATE payload that is relevant to the adapter.
     *
     * @param data - The inner data of the VOICE_SERVER_UPDATE payload
     */
    onVoiceServerUpdate(data: GatewayVoiceServerUpdateDispatchData): void;
    /**
     * Call this when you receive a VOICE_STATE_UPDATE payload that is relevant to the adapter.
     *
     * @param data - The inner data of the VOICE_STATE_UPDATE payload
     */
    onVoiceStateUpdate(data: GatewayVoiceStateUpdateDispatchData): void;
}
/**
 * Methods that are provided by the implementer of a Discord gateway DiscordGatewayAdapter.
 */
interface DiscordGatewayAdapterImplementerMethods {
    /**
     * This will be called by \@discordjs/voice when the adapter can safely be destroyed as it will no
     * longer be used.
     */
    destroy(): void;
    /**
     * Implement this method such that the given payload is sent to the main Discord gateway connection.
     *
     * @param payload - The payload to send to the main Discord gateway connection
     * @returns `false` if the payload definitely failed to send - in this case, the voice connection disconnects
     */
    sendPayload(payload: any): boolean;
}
/**
 * A function used to build adapters. It accepts a methods parameter that contains functions that
 * can be called by the implementer when new data is received on its gateway connection. In return,
 * the implementer will return some methods that the library can call - e.g. to send messages on
 * the gateway, or to signal that the adapter can be removed.
 */
type DiscordGatewayAdapterCreator = (methods: DiscordGatewayAdapterLibraryMethods) => DiscordGatewayAdapterImplementerMethods;

/**
 * The various status codes a voice connection can hold at any one time.
 */
declare enum VoiceConnectionStatus {
    /**
     * The `VOICE_SERVER_UPDATE` and `VOICE_STATE_UPDATE` packets have been received, now attempting to establish a voice connection.
     */
    Connecting = "connecting",
    /**
     * The voice connection has been destroyed and untracked, it cannot be reused.
     */
    Destroyed = "destroyed",
    /**
     * The voice connection has either been severed or not established.
     */
    Disconnected = "disconnected",
    /**
     * A voice connection has been established, and is ready to be used.
     */
    Ready = "ready",
    /**
     * Sending a packet to the main Discord gateway to indicate we want to change our voice state.
     */
    Signalling = "signalling"
}
/**
 * The state that a VoiceConnection will be in when it is waiting to receive a VOICE_SERVER_UPDATE and
 * VOICE_STATE_UPDATE packet from Discord, provided by the adapter.
 */
interface VoiceConnectionSignallingState {
    adapter: DiscordGatewayAdapterImplementerMethods;
    status: VoiceConnectionStatus.Signalling;
    subscription?: PlayerSubscription | undefined;
}
/**
 * The reasons a voice connection can be in the disconnected state.
 */
declare enum VoiceConnectionDisconnectReason {
    /**
     * When the WebSocket connection has been closed.
     */
    WebSocketClose = 0,
    /**
     * When the adapter was unable to send a message requested by the VoiceConnection.
     */
    AdapterUnavailable = 1,
    /**
     * When a VOICE_SERVER_UPDATE packet is received with a null endpoint, causing the connection to be severed.
     */
    EndpointRemoved = 2,
    /**
     * When a manual disconnect was requested.
     */
    Manual = 3
}
/**
 * The state that a VoiceConnection will be in when it is not connected to a Discord voice server nor is
 * it attempting to connect. You can manually attempt to reconnect using VoiceConnection#reconnect.
 */
interface VoiceConnectionDisconnectedBaseState {
    adapter: DiscordGatewayAdapterImplementerMethods;
    status: VoiceConnectionStatus.Disconnected;
    subscription?: PlayerSubscription | undefined;
}
/**
 * The state that a VoiceConnection will be in when it is not connected to a Discord voice server nor is
 * it attempting to connect. You can manually attempt to reconnect using VoiceConnection#reconnect.
 */
interface VoiceConnectionDisconnectedOtherState extends VoiceConnectionDisconnectedBaseState {
    reason: Exclude<VoiceConnectionDisconnectReason, VoiceConnectionDisconnectReason.WebSocketClose>;
}
/**
 * The state that a VoiceConnection will be in when its WebSocket connection was closed.
 * You can manually attempt to reconnect using VoiceConnection#reconnect.
 */
interface VoiceConnectionDisconnectedWebSocketState extends VoiceConnectionDisconnectedBaseState {
    /**
     * The close code of the WebSocket connection to the Discord voice server.
     */
    closeCode: number;
    reason: VoiceConnectionDisconnectReason.WebSocketClose;
}
/**
 * The states that a VoiceConnection can be in when it is not connected to a Discord voice server nor is
 * it attempting to connect. You can manually attempt to connect using VoiceConnection#reconnect.
 */
type VoiceConnectionDisconnectedState = VoiceConnectionDisconnectedOtherState | VoiceConnectionDisconnectedWebSocketState;
/**
 * The state that a VoiceConnection will be in when it is establishing a connection to a Discord
 * voice server.
 */
interface VoiceConnectionConnectingState {
    adapter: DiscordGatewayAdapterImplementerMethods;
    networking: Networking;
    status: VoiceConnectionStatus.Connecting;
    subscription?: PlayerSubscription | undefined;
}
/**
 * The state that a VoiceConnection will be in when it has an active connection to a Discord
 * voice server.
 */
interface VoiceConnectionReadyState {
    adapter: DiscordGatewayAdapterImplementerMethods;
    networking: Networking;
    status: VoiceConnectionStatus.Ready;
    subscription?: PlayerSubscription | undefined;
}
/**
 * The state that a VoiceConnection will be in when it has been permanently been destroyed by the
 * user and untracked by the library. It cannot be reconnected, instead, a new VoiceConnection
 * needs to be established.
 */
interface VoiceConnectionDestroyedState {
    status: VoiceConnectionStatus.Destroyed;
}
/**
 * The various states that a voice connection can be in.
 */
type VoiceConnectionState = VoiceConnectionConnectingState | VoiceConnectionDestroyedState | VoiceConnectionDisconnectedState | VoiceConnectionReadyState | VoiceConnectionSignallingState;
interface VoiceConnection extends EventEmitter {
    /**
     * Emitted when there is an error emitted from the voice connection
     *
     * @eventProperty
     */
    on(event: 'error', listener: (error: Error) => void): this;
    /**
     * Emitted debugging information about the voice connection
     *
     * @eventProperty
     */
    on(event: 'debug', listener: (message: string) => void): this;
    /**
     * Emitted when the state of the voice connection changes
     *
     * @eventProperty
     */
    on(event: 'stateChange', listener: (oldState: VoiceConnectionState, newState: VoiceConnectionState) => void): this;
    /**
     * Emitted when the end-to-end encrypted session has transitioned
     *
     * @eventProperty
     */
    on(event: 'transitioned', listener: (transitionId: number) => void): this;
    /**
     * Emitted when the state of the voice connection changes to a specific status
     *
     * @eventProperty
     */
    on<Event extends VoiceConnectionStatus>(event: Event, listener: (oldState: VoiceConnectionState, newState: VoiceConnectionState & {
        status: Event;
    }) => void): this;
}
/**
 * A connection to the voice server of a Guild, can be used to play audio in voice channels.
 */
declare class VoiceConnection extends EventEmitter {
    /**
     * The number of consecutive rejoin attempts. Initially 0, and increments for each rejoin.
     * When a connection is successfully established, it resets to 0.
     */
    rejoinAttempts: number;
    /**
     * The state of the voice connection.
     */
    private _state;
    /**
     * A configuration storing all the data needed to reconnect to a Guild's voice server.
     *
     * @internal
     */
    readonly joinConfig: JoinConfig;
    /**
     * The two packets needed to successfully establish a voice connection. They are received
     * from the main Discord gateway after signalling to change the voice state.
     */
    private readonly packets;
    /**
     * The receiver of this voice connection. You should join the voice channel with `selfDeaf` set
     * to false for this feature to work properly.
     */
    readonly receiver: VoiceReceiver;
    /**
     * The debug logger function, if debugging is enabled.
     */
    private readonly debug;
    /**
     * The options used to create this voice connection.
     */
    private readonly options;
    /**
     * Creates a new voice connection.
     *
     * @param joinConfig - The data required to establish the voice connection
     * @param options - The options used to create this voice connection
     */
    constructor(joinConfig: JoinConfig, options: CreateVoiceConnectionOptions);
    /**
     * The current state of the voice connection.
     *
     * @remarks
     * The setter will perform clean-up operations where necessary.
     */
    get state(): VoiceConnectionState;
    set state(newState: VoiceConnectionState);
    /**
     * Registers a `VOICE_SERVER_UPDATE` packet to the voice connection. This will cause it to reconnect using the
     * new data provided in the packet.
     *
     * @param packet - The received `VOICE_SERVER_UPDATE` packet
     */
    private addServerPacket;
    /**
     * Registers a `VOICE_STATE_UPDATE` packet to the voice connection. Most importantly, it stores the id of the
     * channel that the client is connected to.
     *
     * @param packet - The received `VOICE_STATE_UPDATE` packet
     */
    private addStatePacket;
    /**
     * Called when the networking state changes, and the new ws/udp packet/message handlers need to be rebound
     * to the new instances.
     *
     * @param newState - The new networking state
     * @param oldState - The old networking state, if there is one
     */
    private updateReceiveBindings;
    /**
     * Attempts to configure a networking instance for this voice connection using the received packets.
     * Both packets are required, and any existing networking instance will be destroyed.
     *
     * @remarks
     * This is called when the voice server of the connection changes, e.g. if the bot is moved into a
     * different channel in the same guild but has a different voice server. In this instance, the connection
     * needs to be re-established to the new voice server.
     *
     * The connection will transition to the Connecting state when this is called.
     */
    configureNetworking(): void;
    /**
     * Called when the networking instance for this connection closes. If the close code is 4014 (do not reconnect),
     * the voice connection will transition to the Disconnected state which will store the close code. You can
     * decide whether or not to reconnect when this occurs by listening for the state change and calling reconnect().
     *
     * @remarks
     * If the close code was anything other than 4014, it is likely that the closing was not intended, and so the
     * VoiceConnection will signal to Discord that it would like to rejoin the channel. This automatically attempts
     * to re-establish the connection. This would be seen as a transition from the Ready state to the Signalling state.
     * @param code - The close code
     */
    private onNetworkingClose;
    /**
     * Called when the state of the networking instance changes. This is used to derive the state of the voice connection.
     *
     * @param oldState - The previous state
     * @param newState - The new state
     */
    private onNetworkingStateChange;
    /**
     * Propagates errors from the underlying network instance.
     *
     * @param error - The error to propagate
     */
    private onNetworkingError;
    /**
     * Propagates debug messages from the underlying network instance.
     *
     * @param message - The debug message to propagate
     */
    private onNetworkingDebug;
    /**
     * Propagates transitions from the underlying network instance.
     *
     * @param transitionId - The transition id
     */
    private onNetworkingTransitioned;
    /**
     * Prepares an audio packet for dispatch.
     *
     * @param buffer - The Opus packet to prepare
     */
    prepareAudioPacket(buffer: Buffer): Buffer<ArrayBufferLike> | undefined;
    /**
     * Dispatches the previously prepared audio packet (if any)
     */
    dispatchAudio(): boolean | undefined;
    /**
     * Prepares an audio packet and dispatches it immediately.
     *
     * @param buffer - The Opus packet to play
     */
    playOpusPacket(buffer: Buffer): boolean | undefined;
    /**
     * Destroys the VoiceConnection, preventing it from connecting to voice again.
     * This method should be called when you no longer require the VoiceConnection to
     * prevent memory leaks.
     *
     * @param adapterAvailable - Whether the adapter can be used
     */
    destroy(adapterAvailable?: boolean): void;
    /**
     * Disconnects the VoiceConnection, allowing the possibility of rejoining later on.
     *
     * @returns `true` if the connection was successfully disconnected
     */
    disconnect(): boolean;
    /**
     * Attempts to rejoin (better explanation soon:tm:)
     *
     * @remarks
     * Calling this method successfully will automatically increment the `rejoinAttempts` counter,
     * which you can use to inform whether or not you'd like to keep attempting to reconnect your
     * voice connection.
     *
     * A state transition from Disconnected to Signalling will be observed when this is called.
     */
    rejoin(joinConfig?: Omit<JoinConfig, 'group' | 'guildId'>): boolean;
    /**
     * Updates the speaking status of the voice connection. This is used when audio players are done playing audio,
     * and need to signal that the connection is no longer playing audio.
     *
     * @param enabled - Whether or not to show as speaking
     */
    setSpeaking(enabled: boolean): false | void;
    /**
     * Subscribes to an audio player, allowing the player to play audio on this voice connection.
     *
     * @param player - The audio player to subscribe to
     * @returns The created subscription
     */
    subscribe(player: AudioPlayer): PlayerSubscription | undefined;
    /**
     * The latest ping (in milliseconds) for the WebSocket connection and audio playback for this voice
     * connection, if this data is available.
     *
     * @remarks
     * For this data to be available, the VoiceConnection must be in the Ready state, and its underlying
     * WebSocket connection and UDP socket must have had at least one ping-pong exchange.
     */
    get ping(): {
        ws: number | undefined;
        udp: number | undefined;
    };
    /**
     * The current voice privacy code of the encrypted session.
     *
     * @remarks
     * For this data to be available, the VoiceConnection must be in the Ready state,
     * and the connection would have to be end-to-end encrypted.
     */
    get voicePrivacyCode(): string | undefined;
    /**
     * Gets the verification code for a user in the session.
     *
     * @throws Will throw if end-to-end encryption is not on or if the user id provided is not in the session.
     */
    getVerificationCode(userId: string): Promise<string>;
    /**
     * Called when a subscription of this voice connection to an audio player is removed.
     *
     * @param subscription - The removed subscription
     */
    protected onSubscriptionRemoved(subscription: PlayerSubscription): void;
}

/**
 * The options that can be given when creating a voice connection.
 */
interface CreateVoiceConnectionOptions {
    adapterCreator: DiscordGatewayAdapterCreator;
    /**
     * Whether to use the DAVE protocol for end-to-end encryption. Defaults to true.
     */
    daveEncryption?: boolean | undefined;
    /**
     * If true, debug messages will be enabled for the voice connection and its
     * related components. Defaults to false.
     */
    debug?: boolean | undefined;
    /**
     * The amount of consecutive decryption failures needed to try to
     * re-initialize the end-to-end encrypted session to recover. Defaults to 24.
     */
    decryptionFailureTolerance?: number | undefined;
}
/**
 * The options that can be given when joining a voice channel.
 */
interface JoinVoiceChannelOptions {
    /**
     * The id of the Discord voice channel to join.
     */
    channelId: string;
    /**
     * An optional group identifier for the voice connection.
     */
    group?: string;
    /**
     * The id of the guild that the voice channel belongs to.
     */
    guildId: string;
    /**
     * Whether to join the channel deafened (defaults to true)
     */
    selfDeaf?: boolean;
    /**
     * Whether to join the channel muted (defaults to true)
     */
    selfMute?: boolean;
}
/**
 * Creates a VoiceConnection to a Discord voice channel.
 *
 * @param options - the options for joining the voice channel
 */
declare function joinVoiceChannel(options: CreateVoiceConnectionOptions & JoinVoiceChannelOptions): VoiceConnection;

declare const RTP_OPUS_PAYLOAD_TYPE = 120;

/**
 * Generates a report of the dependencies used by the \@discordjs/voice module.
 * Useful for debugging.
 */
declare function generateDependencyReport(): string;

/**
 * Allows a voice connection a specified amount of time to enter a given state, otherwise rejects with an error.
 *
 * @param target - The voice connection that we want to observe the state change for
 * @param status - The status that the voice connection should be in
 * @param timeoutOrSignal - The maximum time we are allowing for this to occur, or a signal that will abort the operation
 */
declare function entersState(target: VoiceConnection, status: VoiceConnectionStatus, timeoutOrSignal: AbortSignal | number): Promise<VoiceConnection>;
/**
 * Allows an audio player a specified amount of time to enter a given state, otherwise rejects with an error.
 *
 * @param target - The audio player that we want to observe the state change for
 * @param status - The status that the audio player should be in
 * @param timeoutOrSignal - The maximum time we are allowing for this to occur, or a signal that will abort the operation
 */
declare function entersState(target: AudioPlayer, status: AudioPlayerStatus, timeoutOrSignal: AbortSignal | number): Promise<AudioPlayer>;

/**
 * Takes an Opus Head, and verifies whether the associated Opus audio is suitable to play in a Discord voice channel.
 *
 * @param opusHead - The Opus Head to validate
 * @returns `true` if suitable to play in a Discord voice channel, otherwise `false`
 */
declare function validateDiscordOpusHead(opusHead: Buffer): boolean;
/**
 * The resulting information after probing an audio stream
 */
interface ProbeInfo {
    /**
     * The readable audio stream to use. You should use this rather than the input stream, as the probing
     * function can sometimes read the input stream to its end and cause the stream to close.
     */
    stream: Readable;
    /**
     * The recommended stream type for this audio stream.
     */
    type: StreamType;
}
/**
 * Attempt to probe a readable stream to figure out whether it can be demuxed using an Ogg or WebM Opus demuxer.
 *
 * @param stream - The readable stream to probe
 * @param probeSize - The number of bytes to attempt to read before giving up on the probe
 * @param validator - The Opus Head validator function
 * @experimental
 */
declare function demuxProbe(stream: Readable, probeSize?: number, validator?: typeof validateDiscordOpusHead): Promise<ProbeInfo>;

/**
 * The {@link https://github.com/discordjs/discord.js/blob/main/packages/voice#readme | @discordjs/voice} version
 * that you are currently using.
 */
declare const version: string;

export { AudioPlayer, type AudioPlayerBufferingState, AudioPlayerError, type AudioPlayerIdleState, type AudioPlayerPausedState, type AudioPlayerPlayingState, type AudioPlayerState, AudioPlayerStatus, AudioReceiveStream, type AudioReceiveStreamOptions, AudioResource, type ConnectionData, type ConnectionOptions, type CreateAudioPlayerOptions, type CreateAudioResourceOptions, type CreateVoiceConnectionOptions, DAVESession, type DiscordGatewayAdapterCreator, type DiscordGatewayAdapterImplementerMethods, type DiscordGatewayAdapterLibraryMethods, type Edge, type EndBehavior, EndBehaviorType, type JoinConfig, type JoinVoiceChannelOptions, Networking, type NetworkingClosedState, type NetworkingIdentifyingState, type NetworkingOpeningWsState, type NetworkingReadyState, type NetworkingResumingState, type NetworkingSelectingProtocolState, type NetworkingState, NetworkingStatusCode, type NetworkingUdpHandshakingState, NoSubscriberBehavior, Node, PlayerSubscription, type ProbeInfo, RTP_OPUS_PAYLOAD_TYPE, SSRCMap, type SocketConfig, SpeakingMap, StreamType, TransformerType, VoiceConnection, type VoiceConnectionConnectingState, type VoiceConnectionDestroyedState, VoiceConnectionDisconnectReason, type VoiceConnectionDisconnectedBaseState, type VoiceConnectionDisconnectedOtherState, type VoiceConnectionDisconnectedState, type VoiceConnectionDisconnectedWebSocketState, type VoiceConnectionReadyState, type VoiceConnectionSignallingState, type VoiceConnectionState, VoiceConnectionStatus, VoiceReceiver, VoiceUDPSocket, type VoiceUserData, VoiceWebSocket, createAudioPlayer, createAudioResource, createDefaultAudioReceiveStreamOptions, demuxProbe, entersState, generateDependencyReport, getGroups, getVoiceConnection, getVoiceConnections, joinVoiceChannel, validateDiscordOpusHead, version };
