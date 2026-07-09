// Control Ui Mock Dev script supports OpenClaw repository automation.
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import {
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../ui/vite.config.ts";

type CliOptions = {
  allowedHosts: string[];
  host: string;
  port: number;
};

type SessionListOptions = {
  hasMore: boolean;
  nextOffset: number | null;
  offset?: number;
  totalCount: number;
};

type CuratedMockSession = {
  key: string;
  label: string;
  messages: unknown[];
  updatedAt: number;
  model?: string;
  modelProvider?: string;
};

const SESSION_PAGE_SIZE = 50;
const TOTAL_MOCK_SESSIONS = 650;
const TOTAL_TELEGRAM_SESSIONS = 180;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(repoRoot, "ui");

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { allowedHosts: [], host: "127.0.0.1", port: 5187 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--allowed-host") {
      const allowedHost = args[++i]?.trim();
      if (allowedHost) {
        options.allowedHosts.push(allowedHost);
      }
    } else if (arg.startsWith("--allowed-host=")) {
      const allowedHost = arg.slice("--allowed-host=".length).trim();
      if (allowedHost) {
        options.allowedHosts.push(allowedHost);
      }
    } else if (arg === "--host") {
      options.host = args[++i] ?? options.host;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length) || options.host;
    } else if (arg === "--port") {
      options.port = parsePort(args[++i], options.port);
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length), options.port);
    }
  }
  return options;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function sessionRow(
  key: string,
  label: string,
  updatedAt: number,
  options: { model?: string; modelProvider?: string } = {},
) {
  return {
    contextTokens: 200_000,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: options.model ?? "gpt-5.5",
    modelProvider: options.modelProvider ?? "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
  };
}

function sessionsListResponse(sessions: unknown[], options: SessionListOptions) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: 200_000,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    hasMore: options.hasMore,
    limitApplied: 50,
    nextOffset: options.nextOffset,
    offset: options.offset ?? 0,
    path: "",
    sessions,
    totalCount: options.totalCount,
    ts: Date.now(),
  };
}

function pagedSessionsListResponse(sessions: unknown[], offset: number) {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const page = sessions.slice(normalizedOffset, normalizedOffset + SESSION_PAGE_SIZE);
  const nextOffset = normalizedOffset + SESSION_PAGE_SIZE;
  return sessionsListResponse(page, {
    hasMore: nextOffset < sessions.length,
    nextOffset: nextOffset < sessions.length ? nextOffset : null,
    offset: normalizedOffset,
    totalCount: sessions.length,
  });
}

function buildSessionRows(params: {
  baseTime: number;
  count: number;
  keyPrefix: string;
  labelPrefix: string;
  model?: string;
  modelProvider?: string;
}) {
  return Array.from({ length: params.count }, (_value, index) => {
    const ordinal = index + 1;
    const padded = String(ordinal).padStart(3, "0");
    return sessionRow(
      `agent:${params.keyPrefix}-${padded}`,
      `${params.labelPrefix} ${padded}`,
      params.baseTime - ordinal * 60_000,
      { model: params.model, modelProvider: params.modelProvider },
    );
  });
}

function buildSessionListCases(
  sessions: unknown[],
  matchBase: Record<string, unknown> = {},
): Array<{ match: Record<string, unknown>; response: unknown }> {
  const cases: Array<{ match: Record<string, unknown>; response: unknown }> = [];
  for (let offset = SESSION_PAGE_SIZE; offset < sessions.length; offset += SESSION_PAGE_SIZE) {
    cases.push({
      match: { ...matchBase, offset },
      response: pagedSessionsListResponse(sessions, offset),
    });
  }
  cases.push({
    match: matchBase,
    response: pagedSessionsListResponse(sessions, 0),
  });
  return cases;
}

function buildSearchSessionListCases(
  sessions: unknown[],
  searchTerms: string[],
): Array<{ match: Record<string, unknown>; response: unknown }> {
  return searchTerms.flatMap((search) => buildSessionListCases(sessions, { search }));
}

function chatHistoryMessage(role: "assistant" | "user", text: string, timestamp: number) {
  return {
    content: [{ text, type: "text" }],
    role,
    timestamp,
  };
}

