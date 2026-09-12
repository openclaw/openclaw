import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  buildRealtimeVoiceAgentControlSpeechMessage,
  canonicalizeBase64,
  extractErrorCode,
  readErrorName,
  rawDataToString,
  toErrorObject,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import type { RawData } from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { OpenAILiveDelegationQueue } from "./realtime-live-delegation-queue.js";
import {
  buildOpenAIQuicksilverDelegationPrompt,
  type OpenAIQuicksilverTranscriptEntry,
} from "./realtime-quicksilver-instructions.js";
import { buildOpenAIQuicksilverContextAppend } from "./realtime-quicksilver-protocol.js";
import { projectOpenAIQuicksilverErrorMessage } from "./realtime-quicksilver-redaction.js";
import type { OpenAIQuicksilverSocket } from "./realtime-quicksilver-sideband.js";
import { OpenAIQuicksilverTranscript } from "./realtime-quicksilver-transcript.js";
import {
  boundOpenAIQuicksilverDelegationResult,
  chunkOpenAIQuicksilverAppendText,
  parseOpenAIQuicksilverEvent,
  type OpenAIQuicksilverInboundEvent,
} from "./realtime-quicksilver-wire.js";
import { isOpenAIGptLiveApiModel } from "./realtime-quicksilver.js";

const WEBSOCKET_OPEN = 1;
const CONSULT_FAILURE_TEXT =
  "The agent task failed. Tell the user it did not complete and offer to try again.";

type PendingDelegation = {
  id: string;
  prompt: string;
};

type InternalAgentConsultRequest = Parameters<RealtimeVoiceAgentConsultRunner>[0] & {
  requesterFinal?: {
    append: (text: string) => boolean;
  };
};

interface LifecycleBoundAgentConsultRunner {
  (request: InternalAgentConsultRequest): Promise<{ text: string; yielded?: true }>;
  adoptCompletionClaims?: () => void;
  claimAppend?: () => boolean;
  claimFailureAppend?: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: RealtimeVoiceAgentConsultRunner;
}

type OpenAIQuicksilverDelegationControllerOptions = {
  getSocket: () => OpenAIQuicksilverSocket | undefined;
  logger: Pick<PluginLogger, "debug" | "warn">;
  model: string;
  onError?: (error: Error) => void;
  onFatalError: (error: Error) => void;
  onAudio?: (audio: Buffer) => void;
  onSessionStarted?: (expiresAt: number | undefined) => void;
  onSessionClosed?: (
    reason: Extract<OpenAIQuicksilverInboundEvent, { kind: "session-closed" }>["reason"],
  ) => void;
  onTranscript?: (role: "user" | "assistant", text: string, done: boolean) => void;
  handleDelegationInput?: RealtimeVoiceGatewayControl["handleDelegationInput"];
  onWireEventType?: (eventType: string) => void;
  runAgentConsult: LifecycleBoundAgentConsultRunner;
  signal: AbortSignal;
};

function projectWireEventType(
  event: OpenAIQuicksilverInboundEvent,
  model: string,
): string | undefined {
  const live = isOpenAIGptLiveApiModel(model);
  switch (event.kind) {
    case "session-started":
      return "session.started";
    case "session-closed":
      return "session.closed";
    case "audio-cleared":
      return "output_audio_buffer.cleared";
    case "audio":
      return live ? "session.output_audio.delta" : "output_audio.delta";
    case "transcript-delta":
      return live
        ? `session.${event.role === "user" ? "input" : "output"}_transcript.delta`
        : event.role === "user"
          ? "input_transcript.added"
          : "output_transcript.added";
    case "transcript-done":
      return "turn.done";
    case "delegation":
      return live ? "session.delegation.created" : "delegation.created";
    case "error":
      return "error";
    case "ignored":
      return event.eventType === "session.updated" ? "session.updated" : undefined;
    case "unknown":
      return undefined;
  }
  return undefined;
}

