import path from 'node:path';

const FAKE_CLIENT_TOKEN = 'ghp_fake_client_token_for_probe';
const FAKE_SESSION_TOKEN = 'ghp_fake_session_token_for_probe';
const FAKE_PROVIDER_KEY = 'sk-fake-provider-key';

/** Build one fake BYOK provider configuration. */
function buildProviderConfig() {
  return {
    type: 'openai',
    baseUrl: 'https://example.invalid/v1',
    apiKey: FAKE_PROVIDER_KEY,
    modelId: 'fake-openai-model',
    wireModel: 'fake-openai-model',
    maxInputTokens: 256,
    maxOutputTokens: 64,
  };
}

/** Render one matrix-cell label. */
function labelForCell(cell) {
  return [
    cell.clientGitHubToken ? 'client-token' : 'client-no-token',
    cell.useLoggedInUser ? 'logged-in-user' : 'no-logged-in-user',
    cell.sessionGitHubToken ? 'session-token' : 'session-no-token',
    cell.provider ? 'provider' : 'no-provider',
  ].join('__');
}

/** Run the provider and auth combination matrix probe. */
async function runQ6(ctx) {
  const typesText = await ctx.readInstalledText('dist/types.d.ts');
  const combinations = [];

  for (const clientGitHubToken of [false, true]) {
    for (const useLoggedInUser of [false, true]) {
      for (const sessionGitHubToken of [false, true]) {
        for (const provider of [false, true]) {
          combinations.push({
            clientGitHubToken,
            useLoggedInUser,
            sessionGitHubToken,
            provider,
          });
        }
      }
    }
  }

  const matrix = [];

  for (const cell of combinations) {
    const tempDir = await ctx.createTempDir(labelForCell(cell));
    const clientOptions = {
      copilotHome: path.join(tempDir, 'copilot-home'),
      useLoggedInUser: cell.useLoggedInUser,
    };
    if (cell.clientGitHubToken) {
      clientOptions.gitHubToken = FAKE_CLIENT_TOKEN;
    }

    const record = {
      cell,
      label: labelForCell(cell),
      constructor: 'not-attempted',
      createSession: 'not-attempted',
      firstSend: 'not-attempted',
    };

    let client;
    let session;

    try {
      client = await ctx.createClient(clientOptions);
      record.constructor = 'accepted';
    } catch (error) {
      record.constructor = {
        status: 'rejected',
        error: ctx.stringifyError(error),
      };
      matrix.push(record);
      continue;
    }

    try {
      const sessionConfig = {
        model: cell.provider ? 'fake-openai-model' : ctx.defaultModel,
        onPermissionRequest: () => ctx.permissionApproved(),
      };
      if (cell.sessionGitHubToken) {
        sessionConfig.gitHubToken = FAKE_SESSION_TOKEN;
      }
      if (cell.provider) {
        sessionConfig.provider = buildProviderConfig();
      }

      session = await ctx.withWatchdog('q6 createSession', 5000, () => client.createSession(sessionConfig));
      record.createSession = 'accepted';

      const shouldAvoidSend = cell.useLoggedInUser && !cell.clientGitHubToken && !cell.sessionGitHubToken && !cell.provider;
      if (shouldAvoidSend) {
        record.firstSend = {
          status: 'skipped-real-auth-risk',
          note: 'This cell could use a real logged-in user; the probe avoids an unintended live request.',
        };
      } else {
        try {
          const assistant = await ctx.withWatchdog('q6 first send', 4000, () =>
            session.sendAndWait(
              {
                prompt: 'Reply with exactly: auth-matrix-ok',
              },
              3000,
            ),
          );
          record.firstSend = {
            status: 'accepted',
            assistant,
          };
        } catch (error) {
          record.firstSend = {
            status: 'rejected',
            error: ctx.stringifyError(error),
          };
        }
      }
    } catch (error) {
      record.createSession = {
        status: 'rejected',
        error: ctx.stringifyError(error),
      };
    } finally {
      if (session) {
        await session.disconnect().catch(() => {});
      }
      if (client) {
        await client.stop().catch(() => {});
      }
    }

    matrix.push(record);
  }

  return {
    status: 'ok',
    evidence: {
      authSnippets: {
        clientOptions:
          ctx.findSnippet(typesText, 'export interface CopilotClientOptions') ||
          ctx.findSnippet(typesText, 'gitHubToken?: string'),
        sessionConfig:
          ctx.findSnippet(typesText, 'export interface SessionConfig') ||
          ctx.findSnippet(typesText, 'provider?: ProviderConfig'),
        providerConfig: ctx.findSnippet(typesText, 'export interface ProviderConfig'),
      },
      matrix,
    },
    observed: matrix.map((entry) => ({
      label: entry.label,
      constructor: entry.constructor,
      createSession: entry.createSession,
      firstSend: entry.firstSend,
    })),
    conclusion: 'The matrix captures which auth and provider combinations are accepted locally before or during session startup.',
  };
}

export default {
  id: 'q6',
  slug: 'provider-auth-matrix',
  description: 'Record which fake auth and BYOK configuration combinations are accepted or rejected.',
  requiresLive: false,
  maxEstimatedTokens: 0,
  run: runQ6,
};
