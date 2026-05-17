import path from 'node:path';

/** Run the shared copilotHome concurrency probe. */
async function runQ4(ctx) {
  const tempDir = await ctx.createTempDir('shared-home');
  const copilotHome = path.join(tempDir, 'copilot-home');
  const clientA = await ctx.createClient({
    copilotHome,
    useLoggedInUser: true,
  });
  const clientB = await ctx.createClient({
    copilotHome,
    useLoggedInUser: true,
  });

  try {
    const sessionResults = await Promise.allSettled([
      clientA.createSession({
        model: ctx.defaultModel,
        onPermissionRequest: () => ctx.permissionApproved(),
      }),
      clientB.createSession({
        model: ctx.defaultModel,
        onPermissionRequest: () => ctx.permissionApproved(),
      }),
    ]);

    for (const result of sessionResults) {
      if (result.status === 'fulfilled') {
        await result.value.disconnect();
      }
    }

    return {
      status: 'ok',
      evidence: {
        sharedCopilotHome: copilotHome,
        sessionResults: sessionResults.map((result) =>
          result.status === 'fulfilled'
            ? {
                status: 'fulfilled',
                workspacePath: result.value.workspacePath,
              }
            : {
                status: 'rejected',
                reason: ctx.stringifyError(result.reason),
              },
        ),
        copilotHomeTree: await ctx.walkTree(copilotHome),
      },
      observed: sessionResults.map((result) => result.status),
      conclusion: 'The probe records whether two clients can concurrently create sessions against one copilotHome.',
    };
  } finally {
    await clientA.stop();
    await clientB.stop();
  }
}

export default {
  id: 'q4',
  slug: 'copilot-home-concurrency',
  description: 'Create two sessions concurrently against one fresh copilotHome.',
  requiresLive: true,
  maxEstimatedTokens: 1000,
  run: runQ4,
};