/** Owns the provider's single active delegation and its once-consumed transcript context. */
export class OpenAIQuicksilverDelegationController {
  private activeDelegationId: string | undefined;
  private readonly completionClaimsAdopted: boolean;
  private consultController: AbortController | undefined;
  private delegationGeneration = 0;
  private readonly onSessionAbort = () => {
    const reason = this.options.signal.reason;
    this.stop(reason instanceof Error ? reason : new Error("GPT-Live session stopped"));
  };
  private pendingDelegation: PendingDelegation | undefined;
  private requesterFinalOwner: { delegationId: string; generation: number } | undefined;
  private steeringPromise: Promise<void> | undefined;
  private stopped = false;
  private drainDisposition: "abort" | "detach" | undefined;
  private readonly transcript = new OpenAIQuicksilverTranscript();
  private readonly publicDelegations: OpenAILiveDelegationQueue | undefined;

  constructor(
    private readonly options: OpenAIQuicksilverDelegationControllerOptions,
    private readonly formatErrorMessage: OpenAIRealtimeHost["formatErrorMessage"],
  ) {
    if (isOpenAIGptLiveApiModel(options.model)) {
      this.publicDelegations = new OpenAILiveDelegationQueue({
        isActive: () => !this.stopped && !this.drainDisposition && !options.signal.aborted,
        readInput: () => this.transcript.latestUserInput(),
        dispatch: (id, input) => this.startDelegation(id, input),
        onExpired: (id) => {
          this.sendAppend(
            "Ask the user to repeat their request; no user transcript was received.",
            "speakable",
            id,
          );
        },
        onError: (error) => this.fail(error),
      });
    }
    this.completionClaimsAdopted = options.runAgentConsult.adoptCompletionClaims !== undefined;
    options.runAgentConsult.adoptCompletionClaims?.();
    if (options.signal.aborted) {
      this.onSessionAbort();
    } else {
      options.signal.addEventListener("abort", this.onSessionAbort, { once: true });
    }
  }

  handleFrame(data: RawData, isBinary: boolean): void {
    if (this.stopped) {
      return;
    }
    if (isBinary) {
      this.fail(new Error("OpenAI GPT-Live sideband returned an unexpected binary frame"));
      return;
    }
    const payload = rawDataToString(data);
    const event = parseOpenAIQuicksilverEvent(payload, this.options.model);
    if (event) {
      if (event.kind === "session-closed") {
        this.handleEvent(event);
        return;
      }
      const eventType = this.drainDisposition
        ? undefined
        : projectWireEventType(event, this.options.model);
      if (eventType) {
        this.options.onWireEventType?.(eventType);
      }
      this.handleEvent(event);
    }
  }

