type ShouldSuppressBuiltInModel = typeof import("./model-suppression.js").shouldSuppressBuiltInModel;
type BuildShouldSuppressBuiltInModel = typeof import("./model-suppression.js").buildShouldSuppressBuiltInModel;
export declare function shouldSuppressBuiltInModel(...args: Parameters<ShouldSuppressBuiltInModel>): ReturnType<ShouldSuppressBuiltInModel>;
export declare function buildShouldSuppressBuiltInModel(...args: Parameters<BuildShouldSuppressBuiltInModel>): ReturnType<BuildShouldSuppressBuiltInModel>;
export {};
