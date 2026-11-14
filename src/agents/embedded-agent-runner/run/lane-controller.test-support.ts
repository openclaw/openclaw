import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneParams = RunEmbeddedAgentParams & { sessionFile: string };

export function createLaneControllerFixture(
  initialParams: LaneParams,
  options: {
    globalLane: string;
    lifecycleGeneration?: string;
    initialQueuedLifecycleGeneration?: string;
    onSessionWriterClaimed?: (entry: InternalSessionEntry) => void;
    configureRuntime?: boolean;
  },
) {
  let params = initialParams;
  let generation = options.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  if (options.configureRuntime !== false) {
    setRuntimeConfigSnapshot(params.config ?? {});
  }
  const controller = createEmbeddedRunLaneController({
    getParams: () => params,
    getLifecycleGeneration: () => generation,
    globalLane: options.globalLane,
    initialQueuedLifecycleGeneration: options.initialQueuedLifecycleGeneration ?? generation,
    setParams: (next) => {
      params = next;
    },
    setLifecycleGeneration: (next) => {
      generation = next;
    },
    onSessionWriterClaimed: options.onSessionWriterClaimed,
  });
  return {
    controller,
    params: initialParams,
    getParams: () => params,
    getLifecycleGeneration: () => generation,
  };
}