function buildScrollableChatHistory(baseTime: number): unknown[] {
  const messages: unknown[] = [
    chatHistoryMessage(
      "assistant",
      `Mock Control UI is running with ${TOTAL_MOCK_SESSIONS} sessions. Open the chat picker, search for "telegram" or "claude", then use Load more repeatedly.`,
      baseTime,
    ),
  ];

  for (let index = 1; index <= 36; index += 1) {
    const timestamp = baseTime + index * 60_000;
    messages.push(
      chatHistoryMessage(
        "user",
        `Mock scroll request ${index}: add enough transcript content to exercise the chat scroll container in focused mode.`,
        timestamp,
      ),
      chatHistoryMessage(
        "assistant",
        `Mock scroll response ${index}: this deterministic history keeps the mock chat long enough to scroll while testing focus mode, header collapse, and composer anchoring. `.repeat(
          2,
        ),
        timestamp + 30_000,
      ),
    );
  }

  return messages;
}

function chatHistoryResponse(session: CuratedMockSession) {
  return {
    messages: session.messages,
    sessionId: `mock-${session.key.replaceAll(":", "-")}`,
    sessionInfo: sessionRow(session.key, session.label, session.updatedAt, {
      model: session.model,
      modelProvider: session.modelProvider,
    }),
    thinkingLevel: null,
  };
}

function chatStartupResponse(
  session: CuratedMockSession,
  agentsList: unknown,
  models: Array<{ id: string; name: string; provider: string }>,
) {
  return {
    ...chatHistoryResponse(session),
    agentsList,
    metadata: { models },
  };
}

function buildCodingSessionMessages(baseTime: number): unknown[] {
  return [
    chatHistoryMessage(
      "user",
      "Audit the chat composer paste path and give me the smallest patch that keeps large code blocks readable.",
      baseTime,
    ),
    chatHistoryMessage(
      "assistant",
      "I will check the paste handler, composer state, and markdown rendering path first. The goal is to keep the patch local to the composer unless the renderer is the actual boundary.",
      baseTime + 30_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Read files:\n\n| Path | Reason |\n| --- | --- |\n| `ui/src/pages/chat/components/chat-composer.ts` | paste handling and textarea state |\n| `ui/src/pages/chat/chat-send.ts` | send payload shape |\n| `ui/src/pages/chat/components/chat-message.ts` | rendered markdown output |\n\nNo production gateway contract changes found.",
      baseTime + 60_000,
    ),
    chatHistoryMessage("user", "Show the patch shape before editing.", baseTime + 90_000),
    chatHistoryMessage(
      "assistant",
      'Patch shape:\n\n```ts\nfunction normalizePastedText(text: string): string {\n  const trimmed = text.replace(/\\r\\n/g, "\\n");\n  return shouldWrapAsCodeBlock(trimmed) ? `\\n\\n```\\n${trimmed}\\n```\\n` : trimmed;\n}\n```\n\nWarning: this needs a language-preserving path for fenced snippets that are already valid markdown.',
      baseTime + 120_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Implementation note: the existing markdown parser already handles fenced blocks correctly, so the composer only needs to avoid flattening indentation. I am leaving renderer styles alone for this PR.",
      baseTime + 150_000,
    ),
    chatHistoryMessage(
      "user",
      "Add the test that would fail before the patch.",
      baseTime + 180_000,
    ),
    chatHistoryMessage(
      "assistant",
      'Focused test:\n\n```ts\nit("preserves indentation when pasting a multi-line code block", async () => {\n  pasteComposerText("function demo() {\\n  return true;\\n}");\n  expect(readComposerValue()).toContain("  return true;");\n});\n```\n\nThis covers the regression without asserting internal helper names.',
      baseTime + 210_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Validation result:\n\n| Check | Result |\n| --- | --- |\n| focused composer test | passing |\n| `git diff --check` | clean |\n| route reload | fixture state preserved |\n\nRemaining risk: none for production runtime because this is contained to mock/dev fixture coverage.",
      baseTime + 240_000,
    ),
    chatHistoryMessage(
      "user",
      "Keep the PR body honest that this is design QA support.",
      baseTime + 270_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Done. The body will describe it as dev/mock-only fixture coverage for future Control UI review, not as a shipped chat behavior change.",
      baseTime + 300_000,
    ),
  ];
}

