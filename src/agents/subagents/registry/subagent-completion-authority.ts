import { isDeepStrictEqual } from "node:util";
import { isGatewayOperatorAccessUnavailable } from "../../../gateway/operator-access-errors.js";
import { runOutsideOperatorToolGatewayAuthority } from "../../../gateway/operator-tool-gateway-authority.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withoutGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import type { SubagentCompletionCustody } from "./subagent-registry-memory.types.js";

type CompletionAuthority = SubagentCompletionCustody["authority"];

/** Lost custody must not borrow the current caller's profile, runtime or permissions. */
export function runWithCompletionBaseline<T>(run: () => T): T {
  const scope = getPluginRuntimeGatewayRequestScope();
  return withoutGatewayToolCallerIdentity(() =>
    runOutsideOperatorToolGatewayAuthority(() =>
      withPluginRuntimeGatewayRequestScope(
        {
          ...scope,
          client: createSyntheticPluginRuntimeClient({
            operatorRoleActor: { kind: "system" },
            scopes: ["operator.write"],
          }),
          hasCurrentClientAuthority: undefined,
          isWebchatConnect: scope?.isWebchatConnect ?? (() => false),
        },
        run,
      ),
    ),
  );
}

export function runWithLiveCompletionAuthority<T>(
  source: CompletionAuthority | undefined,
  run: () => T,
): T {
  if (!source || source.signal.aborted) {
    return runWithCompletionBaseline(run);
  }
  try {
    source.assertCurrent();
  } catch (error) {
    if (isGatewayOperatorAccessUnavailable(error)) {
      throw error;
    }
    return runWithCompletionBaseline(run);
  }
  return source.run(run);
}

/** Release source tokens include invocation identity; absent identities cannot prove sharing. */
export function completionSourcesShareAuthority(
  sources: readonly (CompletionAuthority | undefined)[],
): boolean {
  const first = sources[0];
  const original = first?.operatorAuthority;
  return Boolean(
    first &&
    original &&
    sources.every(
      (source) =>
        source !== undefined &&
        !source.signal.aborted &&
        source.operatorAuthority?.source === original.source &&
        isDeepStrictEqual(source.operatorAuthority?.scopes, original.scopes) &&
        isDeepStrictEqual(source.scopes, first.scopes),
    ),
  );
}
