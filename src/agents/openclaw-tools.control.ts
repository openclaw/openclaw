import { bindCoreToolDeclaration, type CoreToolDeclaration } from "./agent-tool-metadata.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createComputerTool } from "./tools/computer-tool.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createMobileUiTool } from "./tools/mobile-ui-tool.js";
import { createAvailablePortalTools } from "./tools/portal-tool.js";
import { createScreenTool } from "./tools/screen-tool.js";
import { createSessionsCreateTool } from "./tools/sessions-create-tool.js";
import { createSessionsTool } from "./tools/sessions-tool.js";
import { createTerminalTool } from "./tools/terminal-tool.js";
import { createThemeTool } from "./tools/theme-tool.js";

/** Genuine hosted core producers; plugin and delegated replacements never enter here. */
export function createHostedControlTools(
  options: OpenClawToolsOptions | undefined,
  prepared: {
    nodesTool: AnyAgentTool;
    sessionAgentId: string;
    gatewayCallerAccountId?: string;
    deliveryContext: NonNullable<Parameters<typeof createCronTool>[0]>["currentDeliveryContext"];
    sessionConfig: OpenClawToolsOptions["config"];
  },
  onCoreDeclaration?: (declaration: CoreToolDeclaration) => void,
): Array<AnyAgentTool | null> {
  const { nodesTool, sessionAgentId, gatewayCallerAccountId, deliveryContext, sessionConfig } =
    prepared;
  const screenTool = bindCoreToolDeclaration(
    createScreenTool({
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      agentId: sessionAgentId,
    }),
  );
  // Client capabilities select this turn's executor, not the producer's declaration.
  onCoreDeclaration?.(screenTool);
  return [
    nodesTool,
    bindCoreToolDeclaration(createMobileUiTool({ idempotencyScope: options?.runId })),
    options?.modelHasVision === false || options?.computerTransport === null
      ? null
      : bindCoreToolDeclaration(
          createComputerTool({
            ...options,
            transport: options?.computerTransport,
            // The tool combines this run scope with the assistant turn and provider call id.
            idempotencyScope: options?.runId,
            contextEpoch: options?.computerContextEpoch,
          }),
        ),
    bindCoreToolDeclaration(
      createCronTool({
        ...options,
        // Use the durable runSessionKey; cleanup-retired policy keys leave cron jobs dangling.
        agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
        agentId: sessionAgentId,
        agentAccountId: gatewayCallerAccountId,
        currentDeliveryContext: deliveryContext,
        creatorToolAllowlist: options?.cronCreatorToolAllowlist,
        creatorToolAllowlistCaptureRef: options?.cronCreatorToolAllowlistCaptureRef,
        resolveCreatorToolAuthority: options?.resolveCronCreatorToolAuthority,
        creatorAuthorityUnavailableReason: options?.cronCreatorAuthorityUnavailableReason,
        selfRemoveOnlyJobId: options?.cronSelfRemoveOnlyJobId,
      }),
    ),
    createSessionsCreateTool({ sessionControlAuthority: options?.sessionControlAuthority }),
    createSessionsTool({
      ...options,
      stopAllowed: options?.swarmCollector !== true,
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      agentSessionId: options?.sessionId,
      requesterAgentIdOverride: sessionAgentId,
      config: sessionConfig,
    }),
    screenTool,
    createThemeTool(),
    ...(options?.sandboxed
      ? []
      : [
          bindCoreToolDeclaration(
            createTerminalTool({
              ...options,
              agentId: sessionAgentId,
              agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            }),
          ),
          ...createAvailablePortalTools(options, onCoreDeclaration),
        ]),
  ];
}
