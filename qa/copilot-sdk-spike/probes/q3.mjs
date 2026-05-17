import path from 'node:path';

/** Run the user-input handler timeout probe. */
async function runQ3(ctx) {
  const tempDir = await ctx.createTempDir('session');
  const copilotHome = path.join(tempDir, 'copilot-home');
  const timeline = [];
  const startedAt = Date.now();
  const client = await ctx.createClient({
    copilotHome,
    useLoggedInUser: true,
  });

  try {
    const session = await client.createSession({
      model: ctx.defaultModel,
      onPermissionRequest: () => ctx.permissionApproved(),
      onUserInputRequest: (request) => {
        timeline.push({
          atMs: Date.now() - startedAt,
          event: 'user-input-handler-called',
          request: ctx.sanitize(request),
        });
        return new Promise(() => {});
      },
    });

    try {
      session.on((event) => {
        timeline.push({
          atMs: Date.now() - startedAt,
          event: event.type,
        });
      });

      let outcome;
      try {
        const assistant = await ctx.withWatchdog('q3 outer watchdog', 90000, () =>
          session.sendAndWait(
            {
              prompt: 'Use the ask_user tool to ask exactly: What is 2 + 2?',
            },
            85000,
          ),
        );
        outcome = {
          kind: 'resolved',
          assistant,
        };
      } catch (error) {
        outcome = {
          kind: error.message.includes('timed out after 90000ms') ? 'watchdog-timeout' : 'rejected',
          error: ctx.stringifyError(error),
        };
      }

      return {
        status: 'ok',
        evidence: {
          timeline,
          outcome,
        },
        observed: outcome.kind,
        conclusion:
          outcome.kind === 'watchdog-timeout'
            ? 'The probe watchdog expired before the SDK resolved the blocked user-input request.'
            : 'The SDK resolved or rejected the blocked user-input flow before the outer watchdog expired.',
      };
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
}

export default {
  id: 'q3',
  slug: 'user-input-handler-timeout',
  description: 'Observe SDK behavior when onUserInputRequest never resolves.',
  requiresLive: true,
  maxEstimatedTokens: 1000,
  run: runQ3,
};