  handleEvent(event: OpenAIQuicksilverInboundEvent): void {
    if (this.stopped || event.kind === "ignored" || event.kind === "audio-cleared") {
      return;
    }
    if (
      this.drainDisposition &&
      event.kind !== "transcript-delta" &&
      event.kind !== "transcript-done" &&
      event.kind !== "session-closed"
    ) {
      return;
    }
    if (event.kind === "unknown") {
      this.options.logger.debug?.("OpenAI GPT-Live ignored an unsupported sideband event");
      return;
    }
    if (event.kind === "session-started") {
      this.options.onSessionStarted?.(event.expiresAt);
      return;
    }
    if (event.kind === "session-closed") {
      try {
        this.options.onSessionClosed?.(event.reason);
      } finally {
        if (this.drainDisposition === "detach") {
          this.detach();
        } else {
          this.stop(new Error("GPT-Live session closed"));
        }
      }
      return;
    }
    if (event.kind === "transcript-delta" || event.kind === "transcript-done") {
      if (isOpenAIGptLiveApiModel(this.options.model)) {
        this.transcript.appendPublic(event, {
          onTranscript: this.options.onTranscript,
          canAppend: () => !this.stopped,
        });
        this.publicDelegations?.resume();
      } else {
        this.transcript.append(event);
        this.options.onTranscript?.(event.role, event.text, event.kind === "transcript-done");
      }
      return;
    }
    if (event.kind === "error") {
      const error = new Error(projectOpenAIQuicksilverErrorMessage("provider"));
      this.options.logger.warn(error.message);
      if (event.fatalAuth) {
        this.options.onFatalError(error);
      } else {
        this.options.onError?.(error);
      }
      return;
    }
    if (event.kind === "audio") {
      if (!this.options.onAudio) {
        // Browser and OAuth Gateway sessions negotiate audio over WebRTC.
        return;
      }
      const audio = canonicalizeBase64(event.data);
      if (!audio) {
        this.fail(new Error("OpenAI GPT-Live returned malformed base64 audio"));
        return;
      }
      this.options.onAudio(Buffer.from(audio, "base64"));
      return;
    }
    if (this.publicDelegations) {
      this.publicDelegations.enqueue(event.id);
    } else {
      const input = event.prompt ?? this.transcript.latestUserInput();
      if (event.prompt === undefined && !input.trim()) {
        this.sendAppend(
          "Ask the user to repeat their request; no user transcript was received.",
          "speakable",
          event.id,
        );
        return;
      }
      this.startDelegation(event.id, input);
    }
  }

  sendSessionContext(text: string, channel: "speakable" | "commentary"): void {
    const content = text.trim();
    if (content) {
      // Standalone speech must not become the result of whichever delegation is active.
      this.sendAppend(content, channel);
    }
  }

  beginTranscriptDrain(disposition: "abort" | "detach"): void {
    if (this.stopped || this.drainDisposition) {
      return;
    }
    this.drainDisposition = disposition;
    this.publicDelegations?.stop();
    this.revokeRequesterFinal();
    this.pendingDelegation = undefined;
    if (disposition === "abort") {
      this.consultController?.abort(new Error("GPT-Live session closing"));
    }
  }

  stop(reason: Error): void {
    if (this.stopped) {
      return;
    }
    this.publicDelegations?.stop();
    this.flushTranscript();
    this.markStopped();
    this.consultController?.abort(reason);
    this.consultController = undefined;
  }

  /** Releases sideband ownership without canceling work already accepted by the host. */
  detach(): void {
    if (this.stopped) {
      return;
    }
    this.publicDelegations?.stop();
    this.flushTranscript();
    this.markStopped();
  }

  flushTranscript(): void {
    if (isOpenAIGptLiveApiModel(this.options.model)) {
      this.consumeTranscript();
    }
  }

  private consumeTranscript(): OpenAIQuicksilverTranscriptEntry[] {
    const snapshot = this.transcript.consume();
    this.transcript.publish(snapshot.publication, { onTranscript: this.options.onTranscript });
    return snapshot.context;
  }

  private startDelegation(id: string, input: string): void {
    if (this.stopped || this.drainDisposition || this.options.signal.aborted || !input.trim()) {
      return;
    }
    const handleInput = this.options.handleDelegationInput;
    if (handleInput) {
      const socket = this.options.getSocket();
      let responded = false;
      const respond = (message: string) => {
        if (responded) {
          return;
        }
        // Consume before sending: partial chunk delivery or a throwing socket cannot retry an action.
        responded = true;
        if (!socket || socket !== this.options.getSocket()) {
          return;
        }
        try {
          this.sendAppend(message, "speakable", id, socket);
        } catch (error) {
          this.fail(toErrorObject(error, "OpenAI GPT-Live control response failed"));
        }
      };
      try {
        if (handleInput(input, respond) === "control") {
          this.transcript.clearPendingUserInput();
          return;
        }
      } catch (error) {
        this.fail(toErrorObject(error, "OpenAI GPT-Live control admission failed"));
        return;
      }
    }
    // Transcript is a once-delivered delta. Empty delegations must not consume it.
    if (this.stopped || this.drainDisposition || this.options.signal.aborted) {
      return;
    }
    const transcript = this.consumeTranscript();
    if (this.stopped || this.drainDisposition || this.options.signal.aborted) {
      return;
    }
    const delegation = {
      id,
      prompt: buildOpenAIQuicksilverDelegationPrompt({ input, transcript }),
    };
    if (this.consultController) {
      this.pendingDelegation = delegation;
      const runner = this.options.runAgentConsult;
      if (runner.steer) {
        this.schedulePendingSteering(this.consultController, runner.steer);
      } else {
        // Generic runners retain replacement fallback; Gateway runners steer in place.
        this.revokeRequesterFinal();
        this.consultController.abort(new Error("Realtime delegation superseded"));
      }
      return;
    }
    this.launchDelegation(delegation);
  }

