import path from 'node:path';

const EVENT_NAMES = [
  'session.start',
  'session.resume',
  'session.error',
  'session.idle',
  'session.usage_info',
  'session.compaction_start',
  'session.compaction_complete',
  'assistant.turn_start',
  'assistant.intent',
  'assistant.reasoning',
  'assistant.reasoning_delta',
  'assistant.streaming_delta',
  'assistant.message_start',
  'assistant.message_delta',
  'assistant.message',
  'assistant.turn_end',
  'assistant.usage',
  'model.call_failure',
  'abort',
  'tool.execution_start',
  'tool.execution_partial_result',
  'tool.execution_progress',
  'tool.execution_complete',
  'permission.requested',
  'permission.completed',
  'user_input.requested',
  'user_input.completed',
  'elicitation.requested',
  'elicitation.completed',
  'command.execute',
  'commands.changed',
  'capabilities.changed',
  'session.tools_updated',
  'session.skills_loaded',
  'session.mcp_servers_loaded',
  'session.extensions_loaded',
];

/** Run the event coverage probe. */
async function runQ8(ctx) {
  const tempDir = await ctx.createTempDir('events');
  const copilotHome = path.join(tempDir, 'copilot-home');
  const fired = new Map();
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
      for (const eventName of EVENT_NAMES) {
        session.on(eventName, (event) => {
          if (!fired.has(eventName)) {
            fired.set(eventName, []);
          }
          fired.get(eventName).push(ctx.sanitize(event));
        });
      }

      session.on((event) => {
        if (!fired.has(event.type)) {
          fired.set(event.type, []);
        }
        fired.get(event.type).push(ctx.sanitize(event));
      });

      const assistant = await session.sendAndWait(
        {
          prompt: 'Reply with exactly: event-coverage-ok',
        },
        60000,
      );

      return {
        status: 'ok',
        evidence: {
          assistant,
          firedEvents: Object.fromEntries(fired.entries()),
        },
        observed: [...fired.keys()].sort(),
        conclusion: 'The probe records which subscribed event names emitted payloads during a minimal turn.',
      };
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
}

export default {
  id: 'q8',
  slug: 'event-coverage',
  description: 'Subscribe to documented event names and record which ones fire in a minimal session.',
  requiresLive: true,
  maxEstimatedTokens: 1000,
  run: runQ8,
};
