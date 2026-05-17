import path from 'node:path';

/** Run the encrypted reasoning replay probe. */
async function runQ7(ctx) {
  const tempDir = await ctx.createTempDir('reasoning');
  const copilotHome = path.join(tempDir, 'copilot-home');
  const client = await ctx.createClient({
    copilotHome,
    useLoggedInUser: true,
  });

  try {
    const models = await client.listModels();
    const model = models.find(
      (entry) =>
        entry?.defaultReasoningEffort ||
        (Array.isArray(entry?.supportedReasoningEfforts) && entry.supportedReasoningEfforts.length > 0) ||
        entry?.capabilities?.supports?.reasoningEffort,
    );

    if (!model) {
      return {
        status: 'no-reasoning-capable-model',
        evidence: {
          models,
        },
        observed: 'No installed model advertised reasoning support.',
        conclusion: 'The SDK surface exposes no reasoning-capable model to probe in this environment.',
      };
    }

    const session = await client.createSession({
      model: model.id,
      reasoningEffort: model.defaultReasoningEffort || model.supportedReasoningEfforts?.[0] || 'low',
      onPermissionRequest: () => ctx.permissionApproved(),
    });

    const assistantMessages = [];
    const sessionId = (await client.getLastSessionId()) || 'unknown-session';

    try {
      session.on('assistant.message', (event) => {
        assistantMessages.push(ctx.sanitize(event));
      });

      await session.sendAndWait(
        {
          prompt: 'Think briefly if your model supports reasoning and then reply with exactly: reasoning-replay-ok',
        },
        60000,
      );

      const beforeResume = await session.getMessages();
      await session.disconnect();

      const resumed = await client.resumeSession(sessionId, {
        continuePendingWork: false,
        onPermissionRequest: () => ctx.permissionApproved(),
      });

      try {
        const afterResume = await resumed.getMessages();
        const beforeReasoning = beforeResume.filter(
          (event) => event.type === 'assistant.message' && (event.encryptedContent || event.reasoningOpaque),
        );
        const afterReasoning = afterResume.filter(
          (event) => event.type === 'assistant.message' && (event.encryptedContent || event.reasoningOpaque),
        );

        return {
          status: beforeReasoning.length === 0 && afterReasoning.length === 0 ? 'not-observed' : 'ok',
          evidence: {
            model,
            assistantMessages,
            beforeResumeReasoningMessages: beforeReasoning,
            afterResumeReasoningMessages: afterReasoning,
          },
          observed: {
            sessionId,
            beforeResumeCount: beforeReasoning.length,
            afterResumeCount: afterReasoning.length,
          },
          conclusion:
            beforeReasoning.length === 0 && afterReasoning.length === 0
              ? 'No encrypted reasoning fields were observed before or after resume.'
              : 'The probe captured reasoning field behavior before and after resume for diffing.',
        };
      } finally {
        await resumed.disconnect();
      }
    } catch (error) {
      await session.disconnect().catch(() => {});
      throw error;
    }
  } finally {
    await client.stop();
  }
}

export default {
  id: 'q7',
  slug: 'encrypted-reasoning-replay',
  description: 'Compare encrypted reasoning fields before disconnect and after resume.',
  requiresLive: true,
  maxEstimatedTokens: 200,
  run: runQ7,
};
