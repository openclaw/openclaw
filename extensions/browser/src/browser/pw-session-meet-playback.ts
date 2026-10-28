import type { BrowserContext, Page } from "playwright-core";

type PlaybackSource = { node: AudioNode; output: number };
type PlaybackObserver = {
  early: boolean;
  sources(): PlaybackSource[];
  has(node: AudioNode, output: number): boolean;
};

/**
 * Meet renders remote audio through an AudioWorklet without media elements.
 * Observe its destination connections before Meet initializes the graph; this
 * script neither collects audio nor changes routing until meeting capture starts.
 * Playwright serializes the function, so it must stay self-contained.
 */
function observeMeetPlayback(): void {
  const scope: Window & { __openclawMeetPlayback?: PlaybackObserver } = window;
  if (location.hostname !== "meet.google.com" || scope["__openclawMeetPlayback"]) {
    return;
  }
  const sourceTypes: {
    MediaStreamAudioSourceNode: typeof MediaStreamAudioSourceNode;
    MediaStreamTrackAudioSourceNode?: typeof MediaStreamAudioSourceNode;
  } = globalThis;
  const connect: AudioNode["connect"] = Reflect.get(AudioNode.prototype, "connect");
  const disconnect: AudioNode["disconnect"] = Reflect.get(AudioNode.prototype, "disconnect");
  const outputs = new Map<AudioNode, Set<number>>();
  const inputContexts = new WeakSet<BaseAudioContext>();
  const endedObservers = new WeakSet<AudioNode>();
  let error: string | undefined;
  const prune = () => {
    for (const node of outputs.keys()) {
      if (node.context.state === "closed") {
        outputs.delete(node);
      }
    }
  };
  const methods = {
    connect(this: AudioNode, ...args: [AudioNode | AudioParam, number?, number?]) {
      const result = Reflect.apply(connect, this, args);
      if (
        this instanceof MediaStreamAudioSourceNode ||
        (sourceTypes.MediaStreamTrackAudioSourceNode &&
          this instanceof sourceTypes.MediaStreamTrackAudioSourceNode) ||
        this instanceof MediaElementAudioSourceNode
      ) {
        // A context containing input or DOM media is not isolated remote playback.
        // Revoke it even if a microphone source connects after capture starts.
        inputContexts.add(this.context);
      }
      if (args[0] === this.context.destination) {
        prune();
        if (this instanceof AudioScheduledSourceNode && !endedObservers.has(this)) {
          endedObservers.add(this);
          this.addEventListener("ended", () => outputs.delete(this), { once: true });
        }
        if (!outputs.has(this) && outputs.size >= 64) {
          error = "Playback source limit exceeded.";
        } else {
          const indexes = outputs.get(this) ?? new Set<number>();
          indexes.add(args[1] ?? 0);
          outputs.set(this, indexes);
        }
      }
      return result;
    },
    disconnect(this: AudioNode, ...args: [(AudioNode | AudioParam | number)?, number?, number?]) {
      const result = Reflect.apply(disconnect, this, args);
      const indexes = outputs.get(this);
      if (!indexes) {
        return result;
      }
      const [destination, output] = args;
      if (args.length === 0) {
        outputs.delete(this);
      } else if (typeof destination === "number") {
        indexes.delete(destination);
      } else if (destination === this.context.destination) {
        if (args.length === 1) {
          outputs.delete(this);
        } else {
          indexes.delete(output ?? 0);
        }
      }
      if (indexes.size === 0) {
        outputs.delete(this);
      }
      return result;
    },
  };
  scope["__openclawMeetPlayback"] = {
    early: document.readyState === "loading",
    sources() {
      prune();
      if (error) {
        throw new Error(error);
      }
      return [...outputs].flatMap(([node, indexes]) =>
        inputContexts.has(node.context) ? [] : [...indexes].map((output) => ({ node, output })),
      );
    },
    has(node, output) {
      return (
        !error &&
        node.context.state !== "closed" &&
        !inputContexts.has(node.context) &&
        outputs.get(node)?.has(output) === true
      );
    },
  };
  Object.assign(AudioNode.prototype, methods);
}

const observers = new WeakMap<BrowserContext, Promise<void>>();

export async function prepareMeetPlaybackObservation(page: Page): Promise<void> {
  if (new URL(page.url()).hostname !== "meet.google.com") {
    return;
  }
  const context = page.context();
  let ready = observers.get(context);
  if (!ready) {
    ready = context
      .addInitScript(observeMeetPlayback)
      .then(() => {})
      .catch((error: unknown) => {
        observers.delete(context);
        throw error;
      });
    observers.set(context, ready);
  }
  // Existing documents cannot be retroactively observed. Meet's join script
  // reloads a pre-join page once, never a call already in progress.
  await ready;
}