function buildResponseShapeSessionMessages(baseTime: number): unknown[] {
  return [
    chatHistoryMessage(
      "user",
      "Create a response-shape showcase that exercises summaries, JSON, warnings, and a small error state.",
      baseTime,
    ),
    chatHistoryMessage(
      "assistant",
      "Here is a compact response-shape pass with several common reviewer states in one transcript.",
      baseTime + 30_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Status summary:\n\n| Area | State | Notes |\n| --- | --- | --- |\n| Gateway | ok | mock socket connected |\n| Sessions | warning | list is paginated |\n| Artifacts | ok | one image artifact available |\n| Tools | error | simulated command failed |\n\nWarning: this is fixture data, so it should not imply production health.",
      baseTime + 60_000,
    ),
    chatHistoryMessage(
      "assistant",
      'Structured payload preview:\n\n```json\n{\n  "status": "warning",\n  "sessionKey": "agent:openclaw-mock:response-shape-showcase",\n  "counts": {\n    "messages": 9,\n    "warnings": 1,\n    "errors": 1\n  }\n}\n```',
      baseTime + 90_000,
    ),
    chatHistoryMessage(
      "user",
      "Add something that looks like a recoverable tool failure.",
      baseTime + 120_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Tool result:\n\n```text\n$ pnpm ui:design-smoke --fixture response-shape\nError: fixture viewport is unavailable\nRecovery: restart the mock server and reload /chat?session=agent:openclaw-mock:response-shape-showcase\n```\n\nThe failure is intentionally recoverable and local to the mock.",
      baseTime + 150_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Decision matrix:\n\n| Option | Trade-off | Recommendation |\n| --- | --- | --- |\n| Add runtime persistence | Higher realism, more code | Skip |\n| Add static curated sessions | Stable reloads, low risk | Use |\n| Change UI styles | Better screenshot polish, scope creep | Skip |",
      baseTime + 180_000,
    ),
    chatHistoryMessage("user", "Does this cover the empty state too?", baseTime + 210_000),
    chatHistoryMessage(
      "assistant",
      "Yes. The dedicated New session fixture has a stable key and an empty message array so route reloads show the normal empty chat state.",
      baseTime + 240_000,
    ),
  ];
}

function buildMarkdownShowcaseMessages(baseTime: number): unknown[] {
  return [
    chatHistoryMessage("user", "Give me a markdown-heavy transcript for visual QA.", baseTime),
    chatHistoryMessage(
      "assistant",
      "# Markdown QA\n\nThis message intentionally exercises headings, lists, links, tables, code fences, quotes, and inline code without depending on production data.",
      baseTime + 30_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Checklist:\n\n- [x] Headings have sane spacing\n- [x] Inline `code` stays readable\n- [x] Tables fit without breaking the chat column\n- [ ] Long output still needs scroll review\n\n> Fixture copy should stay quiet and useful for daily design review.",
      baseTime + 60_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Table coverage:\n\n| Component | Dense content | Empty content | Error content |\n| --- | --- | --- | --- |\n| Composer | pasted block | placeholder | send failure |\n| Thread | long history | welcome state | warning callout |\n| Sidebar | file preview | no file | load failure |",
      baseTime + 90_000,
    ),
    chatHistoryMessage(
      "assistant",
      "TypeScript sample:\n\n```ts\ntype FixtureState = {\n  readonly key: string;\n  readonly messages: readonly unknown[];\n};\n\nexport function hasMessages(state: FixtureState): boolean {\n  return state.messages.length > 0;\n}\n```\n\nShell sample:\n\n```sh\npnpm dev:ui:mock -- --port 5187\n```",
      baseTime + 120_000,
    ),
    chatHistoryMessage(
      "user",
      "Add one long paragraph so wrapping can be checked in narrow layouts.",
      baseTime + 150_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Long wrapping sample: this mock transcript includes a deliberately extended sentence that should wrap naturally inside the chat column, preserve comfortable line height, avoid horizontal overflow, and keep adjacent controls reachable when the viewport is narrow or the sidebar is open.",
      baseTime + 180_000,
    ),
    chatHistoryMessage(
      "assistant",
      "Small diff block:\n\n```diff\n+ Add curated mock sessions for visual QA.\n+ Keep fixture content stable across reloads.\n- Do not change production session APIs.\n```\n\nFinal note: all curated fixture chat content is English.",
      baseTime + 210_000,
    ),
  ];
}

