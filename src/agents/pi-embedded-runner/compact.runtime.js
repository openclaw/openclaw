let compactRuntimePromise = null;
function loadCompactRuntime() {
    compactRuntimePromise ??= import("./compact.js");
    return compactRuntimePromise;
}
export async function compactEmbeddedPiSessionDirect(...args) {
    const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
    return compactEmbeddedPiSessionDirect(...args);
}
