//#region extensions/ollama/src/defaults.ts
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_DOCKER_HOST_BASE_URL = "http://host.docker.internal:11434";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";
const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128e3;
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
const OLLAMA_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const OLLAMA_DEFAULT_MODEL = "gemma4";
//#endregion
export { OLLAMA_DEFAULT_MAX_TOKENS as a, OLLAMA_DEFAULT_COST as i, OLLAMA_DEFAULT_BASE_URL as n, OLLAMA_DEFAULT_MODEL as o, OLLAMA_DEFAULT_CONTEXT_WINDOW as r, OLLAMA_DOCKER_HOST_BASE_URL as s, OLLAMA_CLOUD_BASE_URL as t };
