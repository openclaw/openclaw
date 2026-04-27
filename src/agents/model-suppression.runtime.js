import { shouldSuppressBuiltInModel as shouldSuppressBuiltInModelImpl } from "./model-suppression.js";
export function shouldSuppressBuiltInModel(...args) {
    return shouldSuppressBuiltInModelImpl(...args);
}
