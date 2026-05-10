export {
  homeAssistantConfigSchema,
  parseHomeAssistantConfig,
  type HomeAssistantConfig,
  type HomeAssistantConfigParseIssue,
  type HomeAssistantConfigParseResult,
} from "./config-schema.js";
export {
  DEFAULT_HOME_ASSISTANT_URL,
  DEFAULT_TOKEN_REF,
  DEFAULT_DENY_SERVICE_LIST,
} from "./config-defaults.js";
export {
  HomeAssistantStateStore,
  type EntityState,
  type StateChangedEvent,
  type StateDiff,
  type StateDiffListener,
  type ListenerErrorListener,
  type StateStoreOptions,
  type Unsubscribe,
} from "./state-store.js";
export {
  HomeAssistantClient,
  type ConnectionState,
  type HomeAssistantClientOptions,
  type LogEntry,
  type LogLevel,
  type Logger,
  type StateChangeListener,
  type WebSocketLike,
  type WebSocketLikeFactory,
} from "./ws-client.js";
export {
  checkServiceCall,
  isEntityAllowed,
  isServiceAllowed,
  type ServiceCheckResult,
  type ServiceDeniedReason,
} from "./allowlist.js";
export {
  HA_SERVICE_CALL_METHOD,
  HA_STATE_EVENT,
  HA_SUBSCRIBE_METHOD,
  attachHomeAssistantBridge,
  type AttachBridgeArgs,
  type BridgeBroadcastFn,
  type BridgeGatewayApi,
  type BridgeGatewayHandler,
  type BridgeGatewayHandlerArgs,
  type BridgeHandle,
  type BridgeLogger,
  type ServiceCallClient,
} from "./gateway-bridge.js";
export { registerHomeAssistantPlugin } from "./register.runtime.js";
