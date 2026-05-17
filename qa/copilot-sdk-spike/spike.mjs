import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CopilotClient, defineTool } from '@github/copilot-sdk';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = process.env.OPENCLAW_SPIKE_MODEL || 'gpt-4.1';

/** Run the standalone one-turn smoke script. */
async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');

  if (dryRun) {
    console.log('Dry run OK: imported @github/copilot-sdk and skipped live session startup.');
    return;
  }

  if (process.env.OPENCLAW_LIVE_TEST !== '1') {
    console.log('Live smoke skipped. Set OPENCLAW_LIVE_TEST=1 to run a one-turn session.');
    return;
  }

  const copilotHome = path.join(PROJECT_ROOT, 'probe-output', '.spike-home');
  const tool = defineTool('spike_echo', {
    description: 'Echo a message for the Copilot SDK spike smoke test.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: async (args) => ({
      ok: true,
      echoed: args.text,
    }),
  });

  const client = new CopilotClient({
    copilotHome,
    useLoggedInUser: true,
  });

  try {
    const session = await client.createSession({
      model: DEFAULT_MODEL,
      tools: [tool],
      onPermissionRequest: () => ({ kind: 'approved' }),
    });

    try {
      const assistantMessage = await session.sendAndWait(
        {
          prompt:
            'Use the spike_echo tool exactly once with text "copilot-sdk spike ok", then reply with one short confirmation sentence.',
        },
        60000,
      );

      console.log(
        JSON.stringify(
          {
            model: DEFAULT_MODEL,
            sessionWorkspacePath: session.workspacePath,
            assistantMessage,
          },
          null,
          2,
        ),
      );
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
