import type { TSchema } from "typebox";
export { createUnionActionGate, listTokenSourcedAccounts, } from "../channels/plugins/actions/shared.js";
export { resolveReactionMessageId } from "../channels/plugins/actions/reaction-message-id.js";
export { createActionGate, imageResultFromFile, jsonResult, parseAvailableTags, readNumberParam, readReactionParams, readStringArrayParam, readStringOrNumberParam, readStringParam, ToolAuthorizationError, } from "../agents/tools/common.js";
export type { ActionGate } from "../agents/tools/common.js";
export { withNormalizedTimestamp } from "../agents/date-time.js";
export { assertMediaNotDataUrl } from "../agents/sandbox-paths.js";
export { resolvePollMaxSelections } from "../polls.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";
/**
 * @deprecated Use semantic `presentation` capabilities instead of exposing
 * provider-native button schemas through the shared message tool.
 */
export declare function createMessageToolButtonsSchema(): TSchema;
/**
 * @deprecated Use semantic `presentation` capabilities instead of exposing
 * provider-native card schemas through the shared message tool.
 */
export declare function createMessageToolCardSchema(): TSchema;
