import path from 'node:path';

/** Run the permission handler timeout probe. */
async function runQ2(ctx) {
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
      onPermissionRequest: (request) => {
        timeline.push({
          atMs: Date.now() - startedAt,
          event: 'permission-handler-called',
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
        const assistant = await ctx.withWatchdog('q2 outer watchdog', 90000, () =>
          session.sendAndWait(
            {
              prompt: 'Use the shell tool to print the current working directory.',
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
        status: outcome.kind === 'watchdog-timeout' ? 'ok' : 'ok',
        evidence: {
          timeline,
          outcome,
        },
        observed: outcome.kind,
        conclusion:
          outcome.kind === 'watchdog-timeout'
            ? 'The probe watchdog expired before the SDK resolved the blocked permission request.'
            : 'The SDK resolved or rejected the blocked permission flow before the outer watchdog expired.',
      };
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
}

export default {
  id: 'q2',
  slug: 'permission-handler-timeout',
  description: 'Observe SDK behavior when onPermissionRequest never resolves.',
  requiresLive: true,
  maxEstimatedTokens: 1000,
  run: runQ2,
};
