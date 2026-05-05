import type {
  PreparedRuntimeProviderHandle,
  PreparedRuntimeModelCatalog,
  PreparedRuntimeChannelOutbound,
  PreparedRuntimeMediaHandle,
  PreparedRuntimeSpeechTts,
} from "./types";

export type ActiveRuntimeMetadata = {
  pluginIds: string[];
  providers: Map<string, PreparedRuntimeProviderHandle>;
  models: Map<string, PreparedRuntimeModelCatalog>;
  channels: Map<string, PreparedRuntimeChannelOutbound>;
  media: Map<string, PreparedRuntimeMediaHandle>;
  speech: Map<string, PreparedRuntimeSpeechTts>;
};

export function createActiveRuntimeRegistry(): ActiveRuntimeMetadata {
  return {
    pluginIds: [],
    providers: new Map(),
    models: new Map(),
    channels: new Map(),
    media: new Map(),
    speech: new Map(),
  };
}

export function registerProvider(
  registry: ActiveRuntimeMetadata,
  id: string,
  provider: PreparedRuntimeProviderHandle,
): void {
  registry.providers.set(id, provider);
}

export function registerModel(
  registry: ActiveRuntimeMetadata,
  id: string,
  model: PreparedRuntimeModelCatalog,
): void {
  registry.models.set(id, model);
}

export function registerChannel(
  registry: ActiveRuntimeMetadata,
  id: string,
  channel: PreparedRuntimeChannelOutbound,
): void {
  registry.channels.set(id, channel);
}

export function registerMedia(
  registry: ActiveRuntimeMetadata,
  id: string,
  media: PreparedRuntimeMediaHandle,
): void {
  registry.media.set(id, media);
}

export function registerSpeech(
  registry: ActiveRuntimeMetadata,
  id: string,
  speech: PreparedRuntimeSpeechTts,
): void {
  registry.speech.set(id, speech);
}

export function addPluginId(registry: ActiveRuntimeMetadata, pluginId: string): void {
  if (!registry.pluginIds.includes(pluginId)) {
    registry.pluginIds.push(pluginId);
  }
}

export function lookupProvider(
  registry: ActiveRuntimeMetadata,
  id: string,
): PreparedRuntimeProviderHandle | undefined {
  return registry.providers.get(id);
}

export function lookupModel(
  registry: ActiveRuntimeMetadata,
  id: string,
): PreparedRuntimeModelCatalog | undefined {
  return registry.models.get(id);
}

export function lookupChannel(
  registry: ActiveRuntimeMetadata,
  id: string,
): PreparedRuntimeChannelOutbound | undefined {
  return registry.channels.get(id);
}

export function lookupMedia(
  registry: ActiveRuntimeMetadata,
  id: string,
): PreparedRuntimeMediaHandle | undefined {
  return registry.media.get(id);
}

export function lookupSpeech(
  registry: ActiveRuntimeMetadata,
  id: string,
): PreparedRuntimeSpeechTts | undefined {
  return registry.speech.get(id);
}

export function getLoadedMetadata(registry: ActiveRuntimeMetadata): {
  pluginIds: string[];
  providerCount: number;
  modelCount: number;
  channelCount: number;
  mediaCount: number;
  speechCount: number;
} {
  return {
    pluginIds: [...registry.pluginIds],
    providerCount: registry.providers.size,
    modelCount: registry.models.size,
    channelCount: registry.channels.size,
    mediaCount: registry.media.size,
    speechCount: registry.speech.size,
  };
}
