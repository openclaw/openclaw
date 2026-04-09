import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

export function getMinimaxProviderHttpMocks() {
  return getProviderHttpMocks();
}

export function installMinimaxProviderHttpMockCleanup(): void {
  installProviderHttpMockCleanup();
}

export function loadMinimaxMusicGenerationProviderModule() {
  return import("./music-generation-provider.js");
}

export function loadMinimaxVideoGenerationProviderModule() {
  return import("./video-generation-provider.js");
}
