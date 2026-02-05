// Hooks barrel export

// Query hooks
export * from "./queries";

// Mutation hooks
export * from "./mutations";

// Utility hooks
export { useDebounce, useDebouncedCallback } from "./useDebounce";
export {
  useMediaQuery,
  useIsMobile,
  useIsTablet,
  useIsDesktop,
  useIsLargeDesktop,
  usePrefersDarkMode,
  usePrefersReducedMotion,
  usePrefersContrast,
} from "./useMediaQuery";
export { useAutoScroll } from "./use-auto-scroll";
export { useKeyboardShortcuts, type KeyboardShortcut } from "./useKeyboardShortcuts";
export {
  useGatewayConnection,
  useGatewayUrl,
  type UseGatewayConnectionOptions,
  type UseGatewayConnectionResult,
} from "./useGatewayConnection";
export {
  useGatewayStreamHandler,
  type UseGatewayStreamHandlerOptions,
} from "./useGatewayStreamHandler";
export {
  useFieldValidation,
  useMultiFieldValidation,
  createFieldValidator,
  type FieldValidationResult,
  type UseFieldValidationOptions,
} from "./useFieldValidation";
export {
  useOnboardingCheck,
  markOnboardingComplete,
  resetOnboardingStatus,
  ONBOARDING_COMPLETE_KEY,
  ONBOARDING_COMPLETED_AT_KEY,
  type UseOnboardingCheckResult,
} from "./useOnboardingCheck";
export {
  useConnectionManager,
  type ConnectionStatus,
  type ConnectionStatusMap,
  type OAuthConnectOptions,
} from "./useConnectionManager";
