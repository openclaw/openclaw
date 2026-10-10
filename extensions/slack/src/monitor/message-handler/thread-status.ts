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
  let lastTitle: string | undefined;

  const publishProcessing = async (title?: string) => {
    didSetStatus = true;
    publishedGeneration = generation;
    statusWasSet = await params.publish("processing", title);
  };

  return {
    beginGeneration() {
      generation += 1;
      params.gate.beginGeneration();
    },
    async start(title?: string) {
      lastTitle = title;
      if (publishedGeneration !== generation) {
        didSetStatus = false;
      }
      if (didSetStatus || params.gate.hasVisibleOutput()) {
        return;
      }
      await publishProcessing(title);
    },
    async stop() {
      if (!didSetStatus) {
        return;
      }
      const stoppingGeneration = generation;
      didSetStatus = false;
      const reportFailure = statusWasSet;
      statusWasSet = false;
      publishedGeneration = -1;
      const restored = await params.publish("active");
      if (generation !== stoppingGeneration) {
        // The successor may already have published processing while this stop
        // was in flight. Only repair the indicator when it has not.
        if (publishedGeneration !== generation && !params.gate.hasVisibleOutput()) {
          await publishProcessing(lastTitle);
        }
        return;
      }
      if (reportFailure && !restored) {
        params.onActiveRestoreFailed();
      }
    },
  };
}
