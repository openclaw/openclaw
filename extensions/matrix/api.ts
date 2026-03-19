export * from "./src/setup-core.js";
export * from "./src/setup-surface.js";
export {
  createMatrixThreadBindingManager,
  getMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
} from "./src/matrix/thread-bindings.js";
export { matrixOnboardingAdapter as matrixSetupWizard } from "./src/onboarding.js";
