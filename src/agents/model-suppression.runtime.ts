import {
  createShouldSuppressBuiltInModel as createShouldSuppressBuiltInModelImpl,
  shouldSuppressBuiltInModel as shouldSuppressBuiltInModelImpl,
} from "./model-suppression.js";

type ShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").shouldSuppressBuiltInModel;
type CreateShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").createShouldSuppressBuiltInModel;

export function shouldSuppressBuiltInModel(
  ...args: Parameters<ShouldSuppressBuiltInModel>
): ReturnType<ShouldSuppressBuiltInModel> {
  return shouldSuppressBuiltInModelImpl(...args);
}

export function createShouldSuppressBuiltInModel(
  ...args: Parameters<CreateShouldSuppressBuiltInModel>
): ReturnType<CreateShouldSuppressBuiltInModel> {
  return createShouldSuppressBuiltInModelImpl(...args);
}
