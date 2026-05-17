import path from 'node:path';

/** Run the permission handler runtime-shape probe. */
async function runQ1(ctx) {
  const tempDir = await ctx.createTempDir('session');
  const copilotHome = path.join(tempDir, 'copilot-home');
  const runtimeRequests = [];
  const eventRequests = [];
  const { defineTool } = await ctx.loadSdk();
  const customTool = defineTool('q1_custom_tool', {
    description: 'Return a marker value so the probe can trigger a custom-tool permission request.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    handler: async (args) => ({
      echoed: args.message,
    }),
  });

  const client = await ctx.createClient({
    copilotHome,
    useLoggedInUser: true,
  });

  try {
    const session = await client.createSession({
      model: ctx.defaultModel,
      tools: [customTool],
      onPermissionRequest: (request, invocation) => {
        runtimeRequests.push(ctx.sanitize({ request, invocation }));
        return ctx.permissionApproved();
      },
    });

    try {
      session.on('permission.requested', (event) => {
        eventRequests.push(ctx.sanitize(event));
      });

      const assistant = await ctx.withWatchdog('q1 sendAndWait', 60000, () =>
        session.sendAndWait(
          {
            prompt:
              'Use the built-in shell tool to print the working directory, then call q1_custom_tool with message "permission-shape". Finish with one short sentence.',
          },
          60000,
        ),
      );
      const typesText = await ctx.readInstalledText('dist/types.d.ts');

      return {
        status: 'ok',
        evidence: {
          declaredTypeSnippet:
            ctx.findSnippet(typesText, 'export interface PermissionRequest') ||
            ctx.findSnippet(typesText, 'PermissionRequestResult'),
          runtimeRequests,
          permissionRequestedEvents: eventRequests,
        },
        observed: {
          assistant,
          seenKinds: [...new Set(runtimeRequests.map((entry) => entry.request?.kind).filter(Boolean))],
        },
        conclusion:
          runtimeRequests.length > 0
            ? 'Runtime permission handler payloads were captured for side-by-side comparison with the installed type declaration.'
            : 'No permission handler callback fired; the live runtime did not exercise the expected tool path.',
      };
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
}

export default {
  id: 'q1',
  slug: 'permission-handler-runtime-shape',
  description: 'Capture onPermissionRequest runtime payloads and compare them with the installed declaration.',
  requiresLive: true,
  maxEstimatedTokens: 1000,
  run: runQ1,
};
