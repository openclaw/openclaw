const MODELS_JSON_STATE_KEY = Symbol.for("openclaw.modelsJsonState");
export const MODELS_JSON_STATE = (() => {
    const globalState = globalThis;
    if (!globalState[MODELS_JSON_STATE_KEY]) {
        globalState[MODELS_JSON_STATE_KEY] = {
            writeLocks: new Map(),
            readyCache: new Map(),
        };
    }
    return globalState[MODELS_JSON_STATE_KEY];
})();
export function resetModelsJsonReadyCacheForTest() {
    MODELS_JSON_STATE.writeLocks.clear();
    MODELS_JSON_STATE.readyCache.clear();
}