function searchPrefixes(term: string): string[] {
  return Array.from({ length: term.length }, (_value, index) => term.slice(0, index + 1));
}

async function createChatPickerScenario(): Promise<ControlUiMockGatewayScenario> {
  const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
  const devicePairSetupCode = Buffer.from(
    JSON.stringify({
      url: "wss://gateway.example.test",
      bootstrapToken: "mock-bootstrap-token",
    }),
    "utf8",
  ).toString("base64url");
  const devicePairQrDataUrl = await qrcode.toDataURL(devicePairSetupCode, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 360,
  });
  const workspaceFiles = [
    {
      missing: false,
      name: "AGENTS.md",
      path: "/mock/workspace/AGENTS.md",
      size: 2148,
      updatedAtMs: baseTime - 120_000,
    },
    {
      missing: false,
      name: "plan.md",
      path: "/mock/workspace/plan.md",
      size: 912,
      updatedAtMs: baseTime - 90_000,
    },
    {
      missing: false,
      name: "notes/context.md",
      path: "/mock/workspace/notes/context.md",
      size: 1620,
      updatedAtMs: baseTime - 30_000,
    },
  ];
  const workspaceListCases = ["main", "alpha", "openclaw-mock"].map((agentId) => ({
    match: { agentId },
    response: {
      agentId,
      files: workspaceFiles,
      workspace: "/mock/workspace",
    },
  }));
  const workspaceFileContentByName = new Map([
    [
      "AGENTS.md",
      "# AGENTS.md\n\nMock workspace instructions for the composer rail.\n\n- Keep tool output compact.\n- Prefer right-rail context over modal previews.\n",
    ],
    [
      "plan.md",
      "# Composer polish plan\n\n1. Keep the composer controls calm.\n2. Move session selection into the sidebar.\n3. Keep model, reasoning, and speed choices discoverable without taking over the page.\n",
    ],
    [
      "notes/context.md",
      "# Context notes\n\nThe right rail should feel like workspace context, not a modal pasted beside the chat.\n\n## Current focus\n\n- Markdown previews need readable dark-mode chrome.\n- Empty or unavailable content should show a quiet state instead of an empty card.\n- File previews should load from the same mock scenario as the file list.\n",
    ],
  ]);
  const workspaceFileCases = ["main", "alpha", "openclaw-mock"].flatMap((agentId) =>
    workspaceFiles.map((file) => ({
      match: { agentId, name: file.name },
      response: {
        agentId,
        file: {
          ...file,
          content: workspaceFileContentByName.get(file.name) ?? "",
        },
        workspace: "/mock/workspace",
      },
    })),
  );
  const sessionFiles = [
    {
      kind: "modified",
      missing: false,
      name: "chat.ts",
      path: "ui/src/ui/views/chat.ts",
      size: 48320,
      updatedAtMs: baseTime - 20_000,
    },
    {
      kind: "modified",
      missing: false,
      name: "sidebar.css",
      path: "ui/src/styles/chat/sidebar.css",
      size: 18840,
      updatedAtMs: baseTime - 18_000,
    },
    {
      kind: "read",
      missing: false,
      name: "artifacts.ts",
      path: "src/gateway/server-methods/artifacts.ts",
      size: 21876,
      updatedAtMs: baseTime - 300_000,
    },
    {
      kind: "read",
      missing: false,
      name: "sessions.ts",
      path: "packages/gateway-protocol/src/schema/sessions.ts",
      size: 16542,
      updatedAtMs: baseTime - 420_000,
    },
  ];
  const sessionWorkspaceRoot = repoRoot;
  const sessionFileContentByPath = new Map([
    [
      "ui/src/ui/views/chat.ts",
      'function renderSessionWorkspaceRail() {\n  return html`<aside class="chat-workspace-rail">...</aside>`;\n}\n',
    ],
    [
      "ui/src/styles/chat/sidebar.css",
      ".chat-workspace-rail__section-title {\n  color: var(--muted);\n  text-transform: uppercase;\n}\n",
    ],
    [
      "src/gateway/server-methods/artifacts.ts",
      "// Artifact gateway methods collect generated artifacts from session transcripts.\n",
    ],
    [
      "packages/gateway-protocol/src/schema/sessions.ts",
      "export const SessionsFilesListParamsSchema = Type.Object({ sessionKey: NonEmptyString });\n",
    ],
    [
      "package.json",
      '{\n  "name": "openclaw",\n  "scripts": { "dev:ui:mock": "tsx scripts/control-ui-mock-dev.ts" }\n}\n',
    ],
    [
      "ui/vite.config.ts",
      "export default function controlUiViteConfig() {\n  return { server: { strictPort: true } };\n}\n",
    ],
    [
      "ui/src/e2e/chat-flow.e2e.test.ts",
      "it('keeps the session workspace useful while browsing files', async () => {\n  await page.getByText('Project files').waitFor();\n});\n",
    ],
  ]);
  const sessionFileCases = [
    {
      match: { sessionKey: "agent:alpha" },
      response: {
        browser: {
          entries: [
            {
              kind: "directory",
              name: "packages",
              path: "packages",
              sessionKind: "read",
              updatedAtMs: baseTime - 420_000,
            },
            {
              kind: "directory",
              name: "src",
              path: "src",
              sessionKind: "read",
              updatedAtMs: baseTime - 300_000,
            },
            {
              kind: "directory",
              name: "ui",
              path: "ui",
              sessionKind: "modified",
              updatedAtMs: baseTime - 20_000,
            },
            {
              kind: "file",
              name: "package.json",
              path: "package.json",
              size: 92750,
              updatedAtMs: baseTime - 800_000,
            },
          ],
          path: "",
        },
        files: sessionFiles,
        root: sessionWorkspaceRoot,
        sessionKey: "agent:alpha",
      },
    },
  ];
  const sessionFileGetCases = sessionFiles.map((file) => ({
    match: { sessionKey: "agent:alpha", path: file.path },
    response: {
      file: {
        ...file,
        content: sessionFileContentByPath.get(file.path) ?? "",
      },
      root: sessionWorkspaceRoot,
      sessionKey: "agent:alpha",
    },
  }));
  const lobsterSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#10151d"/>
  <circle cx="320" cy="185" r="76" fill="#e23f3f"/>
  <ellipse cx="250" cy="178" rx="54" ry="38" fill="#f05a52"/>
  <ellipse cx="390" cy="178" rx="54" ry="38" fill="#f05a52"/>
  <circle cx="292" cy="145" r="10" fill="#0b0f14"/>
  <circle cx="348" cy="145" r="10" fill="#0b0f14"/>
  <path d="M232 114c-72-44-135-22-146 35 52 9 91-4 125-39" fill="none" stroke="#f06b5f" stroke-width="28" stroke-linecap="round"/>
  <path d="M408 114c72-44 135-22 146 35-52 9-91-4-125-39" fill="none" stroke="#f06b5f" stroke-width="28" stroke-linecap="round"/>
  <path d="M232 246c-45 28-91 35-142 23M408 246c45 28 91 35 142 23" fill="none" stroke="#e14b47" stroke-width="16" stroke-linecap="round"/>
  <text x="320" y="326" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="24" fill="#f6f7f9">openclaw session artifact</text>
