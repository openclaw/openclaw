import path from 'node:path';

/** Run the cold-resume pending-work probe. */
async function runQ9(ctx) {
  const tempDir = await ctx.createTempDir('pending-work');
  const copilotHome = path.join(tempDir, 'copilot-home');
  const { defineTool } = await ctx.loadSdk();
  const firstSessionEvents = [];
  const resumedSessionEvents = [];
  let releasePending;
  const pendingGate = new Promise((resolve) => {
    releasePending = resolve;
  });
  const pendingTool = defineTool('q9_pending_tool', {
    description: 'Stay pending until the probe resumes the session.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      await pendingGate;
      return {
        status: 'released-after-resume',
      };
    },
  });

  const client = await ctx.createClient({
    copilotHome,
    useLoggedInUser: true,
  });

  try {
    const session = await client.createSession({
      model: ctx.defaultModel,
      tools: [pendingTool],
      onPermissionRequest: () => ctx.permissionApproved(),
    });

    let sessionId = (await client.getLastSessionId()) || 'unknown-session';

    try {
      session.on((event) => {
        firstSessionEvents.push(ctx.sanitize(event));
      });

      const sendPromise = session.send({
        prompt: 'Call q9_pending_tool once and then wait for it to finish.',
      });
      await sendPromise;
      await ctx.withWatchdog('q9 wait for tool start', 30000, async () => {
        while (!firstSessionEvents.some((event) => event.type === 'tool.execution_start')) {
          await ctx.delay(250);
        }
      });

      sessionId = (await client.getLastSessionId()) || sessionId;
      await session.disconnect();

      const resumed = await client.resumeSession(sessionId, {
        continuePendingWork: true,
        onPermissionRequest: () => ctx.permissionApproved(),
      });

      try {
        resumed.on((event) => {
          resumedSessionEvents.push(ctx.sanitize(event));
        });
        releasePending();
        await ctx.delay(3000);
        const resumedMessages = await resumed.getMessages();

        return {
          status: 'ok',
          evidence: {
            sessionId,
            firstSessionEvents,
            resumedSessionEvents,
            resumedMessages,
          },
          observed: {
            firstSessionEventTypes: [...new Set(firstSessionEvents.map((event) => event.type))],
            resumedSessionEventTypes: [...new Set(resumedSessionEvents.map((event) => event.type))],
          },
          conclusion: 'The probe records what the SDK emits when a pending custom tool is resumed with continuePendingWork enabled.',
        };
      } finally {
        await resumed.disconnect();
      }
    } catch (error) {
      releasePending();
      await session.disconnect().catch(() => {});
      throw error;
    }
  } finally {
    await client.stop();
  }
}

export default {
  id: 'q9',
  slug: 'cold-resume-pending-work',
  description: 'Disconnect while a custom tool is pending, then resume with continuePendingWork enabled.',
  requiresLive: true,
  maxEstimatedTokens: 1000,
  run: runQ9,
};
