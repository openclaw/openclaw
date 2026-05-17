import path from 'node:path';

/** Run the copilotHome layout probe. */
async function runQ5(ctx) {
  const tempDir = await ctx.createTempDir('layout');
  const copilotHome = path.join(tempDir, 'copilot-home');
  const client = await ctx.createClient({
    copilotHome,
    useLoggedInUser: true,
  });

  try {
    const session = await client.createSession({
      model: ctx.defaultModel,
      onPermissionRequest: () => ctx.permissionApproved(),
    });

    try {
      const assistant = await session.sendAndWait(
        {
          prompt: 'Reply with exactly: layout-ok',
        },
        60000,
      );

      return {
        status: 'ok',
        evidence: {
          copilotHome,
          workspacePath: session.workspacePath,
          assistant,
          tree: await ctx.walkTree(copilotHome),
        },
        observed: session.workspacePath || 'workspacePath-unavailable',
        conclusion: 'The directory walk captures the post-turn copilotHome layout created by the SDK.',
      };
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
}

export default {
  id: 'q5',
  slug: 'copilot-home-layout',
  description: 'Walk the entire copilotHome tree after one live turn.',
  requiresLive: true,
  maxEstimatedTokens: 1000,
  run: runQ5,
};