</svg>`;
  const lobsterArtifact = {
    id: "artifact-openclaw-lobster",
    type: "image",
    title: "openclaw-lobster-preview.svg",
    mimeType: "image/svg+xml",
    sizeBytes: Buffer.byteLength(lobsterSvg, "utf8"),
    source: "session-transcript",
    download: { mode: "bytes" },
  };
  const sessions = [
    sessionRow("agent:alpha", "Alpha planning", baseTime - 1_000),
    ...buildSessionRows({
      baseTime: baseTime - 60_000,
      count: TOTAL_MOCK_SESSIONS - 1,
      keyPrefix: "history",
      labelPrefix: "Long running session",
    }),
  ];
  const telegramSessions = buildSessionRows({
    baseTime: baseTime - 30_000,
    count: TOTAL_TELEGRAM_SESSIONS,
    keyPrefix: "telegram",
    labelPrefix: "Telegram investigation",
  });
  const claudeSessions = buildSessionRows({
    baseTime: baseTime - 45_000,
    count: 75,
    keyPrefix: "model-claude",
    labelPrefix: "Model search result",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
  });
  const curatedSessions: CuratedMockSession[] = [
    {
      key: "agent:openclaw-mock:new-session",
      label: "New session",
      messages: [],
      updatedAt: baseTime + 30_000,
    },
    {
      key: "agent:openclaw-mock:qa-coding-session",
      label: "Coding session QA",
      messages: buildCodingSessionMessages(baseTime + 60_000),
      updatedAt: baseTime + 20_000,
    },
    {
      key: "agent:openclaw-mock:response-shape-showcase",
      label: "Response shape showcase",
      messages: buildResponseShapeSessionMessages(baseTime + 120_000),
      updatedAt: baseTime + 10_000,
    },
    {
      key: "agent:openclaw-mock:markdown-showcase",
      label: "Markdown showcase",
      messages: buildMarkdownShowcaseMessages(baseTime + 180_000),
      updatedAt: baseTime,
    },
  ];
  const curatedSessionRows = curatedSessions.map((session) =>
    sessionRow(session.key, session.label, session.updatedAt, {
      model: session.model,
      modelProvider: session.modelProvider,
    }),
  );
  const allSessions = [...curatedSessionRows, ...sessions];
  const models = [
    { id: "gpt-5.5", name: "gpt-5.5", provider: "openai" },
    { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", provider: "anthropic" },
  ];
  const agentsList = {
    agents: [
      {
        id: "openclaw-mock",
        identity: { name: "OpenClaw mock" },
        name: "OpenClaw mock",
        workspaceGit: false,
      },
    ],
    defaultId: "openclaw-mock",
    mainKey: "main",
    scope: "agent",
  };
  const curatedChatHistoryCases = curatedSessions.map((session) => ({
    match: { sessionKey: session.key },
    response: chatHistoryResponse(session),
  }));
  const curatedChatStartupCases = curatedSessions.map((session) => ({
    match: { sessionKey: session.key },
    response: chatStartupResponse(session, agentsList, models),
  }));
  return {
    assistantAgentId: "openclaw-mock",
    assistantName: "OpenClaw mock",
    defaultAgentId: "openclaw-mock",
    historyMessages: buildScrollableChatHistory(baseTime),
    methodResponses: {
      "device.pair.list": { paired: [], pending: [] },
      "device.pair.setupCode": {
        auth: "token",
        gatewayUrl: "wss://gateway.example.test",
        qrDataUrl: devicePairQrDataUrl,
        setupCode: devicePairSetupCode,
        urlSource: "mock",
      },
      "node.list": { nodes: [] },
      "chat.history": {
        cases: curatedChatHistoryCases,
      },
      "chat.startup": {
        cases: curatedChatStartupCases,
      },
      "agents.files.get": {
        cases: workspaceFileCases,
      },
      "agents.files.list": {
        cases: workspaceListCases,
      },
      "sessions.files.get": {
        cases: sessionFileGetCases,
      },
      "sessions.files.list": {
        cases: [
          {
            match: { sessionKey: "agent:alpha", path: "ui" },
            response: {
              browser: {
                entries: [
                  {
                    kind: "directory",
                    name: "src",
                    path: "ui/src",
                    sessionKind: "modified",
                    updatedAtMs: baseTime - 20_000,
                  },
                  {
                    kind: "file",
                    name: "vite.config.ts",
                    path: "ui/vite.config.ts",
                    size: 9860,
                    updatedAtMs: baseTime - 900_000,
                  },
                ],
                parentPath: "",
                path: "ui",
              },
              files: sessionFiles,
              root: sessionWorkspaceRoot,
              sessionKey: "agent:alpha",
            },
          },
          {
            match: { sessionKey: "agent:alpha", search: "chat" },
            response: {
              browser: {
                entries: [
                  {
                    kind: "file",
                    name: "chat.ts",
                    path: "ui/src/ui/views/chat.ts",
                    sessionKind: "modified",
                    size: 48320,
                    updatedAtMs: baseTime - 20_000,
                  },
                  {
                    kind: "file",
                    name: "chat-flow.e2e.test.ts",
                    path: "ui/src/e2e/chat-flow.e2e.test.ts",
                    size: 24950,
                    updatedAtMs: baseTime - 25_000,
                  },
                ],
                path: "",
                search: "chat",
              },
              files: sessionFiles,
              root: sessionWorkspaceRoot,
              sessionKey: "agent:alpha",
            },
          },
          ...sessionFileCases,
        ],
      },
      "artifacts.list": {
        cases: [
          {
            match: { sessionKey: "agent:alpha" },
            response: { artifacts: [lobsterArtifact] },
          },
        ],
      },
      "artifacts.download": {
        cases: [
          {
            match: { sessionKey: "agent:alpha", artifactId: lobsterArtifact.id },
            response: {
              artifact: lobsterArtifact,
              data: Buffer.from(lobsterSvg, "utf8").toString("base64"),
              encoding: "base64",
            },
          },
        ],
      },
      "sessions.list": {
        cases: [
          ...buildSearchSessionListCases(telegramSessions, searchPrefixes("telegram")),
          ...buildSearchSessionListCases(claudeSessions, [
            ...searchPrefixes("claude"),
            ...searchPrefixes("claude-sonnet-4-6"),
            ...searchPrefixes("anthropic"),
          ]),
          ...buildSessionListCases(allSessions),
        ],
      },
      "sessions.create": {
        key: "agent:openclaw-mock:new-session",
        ok: true,
        runStarted: false,
        sessionId: "mock-agent-openclaw-mock-new-session",
      },
    },
    models,
    sessionKey: "agent:alpha",
  };
}

function escapeScriptContent(script: string): string {
  return script.replaceAll("</script", "<\\/script");
}

function createMockGatewayPlugin(scenario: ControlUiMockGatewayScenario): Plugin {
  const initScript = escapeScriptContent(createControlUiMockGatewayInitScript(scenario));
  const bootstrapBody = JSON.stringify(createControlUiMockBootstrapConfig(scenario));
  return {
    configureServer(server) {
      server.middlewares.use(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(bootstrapBody);
      });
    },
    name: "openclaw-control-ui-mock-gateway",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `    <script data-openclaw-control-ui-mock-gateway>\n${initScript}\n    </script>\n  </head>`,
      );
    },
  };
}

function hostForUrl(boundAddress: string, requestedHost: string): string {
  const host = boundAddress === "0.0.0.0" || boundAddress === "::" ? requestedHost : boundAddress;
  const reachableHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return reachableHost.includes(":") ? `[${reachableHost}]` : reachableHost;
}

function resolveServerUrl(server: ViteDevServer, requestedHost: string): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI mock server did not expose a TCP port");
  }
  return `http://${hostForUrl(address.address, requestedHost)}:${address.port}/chat`;
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const options = parseArgs(process.argv.slice(2));
const scenario = await createChatPickerScenario();
const server = await createServer({
  base: "/",
  cacheDir: path.join(repoRoot, ".artifacts", "control-ui-mock-vite"),
  clearScreen: false,
  configFile: path.join(uiRoot, "vite.config.ts"),
  define: {
    OPENCLAW_CONTROL_UI_BUILD_ID: JSON.stringify("mock"),
  },
  logLevel: "error",
  optimizeDeps: {
    include: ["lit/directives/repeat.js"],
  },
  plugins: [createMockGatewayPlugin(scenario)],
  publicDir: path.join(uiRoot, "public"),
  resolve: {
    alias: [
      ...resolveExternalPackageAliasesForVite(),
      ...resolveSourcePackageAliasesForVite(),
      ...resolveTsconfigPathAliasesForVite(),
    ],
  },
  root: uiRoot,
  server: {
    allowedHosts: options.allowedHosts,
    host: options.host,
    port: options.port,
    strictPort: true,
  },
});

await server.listen();
console.log(`[control-ui-mock] ${resolveServerUrl(server, options.host)}`);
await waitForShutdown();
await server.close();