  private launchDelegation(delegation: PendingDelegation): void {
    if (this.stopped || this.options.signal.aborted) {
      return;
    }
    const controller = new AbortController();
    const generation = ++this.delegationGeneration;
    this.consultController = controller;
    this.activeDelegationId = delegation.id;
    this.requesterFinalOwner = { delegationId: delegation.id, generation };
    void this.runDelegation(delegation, generation, controller.signal)
      .catch((error: unknown) =>
        this.fail(toErrorObject(error, "OpenAI GPT-Live delegation failed")),
      )
      .finally(() => {
        if (this.consultController !== controller) {
          return;
        }
        this.consultController = undefined;
        this.activeDelegationId = undefined;
        const pending = this.pendingDelegation;
        this.pendingDelegation = undefined;
        if (pending) {
          this.launchDelegation(pending);
        }
      });
  }

  private schedulePendingSteering(
    controller: AbortController,
    steer: RealtimeVoiceAgentConsultRunner,
  ): void {
    if (this.steeringPromise) {
      return;
    }
    const steering = (async () => {
      await Promise.resolve();
      while (!this.stopped && !controller.signal.aborted && this.consultController === controller) {
        const delegation = this.pendingDelegation;
        this.pendingDelegation = undefined;
        if (!delegation) {
          return;
        }
        try {
          await steer({ prompt: delegation.prompt, signal: controller.signal });
        } catch (error) {
          this.revokeRequesterFinal();
          if (
            this.stopped ||
            controller.signal.aborted ||
            readErrorName(error) === "AbortError" ||
            extractErrorCode(error) === "ABORT_ERR"
          ) {
            return;
          }
          const fatal = toErrorObject(error, "Realtime delegation steering failed");
          // The queued delegation belongs to this steering attempt. Do not let the
          // active-run finalizer relaunch it after its owner has failed.
          this.pendingDelegation = undefined;
          controller.abort(fatal);
          this.fail(fatal);
          return;
        }
        if (this.stopped || controller.signal.aborted || this.consultController !== controller) {
          return;
        }
        this.activeDelegationId = delegation.id;
        // Steering preserves the active host run; only its provider presentation target moves.
        const requesterFinalOwner = this.requesterFinalOwner;
        if (requesterFinalOwner) {
          this.requesterFinalOwner = {
            delegationId: delegation.id,
            generation: requesterFinalOwner.generation,
          };
        }
      }
    })();
    const completion = steering.finally(() => {
      if (this.steeringPromise === completion) {
        this.steeringPromise = undefined;
      }
      if (this.pendingDelegation && !this.stopped) {
        this.schedulePendingSteering(controller, steer);
      }
    });
    this.steeringPromise = completion;
  }

  private markStopped(): void {
    this.stopped = true;
    this.revokeRequesterFinal();
    this.options.signal.removeEventListener("abort", this.onSessionAbort);
    this.pendingDelegation = undefined;
    this.transcript.clear();
  }

