export type SlackThreadStatusVisibility = {
  delivery: boolean;
  preview: boolean;
  draftId?: string;
};

/**
 * Slack session status is per thread, while each inbound owns its own dispatch.
 * A successor turn must ignore the predecessor's visible output, then suppress
 * processing again once this turn itself has something on screen.
 */
export function createSlackThreadStatusGate() {
  let baseline: SlackThreadStatusVisibility | undefined;
  let readLive: () => SlackThreadStatusVisibility = () => ({
    delivery: false,
    preview: false,
  });

  const hasVisibleOutput = () => {
    const live = readLive();
    if (!baseline) {
      return live.delivery || live.preview || Boolean(live.draftId);
    }
    if (!baseline.delivery && live.delivery) {
      return true;
    }
    if (!baseline.preview && live.preview) {
      return true;
    }
    return Boolean(live.draftId && live.draftId !== baseline.draftId);
  };

  return {
    hasVisibleOutput,
    bind(read: () => SlackThreadStatusVisibility) {
      readLive = read;
    },
    beginGeneration() {
      const live = readLive();
      baseline = {
        delivery: live.delivery,
        preview: live.preview,
        ...(live.draftId ? { draftId: live.draftId } : {}),
      };
    },
  };
}

export type SlackThreadStatusGate = ReturnType<typeof createSlackThreadStatusGate>;

/**
 * Publishes processing/active for one Slack thread.
 * A stop from an older turn must not leave the successor looking idle.
 */
export function createSlackSessionStatusCycle(params: {
  gate: { hasVisibleOutput: () => boolean; beginGeneration: () => void };
  publish: (status: "processing" | "active", title?: string) => Promise<boolean>;
  onActiveRestoreFailed: () => void;
}) {
  let didSetStatus = false;
  let statusWasSet = false;
  let generation = 0;
  let publishedGeneration = -1;
  let publishChain: Promise<void> = Promise.resolve();

  const enqueuePublish = (status: "processing" | "active", title?: string): Promise<boolean> => {
    const result = publishChain.then(() =>
      title === undefined ? params.publish(status) : params.publish(status, title),
    );
    publishChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    beginGeneration() {
      generation += 1;
      params.gate.beginGeneration();
    },
    async start(title?: string) {
      if (publishedGeneration !== generation) {
        didSetStatus = false;
      }
      if (didSetStatus || params.gate.hasVisibleOutput()) {
        return;
      }
      const target = generation;
      didSetStatus = true;
      publishedGeneration = target;
      const accepted = await enqueuePublish("processing", title);
      if (didSetStatus && publishedGeneration === target) {
        statusWasSet = accepted;
      }
    },
    async stop() {
      if (!didSetStatus) {
        return;
      }
      const stoppingGeneration = generation;
      const reportFailure = statusWasSet;
      didSetStatus = false;
      statusWasSet = false;
      publishedGeneration = -1;
      const restored = await enqueuePublish("active");
      if (generation !== stoppingGeneration) {
        // Active was queued before any successor processing. A live successor
        // publishes processing itself; a finished one must not be restarted.
        return;
      }
      if (reportFailure && !restored) {
        params.onActiveRestoreFailed();
      }
    },
  };
}
