import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

const preparedMetadata = createPluginMetadataSnapshotFixture();

export function prepareAuthFixture(params: Parameters<typeof prepareAgentRuntimeAuth>[0]) {
  return prepareAgentRuntimeAuth({ metadataSnapshot: preparedMetadata, ...params });
}

export function prepareAgentRuntimeAuthPlan(params: Parameters<typeof prepareAgentRuntimeAuth>[0]) {
  return prepareAuthFixture(params).plan;
}