  private async runDelegation(
    delegation: PendingDelegation,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    let text: string;
    let failed = false;
    const runner = this.options.runAgentConsult;
    try {
      // Host-classified sessions disable vendor filler. Receipt is launch-only, not run admission.
      if (this.options.handleDelegationInput) {
        this.sendSessionContext(
          buildRealtimeVoiceAgentControlSpeechMessage("I’ll check that request."),
          "speakable",
        );
      }
      const result = await runner({
        prompt: delegation.prompt,
        signal,
        requesterFinal: {
          append: (finalText) => this.appendRequesterFinal(generation, finalText),
        },
      });
      if (signal.aborted) {
        runner.claimAppend?.();
        this.revokeRequesterFinal();
        return;
      }
      text = boundOpenAIQuicksilverDelegationResult(result.text);
    } catch (error) {
      // Browser and relay host cancellation may belong to a different signal.
      // Both consumers must preserve the host's abort outcome, not offer a retry.
      if (
        signal.aborted ||
        readErrorName(error) === "AbortError" ||
        extractErrorCode(error) === "ABORT_ERR"
      ) {
        runner.claimAppend?.();
        this.revokeRequesterFinal();
        return;
      }
      const reason = this.formatErrorMessage(error).replaceAll(/\s+/g, " ").trim();
      this.options.logger.warn(
        `OpenAI GPT-Live delegation consult failed: ${truncateUtf16Safe(reason, 180) || "unknown error"}`,
      );
      failed = true;
      text = CONSULT_FAILURE_TEXT;
    }
    while (this.steeringPromise) {
      await this.steeringPromise;
    }
    if (signal.aborted || this.stopped) {
      runner.claimAppend?.();
      this.revokeRequesterFinal();
      return;
    }
    const claim = failed ? runner.claimFailureAppend : runner.claimAppend;
    if (claim) {
      if (!claim()) {
        this.revokeRequesterFinal();
        return;
      }
    } else if (this.completionClaimsAdopted) {
      this.revokeRequesterFinal();
      this.fail(
        new Error(
          failed
            ? "Realtime delegation failure ownership is unavailable"
            : "Realtime delegation completion ownership is unavailable",
        ),
      );
      return;
    }
    const delegationId = this.activeDelegationId;
    if (!delegationId) {
      this.revokeRequesterFinal();
      return;
    }
    if (!this.sendAppend(text, "speakable", delegationId)) {
      this.revokeRequesterFinal();
    }
  }

  private appendRequesterFinal(generation: number, text: string): boolean {
    const owner = this.requesterFinalOwner;
    if (this.stopped || !owner || owner.generation !== generation) {
      return false;
    }
    this.requesterFinalOwner = undefined;
    return this.sendAppend(
      boundOpenAIQuicksilverDelegationResult(text),
      "speakable",
      owner.delegationId,
    );
  }

  private revokeRequesterFinal(): void {
    this.requesterFinalOwner = undefined;
    this.options.runAgentConsult.revokeRequesterFinal?.();
  }

  private sendAppend(
    text: string,
    channel: "speakable" | "commentary",
    delegationId?: string,
    socket = this.options.getSocket(),
  ): boolean {
    for (const chunk of chunkOpenAIQuicksilverAppendText(text)) {
      // A control reply belongs to this call/socket, not the task it may have cancelled.
      if (
        this.stopped ||
        this.drainDisposition ||
        this.options.signal.aborted ||
        !socket ||
        socket !== this.options.getSocket() ||
        socket.readyState !== WEBSOCKET_OPEN
      ) {
        return false;
      }
      socket.send(
        JSON.stringify(
          buildOpenAIQuicksilverContextAppend({
            model: this.options.model,
            text: chunk,
            channel,
            delegationId,
          }),
        ),
      );
    }
    return true;
  }

  private fail(error: Error): void {
    if (this.stopped) {
      return;
    }
    this.options.logger.warn(error.message);
    this.options.onFatalError(error);
  }
}
